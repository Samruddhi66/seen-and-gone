'use strict';

/**
 * Seen & Gone — a room-code chat where a message burns away right after
 * the other person sees it.
 *
 * Nothing is ever written to disk or to a database. Messages live in memory
 * only, and a room disappears the moment its last member leaves, so there is
 * no history to look at — not even for the server.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SEEN_TTL_MS = Math.min(Math.max(Number(process.env.SEEN_TTL_MS) || 5000, 3000), 60000);
const MAX_TEXT = 500;
const MAX_MESSAGES_PER_ROOM = 100;
const MAX_ROOMS = 2000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/** @type {Map<string, {clients: Set<any>, messages: Map<string, any>, timers: Set<any>}>} */
const rooms = new Map();

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function normalizeRoom(value) {
  const code = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 32);
  return code.length >= 2 ? code : '';
}

function cleanName(value) {
  return (
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24) || 'Anonymous'
  );
}

// Each sender picks how long their own message lives after it is read.
function normalizeBurn(value) {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return SEEN_TTL_MS;
  return Math.min(Math.max(ms, 3000), 60000);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) {
      const oldest = rooms.keys().next().value;
      if (oldest) rooms.delete(oldest);
    }
    room = { clients: new Set(), messages: new Map(), timers: new Set() };
    rooms.set(code, room);
  }
  return room;
}

function emit(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    /* the connection died mid-write; the close handler will clean up */
  }
}

function broadcast(room, event, data, exceptUid) {
  for (const client of room.clients) {
    if (exceptUid && client.uid === exceptUid) continue;
    emit(client, event, data);
  }
}

function presence(room) {
  const people = [];
  for (const client of room.clients) {
    people.push({ uid: client.uid, name: client.name });
  }
  broadcast(room, 'presence', { people });
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const timer of room.timers) clearTimeout(timer);
  room.timers.clear();
  room.messages.clear();
  rooms.delete(code);
}

function schedule(room, ms, fn) {
  const timer = setTimeout(() => {
    room.timers.delete(timer);
    fn();
  }, ms);
  room.timers.add(timer);
}

function burnMessage(code, room, id) {
  if (!room.messages.has(id)) return;
  room.messages.delete(id);
  broadcast(room, 'burn', { id });
  if (rooms.get(code) !== room) return;
}

function handleStream(req, res, url) {
  const code = normalizeRoom(url.searchParams.get('room'));
  if (!code) return json(res, 400, { error: 'Pick a room code first.' });

  const uid = String(url.searchParams.get('uid') || '').slice(0, 40) || crypto.randomUUID();
  const name = cleanName(url.searchParams.get('name'));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ room: code, uid, ttl: SEEN_TTL_MS })}\n\n`);

  const room = getRoom(code);
  const client = { res, uid, name };
  room.clients.add(client);

  // Hand over messages nobody has read yet. Those are not history — they are
  // simply not delivered yet — and they still burn right after being seen.
  for (const message of room.messages.values()) {
    emit(client, 'msg', message);
  }
  presence(room);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (err) {
      /* ignore */
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    room.clients.delete(client);
    if (room.clients.size === 0) {
      // Last person out: the whole room is wiped. No history, by design.
      destroyRoom(code);
      return;
    }
    presence(room);
  });
}

async function handleSend(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, 400, { error: 'Could not read that message.' });
  }

  const code = normalizeRoom(body.room);
  if (!code) return json(res, 400, { error: 'Missing room code.' });

  const text = String(body.text || '').trim().slice(0, MAX_TEXT);
  if (!text) return json(res, 400, { error: 'Type something first.' });

  const room = rooms.get(code);
  if (!room) return json(res, 409, { error: 'That room is empty. Ask your friend to open it again.' });

  const message = {
    id: crypto.randomUUID(),
    text,
    from: String(body.uid || '').slice(0, 40),
    name: cleanName(body.name),
    at: Date.now(),
    burnAfter: normalizeBurn(body.burnAfter),
    seenAt: null,
    deleteAt: null,
  };

  room.messages.set(message.id, message);
  while (room.messages.size > MAX_MESSAGES_PER_ROOM) {
    const oldestId = room.messages.keys().next().value;
    room.messages.delete(oldestId);
  }

  broadcast(room, 'msg', message);
  return json(res, 200, { id: message.id, at: message.at });
}

async function handleSeen(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, 400, { error: 'Bad request.' });
  }

  const code = normalizeRoom(body.room);
  const room = code ? rooms.get(code) : null;
  if (!room) return json(res, 404, { error: 'Room is gone.' });

  const message = room.messages.get(String(body.id || ''));
  if (!message) return json(res, 404, { error: 'Message already burned.' });

  const viewer = String(body.uid || '').slice(0, 40);
  if (!viewer || viewer === message.from) return json(res, 200, { ok: true, skipped: true });

  if (message.seenAt) return json(res, 200, { ok: true, deleteAt: message.deleteAt });

  const ttl = message.burnAfter || SEEN_TTL_MS;
  const deleteAt = Date.now() + ttl;
  message.seenAt = Date.now();
  message.seenBy = viewer;
  message.deleteAt = deleteAt;

  broadcast(room, 'seen', { id: message.id, seenAt: message.seenAt, deleteAt, deleteIn: ttl });
  schedule(room, ttl, () => burnMessage(code, room, message.id));

  return json(res, 200, { ok: true, deleteAt, deleteIn: ttl });
}

function serveStatic(req, res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return json(res, 404, { error: 'Not found' });
  fs.readFile(path.join(PUBLIC_DIR, entry.file), (err, data) => {
    if (err) return json(res, 500, { error: 'Could not load the app.' });
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    return handleStream(req, res, url);
  }
  if (req.method === 'POST' && url.pathname === '/api/send') {
    return handleSend(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/seen') {
    return handleSeen(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET') {
    return serveStatic(req, res, url.pathname);
  }
  return json(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`Seen & Gone running on http://localhost:${PORT} (burn after ${SEEN_TTL_MS}ms)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const code of rooms.keys()) destroyRoom(code);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  });
}
