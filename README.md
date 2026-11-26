# 🔥 Seen & Gone

**A chat that forgets.** Share a room code, send a message — the moment the other person reads it,
the message burns away for everyone. No chat history, ever.

### ▶️ Live app: **https://seen-and-gone-8c270f.freebuff.site**

### 📱 Android APK: **[download seen-and-gone.apk](https://github.com/Samruddhi66/seen-and-gone/releases/latest/download/seen-and-gone.apk)**

Open it on two phones (or two browser tabs), type the same room code, and start talking.

## Install the Android app

1. Tap the APK link above (it always points at the newest build).
2. Open the downloaded file and allow "install from this source" if Android asks.
3. Open **Seen & Gone** from your home screen.

The APK is a thin Android shell (WebView) around the hosted app, so it always runs the newest
version. It is built automatically by GitHub Actions on every push that touches `android/` —
see [`.github/workflows/android-apk.yml`](.github/workflows/android-apk.yml) and the
[releases page](https://github.com/Samruddhi66/seen-and-gone/releases).

**iPhone:** open the live link in Safari → Share → **Add to Home Screen**.

## How it works

1. Open the app and type a **room code** (any word you and your friend agree on, e.g. `chai-42`).
2. Pick how long your messages live after being read: **3s, 5s, 7s or 9s**.
3. Your friend opens the same link, picks their own burn time, and types the same room code.
4. Send messages. The moment the other person's screen shows a message, it starts that sender's
   countdown, then it is deleted — on their screen, on your screen and on the server.
5. Leave the room and everything about it is wiped.

## Run it yourself

The app is a single Cloudflare Worker (no framework, no build step) plus a D1 database.

```bash
npm install
npm run db:local      # create the local database tables
npm run dev           # http://localhost:8787
```

To put it on your own Cloudflare account:

```bash
npx wrangler d1 create seen-and-gone     # copy the id into wrangler.jsonc
npx wrangler d1 execute DB --remote --file=./schema.sql
npx wrangler deploy
```

To build the Android APK yourself you need the Android SDK and JDK 17:

```bash
cd android && gradle assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

## How it stays history-free

- A message is deleted by the server the moment its burn timer ends.
- A room's rows are deleted as soon as nobody is inside it any more.
- Leaving the page tells the server you left; a room with no one in it keeps nothing.
- The hosted version keeps a message in a temporary database table **only while it is alive**
  (seconds). It is then deleted — this is not a chat archive, and there is nothing to scroll back to.
- Messages are not end-to-end encrypted: the server can read a message while it is on screen,
  it just never stores it afterwards.

## Project layout

```
worker/index.js          → the whole API: /api/poll, /api/send, /api/seen, /api/leave
schema.sql               → D1 tables (messages, presence)
wrangler.jsonc           → Cloudflare config for local dev + your own deploy
sites.manifest.json      → deployment manifest used by Freebuff Sites
public/index.html        → join screen + chat UI
public/app.js            → polling client, seen tracking, burn countdown
public/style.css         → the dark "burning paper" theme
public/manifest.webmanifest, public/sw.js, public/icons/  → installable app shell
android/                 → the WebView Android app (Gradle project)
.github/workflows/       → builds the APK and attaches it to a release
```

## License

MIT
