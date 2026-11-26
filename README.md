# 🔥 Seen & Gone

**A chat that forgets.** Share a room code, send a message — the moment the other person reads it,
the message burns away for everyone. No database, no logs, no history.

## How it works

1. Open the app, type a **room code** (any word you and your friend agree on, e.g. `chai-42`).
2. Your friend opens the same page, types the same room code.
3. Send messages. As soon as the other person's screen shows a message, it starts a countdown
   (8 seconds by default) and then it is deleted — on their screen, on your screen and on the server.
4. Close the tab or leave the room and everything about that room is wiped server-side.

Because the messages only ever exist in the server's memory while both people are in the room,
there is no chat history to scroll back to, and nothing to recover afterwards.

## Run it

```bash
node server.js
# → http://localhost:3000
```

No dependencies, no build step — it's plain Node.js (18+) with Server-Sent Events.

Optional environment variables:

| Variable      | Default   | Meaning                                            |
| ------------- | --------- | -------------------------------------------------- |
| `PORT`        | `3000`    | Port to listen on                                  |
| `HOST`        | `0.0.0.0` | Interface to bind                                  |
| `SEEN_TTL_MS` | `8000`    | Milliseconds between "seen" and the message burning |

## Privacy notes

- Messages are held in memory only. Nothing is written to disk or to any database.
- A message is removed from the server as soon as its burn timer ends.
- A room is destroyed the instant its last member leaves — pending messages included.
- The room code is the only secret. Anyone who knows it can join, so keep it short-lived and private.
- This is not end-to-end encrypted: the server can read a message while it is alive. It just never
  stores it.

## Project layout

```
server.js        → tiny HTTP server: SSE stream, /api/send, /api/seen, static files
public/index.html
public/app.js    → join screen, chat, seen tracking + burn countdown
public/style.css
```

## License

MIT
