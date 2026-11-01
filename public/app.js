'use strict';

const PLAYER_ID_KEY = 'banked.playerId';
const NAME_KEY = 'banked.name';
const CONFIRM_MS = 3000;
// Pip positions on a 3x3 grid, numbered left-to-right, top-to-bottom.
const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const playerId = loadPlayerId();

let ws = null;
let online = false;
let reconnectTimer = null;
let reconnectDelay = 500;
let state = null;
let heardFromServer = false;
let buildId = null;
let roomCode = location.hash.slice(1).toUpperCase() || null;
let cooldownUntil = 0;
let lastRollKey = '';
let animateDice = false;
let confirming = null; // { key, until } for two-tap actions
let toastTimer = null;
const openDetails = new Set();

function loadPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    // crypto.randomUUID needs HTTPS; getRandomValues also works over plain http on the LAN.
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------- connection

function connect() {
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws = socket;
  socket.onopen = () => {
    online = true;
    reconnectDelay = 500;
    send({ type: 'hello', playerId, room: roomCode });
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'build') onBuild(message.id);
    else if (message.type === 'state') onState(message);
    else if (message.type === 'error') onError(message.message);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    online = false;
    render();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
}

// Phones freeze background tabs and their sockets can go stale; reconnect fresh on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const old = ws;
  ws = null;
  old?.close();
  connect();
});

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  else showToast('Reconnecting… try again in a sec');
}

function onState({ room, state: next, missingRoom }) {
  if (missingRoom) showToast(`No game with code ${missingRoom}`);
  roomCode = room;
  history.replaceState(null, '', room ? `#${room}` : location.pathname);

  heardFromServer = true;
  const prev = state;
  state = next;
  if (!next) return render();

  cooldownUntil = Date.now() + next.cooldownMs;
  if (next.cooldownMs > 0) setTimeout(render, next.cooldownMs + 50);

  const rollKey = `${next.round}:${next.rolls.length}`;
  if (rollKey !== lastRollKey) {
    animateDice = lastRollKey !== '' && next.rolls.length > 0;
    lastRollKey = rollKey;
  }

  const myTurn = next.youId !== null && next.currentPlayerId === next.youId;
  if (myTurn && prev?.currentPlayerId !== next.youId) navigator.vibrate?.(200);

  render();
}

/**
 * An open page keeps running its old code when it reconnects to a newly deployed server,
 * so reload to pick up the matching client. The room and player id survive the reload.
 */
function onBuild(id) {
  if (buildId !== null && buildId !== id) location.reload();
  buildId = id;
}

function onError(message) {
  showToast(message);
  const rounds = document.getElementById('rounds');
  if (rounds && state) rounds.value = state.rounds;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
}

// ---------------------------------------------------------------- actions

function enteredName() {
  const name = document.getElementById('name').value.trim();
  if (!name) showToast('Enter your name');
  else localStorage.setItem(NAME_KEY, name);
  return name;
}

const actions = {
  create() {
    const name = enteredName();
    if (name) send({ type: 'create', name });
  },
  findRoom() {
    const code = document.getElementById('code').value.trim().toUpperCase();
    if (!code) return showToast('Enter the room code');
    send({ type: 'hello', playerId, room: code });
  },
  join() {
    const name = enteredName();
    if (name) send({ type: 'join', name });
  },
  share() {
    navigator.share?.({ title: 'Banked', text: `Join my Banked game: ${roomCode}`, url: shareUrl() }).catch(() => {});
  },
  diceMode(mode) {
    send({ type: 'settings', diceMode: mode });
  },
  start() {
    send({ type: 'start' });
  },
  hostPlays(value) {
    send({ type: 'hostPlays', plays: value === 'yes' });
  },
  move(value) {
    const [offset, id] = value.split(/:(.*)/);
    send({ type: 'move', playerId: id, offset: Number(offset) });
  },
  roll() {
    send({ type: 'roll', rollNumber: state.rolls.length + 1 });
  },
  enterTotal(value) {
    send({ type: 'roll', sum: Number(value), rollNumber: state.rolls.length + 1 });
  },
  enterDoubles() {
    send({ type: 'roll', doubles: true, rollNumber: state.rolls.length + 1 });
  },
  bank() {
    withConfirm('bank', () => send({ type: 'bank' }));
  },
  skip() {
    send({ type: 'skip' });
  },
  remove(id) {
    withConfirm(`remove:${id}`, () => send({ type: 'remove', playerId: id }));
  },
  leave() {
    withConfirm('leave', () => send({ type: 'leave' }));
  },
  back() {
    send({ type: 'leave' });
  },
  nextRound() {
    send({ type: 'nextRound' });
  },
  playAgain() {
    send({ type: 'playAgain' });
  },
};

/** Final actions need a second tap within a few seconds. */
function withConfirm(key, action) {
  if (isConfirming(key)) {
    confirming = null;
    action();
  } else {
    confirming = { key, until: Date.now() + CONFIRM_MS };
    setTimeout(render, CONFIRM_MS + 50);
  }
  render();
}

function isConfirming(key) {
  return confirming?.key === key && Date.now() < confirming.until;
}

app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  actions[button.dataset.action]?.(button.dataset.value);
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  actions[event.target.dataset.submit]?.();
});

app.addEventListener('change', (event) => {
  if (event.target.id === 'rounds') send({ type: 'settings', rounds: Number(event.target.value) });
});

// `toggle` doesn't bubble, so listen in the capture phase.
app.addEventListener(
  'toggle',
  (event) => {
    if (!event.target.id) return;
    if (event.target.open) openDetails.add(event.target.id);
    else openDetails.delete(event.target.id);
  },
  true,
);

// ---------------------------------------------------------------- rendering

/**
 * Replaces only the top-level sections that changed, so a half-typed name or an
 * in-progress tap survives other players' updates.
 */
function render() {
  const template = document.createElement('template');
  template.innerHTML = view();
  const next = [...template.content.children];
  const current = [...app.children];
  next.forEach((node, i) => {
    if (!current[i]) app.appendChild(node);
    else if (!current[i].isEqualNode(node)) current[i].replaceWith(node);
  });
  for (const stale of current.slice(next.length)) stale.remove();
  animateDice = false;
}

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isHost = () => state.youAreHost;
const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? 'someone';
const openAttr = (id) => (openDetails.has(id) ? 'open' : '');
const waitingFor = (what) => `<p class="muted center">Waiting for ${esc(state.hostName)} to ${what}…</p>`;

const savedName = () => esc(localStorage.getItem(NAME_KEY) ?? '');
const shareUrl = () => `${location.origin}${location.pathname}#${roomCode}`;

function view() {
  if (!heardFromServer) return '<p class="muted center">Connecting…</p>';
  const banner = online ? '' : '<div class="offline-bar">Reconnecting…</div>';
  if (!state) return banner + homeView();
  if (!state.youId && !state.youAreHost) return banner + (state.phase === 'lobby' ? joinView() : spectatorView());
  const views = { lobby: lobbyView, playing: playingView, reveal: revealView, gameover: gameOverView };
  return banner + views[state.phase]();
}

function nameInput() {
  return `<input id="name" placeholder="Your name" maxlength="20" autocomplete="off" autocapitalize="words" enterkeyhint="go" value="${savedName()}" />`;
}

function homeView() {
  return `
    <h1>BANKED</h1>
    <form class="panel stack" data-submit="create">
      <h2>New game</h2>
      ${nameInput()}
      <button class="primary big" type="submit">Start a new game</button>
    </form>
    <form class="panel stack" data-submit="findRoom">
      <h2>Join a friend's game</h2>
      <input id="code" placeholder="Room code" maxlength="4" autocomplete="off" autocapitalize="characters" enterkeyhint="go" class="code-input" />
      <button class="big" type="submit">Find game</button>
    </form>
    ${rulesPanel()}`;
}

function joinView() {
  return `
    <h1>BANKED</h1>
    <form class="panel stack" data-submit="join">
      <h2>Join game ${esc(roomCode)}</h2>
      ${nameInput()}
      <button class="primary big" type="submit">Join</button>
    </form>
    ${state.players.length ? `<section class="panel"><h2>Already here</h2>${playerList()}</section>` : ''}
    ${rulesPanel()}
    <button class="link" data-action="back">← Back</button>`;
}

function spectatorView() {
  return `
    <h1>BANKED</h1>
    <section class="panel stack center">
      <p>A game is in progress (round ${state.round} of ${state.rounds}).</p>
      <p class="muted">You can join when it's over. Keep this page open.</p>
    </section>
    <button class="link" data-action="back">← Back</button>
    <section class="panel"><h2>Scores</h2>${playerList({ scores: true })}</section>`;
}

function lobbyView() {
  const { minPlayers, maxPlayers, maxRounds } = state.limits;
  const enough = state.players.length >= minPlayers;
  const diceLabel = { virtual: '🎲 Virtual', manual: '✋ Real dice' };
  const settings = isHost()
    ? `
      <div class="row spread">
        <label for="rounds">Rounds</label>
        <input id="rounds" type="number" inputmode="numeric" min="1" max="${maxRounds}" value="${state.rounds}" />
      </div>
      <div class="segmented">
        ${Object.entries(diceLabel)
          .map(
            ([mode, label]) =>
              `<button class="${state.diceMode === mode ? 'selected' : ''}" data-action="diceMode" data-value="${mode}">${label}</button>`,
          )
          .join('')}
      </div>
      ${state.diceMode === 'manual' ? '<p class="muted">Everyone rolls real dice, and you enter each total.</p>' : ''}
      <div class="segmented">
        <button class="${state.hostPlays ? 'selected' : ''}" data-action="hostPlays" data-value="yes">🙋 I'm playing</button>
        <button class="${state.hostPlays ? '' : 'selected'}" data-action="hostPlays" data-value="no">📺 Just hosting</button>
      </div>
      ${state.hostPlays ? '' : '<p class="muted">This screen runs the game (start, skip, next round, entering real dice) but doesn\'t take turns or bank.</p>'}`
    : `<p>${state.rounds} rounds · ${diceLabel[state.diceMode]}</p>`;

  return `
    <h1>BANKED</h1>
    <section class="panel stack center">
      <h2>Room code</h2>
      <div class="room-code">${esc(roomCode)}</div>
      <p class="muted">Friends can tap <b>Join a friend's game</b> and enter this code, or open<br />${esc(shareUrl())}</p>
      ${navigator.share ? '<button data-action="share">Share invite link</button>' : ''}
    </section>
    <section class="panel">
      <h2>Turn order (${state.players.length}/${maxPlayers} players)</h2>
      ${state.hostPlays ? '' : `<p class="muted hint-above">📺 ${isHost() ? "You're" : `${esc(state.hostName)} is`} hosting and not playing.</p>`}
      ${playerList({ numbered: true })}
      ${isHost() && state.players.length > 1 ? '<p class="muted hint">Use ▲ ▼ to match where everyone is sitting.</p>' : ''}
    </section>
    <section class="panel stack"><h2>Settings</h2>${settings}</section>
    ${
      isHost()
        ? `<button class="primary big" data-action="start" ${enough ? '' : 'disabled'}>Start game</button>
           ${enough ? '' : `<p class="muted center">Need at least ${minPlayers} players.</p>`}`
        : waitingFor('start the game')
    }
    ${rulesPanel()}
    ${leaveButton()}`;
}

function playingView() {
  const { safeRolls } = state.limits;
  const nextRoll = state.rolls.length + 1;
  const lastRoll = state.rolls.at(-1);
  const badge =
    nextRoll <= safeRolls
      ? `<span class="badge safe">Safe roll ${nextRoll} of ${safeRolls} · 7 = +70</span>`
      : `<span class="badge danger">Roll ${nextRoll} · 7 busts!</span>`;

  return `
    <div class="row spread"><strong>Round ${state.round} of ${state.rounds}</strong>${badge}</div>
    <section class="panel table">
      <div class="pot-label">Pot</div>
      <div class="pot">${state.pot}</div>
      ${diceHtml(lastRoll)}
      <p class="roll-text">${lastRoll ? rollText(lastRoll) : '<span class="muted">No rolls yet</span>'}</p>
    </section>
    ${turnSection()}
    ${bankSection()}
    <section class="panel"><h2>Scores</h2>${playerList({ scores: true })}</section>
    ${rollLog()}
    ${leaveButton()}`;
}

/**
 * Every variant keeps the same shape for a given screen (a one-line banner plus a fixed
 * action row), so the Bank button below never moves when the turn changes.
 */
function turnSection() {
  const current = `<span class="who">${esc(nameOf(state.currentPlayerId))}</span>`;
  const myTurn = state.currentPlayerId === state.youId;
  const coolingDown = Date.now() < cooldownUntil;
  const banner = (text) => `<div class="turn-banner ${myTurn ? 'mine' : ''}">${text}</div>`;
  const theirTurn = `${current}<span>'s turn to roll</span>`;
  // An invisible stand-in keeps the row's height when there's no button to show.
  const skipButton = (size) =>
    isHost() && !myTurn
      ? `<button class="turn-action ${size}" data-action="skip">Skip ${esc(nameOf(state.currentPlayerId))}'s turn</button>`
      : `<button class="turn-action ${size} invisible" disabled tabindex="-1" aria-hidden="true">Skip</button>`;

  // With real dice, the host enters every roll; everyone else just rolls.
  if (state.diceMode === 'manual') {
    if (!isHost()) {
      return `
        <section class="panel stack">
          ${banner(myTurn ? 'Your turn! Roll the dice.' : theirTurn)}
          <p class="muted center">${myTurn ? `${esc(state.hostName)} will enter your total.` : '&nbsp;'}</p>
        </section>`;
    }
    return `
      <section class="panel stack">
        ${banner(myTurn ? 'Your turn!' : `<span>Enter&nbsp;</span>${current}<span>'s roll</span>`)}
        ${manualPicker(coolingDown)}
        ${skipButton('')}
      </section>`;
  }

  return `
    <section class="panel stack">
      ${banner(myTurn ? 'Your turn!' : theirTurn)}
      ${myTurn ? `<button class="turn-action primary big" data-action="roll" ${coolingDown ? 'disabled' : ''}>🎲 Roll</button>` : skipButton('big')}
    </section>`;
}

/** One tap enters the roll: a total, or (after the safe rolls) Doubles, where the total doesn't matter. */
function manualPicker(coolingDown) {
  const safe = state.rolls.length < state.limits.safeRolls;
  const disabled = coolingDown ? 'disabled' : '';
  const totals = Array.from({ length: 11 }, (_, i) => i + 2)
    // Once the safe rolls are over, a 7 busts the round, so make it stand out.
    .map((n) => `<button class="${n === 7 && !safe ? 'bust-total' : ''}" data-action="enterTotal" data-value="${n}" ${disabled}>${n}</button>`)
    .join('');
  const hint = safe
    ? `Tap the total. Doubles just add for the first ${state.limits.safeRolls} rolls.`
    : 'Tap the total, or Doubles to double the pot.';
  return `
    <p class="muted center picker-hint">${hint}</p>
    <div class="picker">
      ${totals}
      <button class="doubles" data-action="enterDoubles" ${safe || coolingDown ? 'disabled' : ''}>Doubles</button>
    </div>`;
}

function bankSection() {
  if (!state.youId) return ''; // a host who isn't playing has nothing to bank
  if (state.yourBank !== null) return `<div class="banked-note">🤫 You banked ${state.yourBank}</div>`;
  const confirm = isConfirming('bank');
  return `
    <button class="big bank ${confirm ? 'confirm' : ''}" data-action="bank" ${state.pot === 0 ? 'disabled' : ''}>
      ${confirm ? `Tap again to bank ${state.pot}` : `💰 Bank ${state.pot}`}
    </button>`;
}

function revealView() {
  const result = state.lastResult;
  return `
    <div class="row spread"><strong>Round ${result.round} of ${state.rounds}</strong><span class="badge">Round over</span></div>
    ${resultPanels(result)}
    <section class="panel"><h2>Scores</h2>${playerList({ scores: true })}</section>
    ${isHost() ? `<button class="primary big" data-action="nextRound">Start round ${result.round + 1}</button>` : waitingFor(`start round ${result.round + 1}`)}
    ${rollLog()}
    ${leaveButton()}`;
}

function gameOverView() {
  const winners = state.winnerIds.map((id) => esc(nameOf(id)));
  const headline = winners.length > 1 ? `🏆 Tie! ${winners.join(' & ')}` : `🏆 ${winners[0]} wins!`;
  return `
    <h1>BANKED</h1>
    <section class="panel table">
      <div class="result-banner win">${headline}</div>
      ${state.winnerIds.includes(state.youId) ? "<p>🎉 That's you!</p>" : ''}
    </section>
    <section class="panel"><h2>Final scores</h2>${playerList({ scores: true })}</section>
    ${isHost() ? '<button class="primary big" data-action="playAgain">Play again</button>' : waitingFor('start a new game')}
    ${state.lastResult ? resultPanels(state.lastResult) : ''}
    ${leaveButton()}`;
}

function resultPanels(result) {
  const everyoneBanked = result.banks.every((b) => b.amount !== null);
  const headline = result.bustedBy
    ? `<div class="result-banner bust">💥 BUST!</div>
       ${diceHtml(state.rolls.at(-1))}
       <p>${esc(result.bustedBy)} rolled a 7 with ${result.finalPot} in the pot.</p>`
    : `<div class="result-banner">${everyoneBanked ? 'Everyone banked!' : 'Round over'}</div>
       <p class="muted">Final pot: ${result.finalPot}</p>`;
  const banks = [...result.banks]
    .sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1))
    .map(
      (b) => `
        <li>
          <span class="name">${esc(b.name)}${b.playerId === state.youId ? ' <span class="tag you">(you)</span>' : ''}</span>
          <span class="score">${b.amount === null ? '<span class="muted">nothing</span>' : `+${b.amount}`}</span>
        </li>`,
    )
    .join('');
  return `
    <section class="panel table">${headline}</section>
    <section class="panel"><h2>Round ${result.round}: who banked</h2><ul class="players">${banks}</ul></section>`;
}

/** Scoreboards are ranked by score (ties keep turn order); otherwise the list is the turn order. */
function playerList({ scores = false, numbered = false } = {}) {
  const players = scores ? [...state.players].sort((a, b) => b.score - a.score) : state.players;
  const reorder = numbered && isHost();
  const items = players.map((p, i) => {
    const classes = [
      p.connected ? '' : 'offline',
      p.id === state.currentPlayerId ? 'turn' : '',
      state.winnerIds.includes(p.id) ? 'winner' : '',
    ].join(' ');
    const removeKey = `remove:${p.id}`;
    const removeButton =
      isHost() && p.id !== state.youId
        ? `<button class="small ${isConfirming(removeKey) ? 'confirm' : ''}" data-action="remove" data-value="${esc(p.id)}">
             ${isConfirming(removeKey) ? 'Remove?' : '✕'}
           </button>`
        : '';
    const moveButtons = reorder
      ? `<button class="small" data-action="move" data-value="-1:${esc(p.id)}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
         <button class="small" data-action="move" data-value="1:${esc(p.id)}" aria-label="Move down" ${i === players.length - 1 ? 'disabled' : ''}>▼</button>`
      : '';
    return `
      <li class="${classes}">
        ${numbered ? `<span class="seat">${i + 1}</span>` : ''}
        ${p.id === state.hostId ? '<span title="Host">👑</span>' : ''}
        <span class="name">
          ${esc(p.name)}
          ${p.id === state.youId ? '<span class="tag you">(you)</span>' : ''}
          ${p.connected ? '' : '<span class="tag">offline</span>'}
        </span>
        ${scores ? `<span class="score">${p.score}</span>` : ''}
        ${moveButtons}
        ${removeButton}
      </li>`;
  });
  return `<ul class="players">${items.join('')}</ul>`;
}

function diceHtml(roll) {
  // Real-dice rolls only have a total, which the roll text already shows.
  if (state.diceMode === 'manual') return '';
  const die = (n) =>
    n
      ? `<div class="die">${Array.from({ length: 9 }, (_, i) => `<span class="${PIPS[n].includes(i) ? 'pip' : ''}"></span>`).join('')}</div>`
      : '<div class="die placeholder"></div>';
  return `<div class="dice ${animateDice ? 'rolling' : ''}">${die(roll?.dice[0])}${die(roll?.dice[1])}</div>`;
}

function rollText(roll) {
  const who = roll.playerId === state.youId ? 'You' : esc(roll.playerName);
  const rolled = roll.dice
    ? `${roll.dice[0]} + ${roll.dice[1]}`
    : roll.sum === null
      ? 'doubles'
      : `${roll.sum}${roll.doubles ? ' (doubles)' : ''}`;
  const effect = {
    add: `+${roll.sum}${roll.doubles ? (roll.dice ? ' (doubles on a safe roll)' : ' (safe roll)') : ''}`,
    seventy: '<span class="effect-seventy">Safe 7! +70</span>',
    double: `<span class="effect-double">${roll.dice ? 'Doubles! Pot doubled' : 'Pot doubled!'}</span>`,
    bust: '<span class="effect-bust">7, BUST!</span>',
  }[roll.effect];
  return `${who} rolled ${rolled} · ${effect}`;
}

function rollLog() {
  const rolls = state.rolls;
  if (!rolls.length) return '';
  const items = rolls
    .map((r, i) => `<li><span class="muted">${i + 1}.</span> ${rollText(r)} <span class="muted">→ ${r.potAfter}</span></li>`)
    .reverse()
    .join('');
  return `
    <details id="log" class="panel" ${openAttr('log')}>
      <summary>This round's rolls (${rolls.length})</summary>
      <ul class="log">${items}</ul>
    </details>`;
}

function rulesPanel() {
  return `
    <details id="rules" class="panel" ${openAttr('rules')}>
      <summary>How to play</summary>
      <ul class="rules">
        <li>Each round, players take turns rolling two dice. Every roll adds to a shared pot.</li>
        <li>The first 3 rolls of a round are safe: a 7 is worth <b>70</b>, and doubles just add their sum.</li>
        <li>After that, doubles <b>double</b> the pot, and a 7 is a <b>bust</b>: the round ends and anyone who hasn't banked gets nothing.</li>
        <li>Tap <b>Bank</b> any time to lock in the current pot. It's secret and final. You still take your turns rolling.</li>
        <li>The round ends when everyone has banked or someone busts. Then all banks are revealed.</li>
        <li>Most points after the last round wins. Ties share the win.</li>
      </ul>
    </details>`;
}

function leaveButton() {
  return `<button class="link" data-action="leave">${isConfirming('leave') ? 'Tap again to leave the game' : 'Leave game'}</button>`;
}

connect();
