# Banked

A dice party game played from everyone's phones on your home Wi-Fi. One laptop runs the server; phones just open a web page. No app installs or accounts, and nothing to deploy.

## Run it

```sh
npm install
npm start
```

The terminal prints a URL (like `http://192.168.1.23:3000`) and a QR code. Everyone on the same Wi-Fi scans it or types it into their phone's browser.

One person taps **Start a new game** and gets a 4-letter room code. Everyone else taps **Join a friend's game** and enters it, or opens the invite link. The person who creates the game is the host.

Use `PORT=4000 npm start` to pick a different port. If phones can't connect, check that macOS allowed incoming connections for `node` (System Settings → Network → Firewall).

## Deploying to Render (free)

`render.yaml` describes the service. In Render, choose **New → Blueprint**, pick this repo, and deploy.

Games live in memory on a single instance. Render's free tier sleeps after 15 minutes without traffic, which ends any games, and the first visit afterwards takes about a minute to wake it up.

## How to play

- Each round, players take turns rolling two dice. Every roll adds to a shared pot.
- The first 3 rolls of a round are safe: a 7 is worth **70**, and doubles just add their sum.
- After that, doubles **double** the pot, and a 7 is a **bust**: the round ends and anyone who hasn't banked gets nothing.
- Tap **Bank** at any time to lock in the current pot. Banking is secret and final. You still take your turns rolling.
- The round ends when everyone has banked or someone busts, and then all banks are revealed.
- After the last round (20 by default), the highest total wins. Ties share the win.

The host picks the number of rounds and virtual vs. real dice in the lobby. In real-dice mode, each player taps the total they rolled, plus **Doubles** if both dice matched. Only the host can start the game, skip a turn, remove a player, or advance to the next round.

## Development

```sh
npm run dev        # restart the server on file changes
npm test           # game rules tests
npm run typecheck
```

- `src/game.ts`: game rules and state, with no networking.
- `src/server.ts`: HTTP and WebSocket server. Sends each player their own view, so other players' banks stay hidden.
- `public/`: the phone client, in plain HTML, CSS, and JS with no build step.

Game state lives in memory, so stopping the server ends the game.
