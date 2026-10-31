import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import qrcode from 'qrcode-terminal';
import { Game, GameError } from './game.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HEARTBEAT_MS = 10_000;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, which look like 1 and 0
const ROOM_CODE_LENGTH = 4;
const MAX_ROOMS = 200;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC_FILES: Record<string, [file: string, contentType: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

interface Room {
  code: string;
  game: Game;
  /** When the last client disconnected, or null while anyone is connected. */
  emptySince: number | null;
}

interface Client {
  ws: WebSocket;
  /** Set by the client's hello; may not belong to a joined player yet. */
  playerId: string | null;
  room: Room | null;
  alive: boolean;
}

const rooms = new Map<string, Room>();
const clients = new Set<Client>();

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/version') {
    // Render sets RENDER_GIT_COMMIT, which makes it easy to check which commit is live.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(process.env.RENDER_GIT_COMMIT ?? 'local');
    return;
  }
  const entry = STATIC_FILES[path];
  if (!entry) {
    res.writeHead(404).end('Not found');
    return;
  }
  const [file, contentType] = entry;
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(await readFile(PUBLIC_DIR + file));
});

const wss = new WebSocketServer({ server });

function createRoom(): Room {
  if (rooms.size >= MAX_ROOMS) throw new GameError('Too many games are running. Try again later.');
  let code: string;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  const room: Room = { code, game: new Game(), emptySince: null };
  rooms.set(code, room);
  return room;
}

function send(client: Client, message: object): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
}

function sendState(client: Client, extra: object = {}): void {
  const { room } = client;
  send(client, { type: 'state', room: room?.code ?? null, state: room?.game.viewFor(client.playerId) ?? null, ...extra });
}

function broadcast(room: Room): void {
  for (const client of clients) if (client.room === room) sendState(client);
}

function refreshConnected(room: Room | null, playerId: string | null): void {
  if (!room || !playerId) return;
  const online = [...clients].some(
    (c) => c.room === room && c.playerId === playerId && c.ws.readyState === WebSocket.OPEN,
  );
  room.game.setConnected(playerId, online);
}

/** Points a client at a room (or none), keeping both rooms' online markers accurate. */
function moveClient(client: Client, room: Room | null): void {
  const previous = client.room;
  client.room = room;
  if (previous && previous !== room) {
    refreshConnected(previous, client.playerId);
    broadcast(previous);
  }
}

function handle(client: Client, message: Record<string, unknown>): void {
  if (message.type === 'hello') {
    if (typeof message.playerId !== 'string' || !message.playerId) throw new GameError('Missing player id');
    client.playerId = message.playerId.slice(0, 64);
    const code = typeof message.room === 'string' ? message.room.trim().toUpperCase() : '';
    const room = rooms.get(code) ?? null;
    moveClient(client, room);
    if (room) {
      refreshConnected(room, client.playerId);
      broadcast(room);
    } else {
      sendState(client, code ? { missingRoom: code } : {});
    }
    return;
  }

  const id = client.playerId;
  if (!id) throw new GameError('Not connected yet');

  if (message.type === 'create') {
    const room = createRoom();
    try {
      room.game.join(id, String(message.name ?? ''));
    } catch (err) {
      rooms.delete(room.code);
      throw err;
    }
    moveClient(client, room);
    broadcast(room);
    return;
  }

  const room = client.room;
  if (!room) throw new GameError('Join a game first');
  const { game } = room;

  switch (message.type) {
    case 'join':
      game.join(id, String(message.name ?? ''));
      refreshConnected(room, id);
      break;
    case 'settings':
      game.updateSettings(id, { rounds: message.rounds, diceMode: message.diceMode });
      break;
    case 'move':
      game.movePlayer(id, String(message.playerId), message.offset);
      break;
    case 'start':
      game.start(id);
      break;
    case 'roll':
      game.roll(id, { sum: message.sum, doubles: message.doubles }, message.rollNumber);
      break;
    case 'bank':
      // Banks are secret: unless it ended the round, only the banker hears about it.
      if (!game.bank(id)) {
        for (const c of clients) if (c.room === room && c.playerId === id) sendState(c);
        return;
      }
      break;
    case 'skip':
      game.skipTurn(id);
      break;
    case 'remove':
      game.removePlayer(id, String(message.playerId));
      break;
    case 'leave':
      if (game.player(id)) game.leave(id);
      for (const c of clients) {
        if (c.room === room && c.playerId === id) {
          c.room = null;
          sendState(c);
        }
      }
      break;
    case 'nextRound':
      game.nextRound(id);
      break;
    case 'playAgain':
      game.playAgain(id);
      break;
    default:
      throw new GameError('Unknown action');
  }
  broadcast(room);
}

wss.on('connection', (ws) => {
  const client: Client = { ws, playerId: null, room: null, alive: true };
  clients.add(client);

  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (data) => {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    try {
      handle(client, message as Record<string, unknown>);
    } catch (err) {
      if (err instanceof GameError) {
        send(client, { type: 'error', message: err.message });
      } else {
        console.error(err);
        send(client, { type: 'error', message: 'Something went wrong' });
      }
    }
  });

  ws.on('close', () => {
    clients.delete(client);
    if (client.room) {
      refreshConnected(client.room, client.playerId);
      broadcast(client.room);
    }
  });
});

// Phones that lock often drop off without closing the socket; ping to notice.
setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, HEARTBEAT_MS);

// Forget rooms nobody has been connected to for a while.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const occupied = [...clients].some((c) => c.room === room);
    if (occupied) room.emptySince = null;
    else if (room.emptySince === null) room.emptySince = now;
    else if (now - room.emptySince > ROOM_IDLE_MS) rooms.delete(room.code);
  }
}, 60_000);

function lanAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  // Home Wi-Fi is almost always 192.168.x.x; list it ahead of VPN/Docker interfaces.
  return addresses.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

server.listen(PORT, () => {
  // Hosting platforms set these; the Wi-Fi banner only makes sense on a home machine.
  if (process.env.RENDER || process.env.FLY_APP_NAME) {
    console.log(`Banked listening on port ${PORT}`);
    return;
  }
  const [primary, ...others] = lanAddresses().map((ip) => `http://${ip}:${PORT}`);
  console.log('\n🎲  Banked is running!\n');
  if (!primary) {
    console.log(`  No Wi-Fi address found. Open http://localhost:${PORT} on this machine.\n`);
    return;
  }
  console.log(`  On your phones (same Wi-Fi), open:  ${primary}\n`);
  qrcode.generate(primary, { small: true });
  if (others.length) console.log(`  Not working? Try: ${others.join('  ')}`);
  console.log('\n  Press Ctrl+C to stop.\n');
});
