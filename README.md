# VAControl

Real-time flight strip platform for VA events in Project Flight.

## Stack

- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Real-time**: WebSockets via Socket.io

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000`

For development with auto-restart:
```bash
npm run dev
```

## How it works

1. An event organizer hits **Create event** — names the event, sets the airport ICAO, picks a username
2. The server creates a room and returns a **6-character room code** (e.g. `A1B2C3`)
3. Share the code with your ATC team and pilots — they click **Join event** and enter the code
4. Everyone sees the same board in real-time via WebSockets
5. Add flight strips per pilot, move them through: **Registered → Departing → En Route → Arrived**

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `N` | Add new strip (when on board) |
| `Esc` | Close any open panel or modal |

## Deploying to Wispbyte / Railway / Render

Set `PORT` env variable if needed — the server reads `process.env.PORT || 3000`.

No database required — rooms live in memory. Restart clears all data (suitable for events).

## File structure

```
vacontrol/
├── package.json
├── server/
│   └── index.js        ← Express + Socket.io server
└── public/
    ├── index.html      ← All UI (home + board)
    ├── style.css       ← All styles
    └── app.js          ← Client logic
```
