/**
 * Seen & Gone — Cloudflare Worker + D1 (hosted version).
 *
 * Rooms are dead simple: everyone who types the same room code shares a
 * message list. A message is deleted by the server right after its burn timer
 * ends, and a room's rows are wiped the moment nobody is inside, so there is
 * never any history to read back.
 *
 * Routes
 *   GET  /api/poll?room=&uid=&name=   messages + who is here
 *   POST /api/send                    { room, text, uid, name, burnAfter }
 *   POST /api/seen                    { room, id, uid }
 *   POST /api/leave                   { room, uid }
 *   *                                 static files from /public
 */

const DEFAULT_BURN = 5000;
const MIN_BURN = 3000;
const MAX_BURN = 60000;
const MAX_TEXT = 500;
const MAX_MESSAGES = 100;
const PRESENCE_TTL_MS = 15000;
const PRESENCE_SWEEP_MS = 60000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     room TEXT NOT NULL,
     body TEXT NOT NULL,
     sender TEXT NOT NULL,
     sender_name TEXT NOT NULL,
     created INTEGER NOT NULL,
     burn_after INTEGER NOT NULL,
     seen_at INTEGER,
     delete_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room, created)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_delete ON messages (delete_at)`,
  `CREATE TABLE IF NOT EXISTS presence (
     room TEXT NOT NULL,
     uid TEXT NOT NULL,
     name TEXT NOT NULL,
     last_seen INTEGER NOT NULL,
     PRIMARY KEY (room, uid)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_presence_room ON presence (room, last_seen)`,
];

let schemaReady = null;

function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of SCHEMA) {
        await env.DB.prepare(statement).run();
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

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

function normalizeBurn(value) {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_BURN;
  return Math.min(Math.max(ms, MIN_BURN), MAX_BURN);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch (error) {
    return null;
  }
}

async function handlePoll(url, env) {
  const room = normalizeRoom(url.searchParams.get('room'));
  if (!room) return json({ error: 'Pick a room code first.' }, 400);

  const uid = String(url.searchParams.get('uid') || '').slice(0, 40);
  const name = cleanName(url.searchParams.get('name'));
  const now = Date.now();

  await ensureSchema(env);

  const statements = [
    // Forget people who stopped polling.
    env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - PRESENCE_SWEEP_MS),
    // Drop messages whose burn timer has run out.
    env.DB.prepare('DELETE FROM messages WHERE delete_at IS NOT NULL AND delete_at <= ?').bind(now),
    // Wipe rooms that nobody is inside any more — no history, by design.
    env.DB.prepare(
      'DELETE FROM messages WHERE room NOT IN (SELECT room FROM presence WHERE last_seen > ?)'
    ).bind(now - PRESENCE_TTL_MS),
  ];

  // Clients only heartbeat every few seconds, so idling in a room is cheap.
  const beat = url.searchParams.get('beat') === '1';
  if (uid && beat) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO presence (room, uid, name, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT (room, uid) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`
      ).bind(room, uid, name, now)
    );
  }

  await env.DB.batch(statements);

  const [messages, people] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, body, sender, sender_name, created, burn_after, seen_at, delete_at
         FROM messages WHERE room = ? ORDER BY created ASC LIMIT ?`
    ).bind(room, MAX_MESSAGES),
    env.DB.prepare(
      'SELECT uid, name FROM presence WHERE room = ? AND last_seen > ? ORDER BY name'
    ).bind(room, now - PRESENCE_TTL_MS),
  ]);

  return json({
    now,
    burnDefault: DEFAULT_BURN,
    messages: (messages.results || []).map((row) => ({
      id: row.id,
      text: row.body,
      from: row.sender,
      name: row.sender_name,
      at: row.created,
      burnAfter: row.burn_after,
      seenAt: row.seen_at,
      deleteAt: row.delete_at,
    })),
    people: (people.results || []).map((row) => ({ uid: row.uid, name: row.name })),
  });
}

async function handleSend(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'Could not read that message.' }, 400);

  const room = normalizeRoom(body.room);
  if (!room) return json({ error: 'Missing room code.' }, 400);

  const text = String(body.text || '').trim().slice(0, MAX_TEXT);
  if (!text) return json({ error: 'Type something first.' }, 400);

  const sender = String(body.uid || '').slice(0, 40);
  if (!sender) return json({ error: 'Missing sender.' }, 400);

  await ensureSchema(env);

  const now = Date.now();
  const alive = await env.DB.prepare(
    'SELECT 1 AS ok FROM presence WHERE room = ? AND last_seen > ? LIMIT 1'
  )
    .bind(room, now - PRESENCE_TTL_MS)
    .first();
  if (!alive) {
    return json({ error: 'That room is empty. Ask your friend to open it again.' }, 409);
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, room, body, sender, sender_name, created, burn_after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      room,
      text,
      sender,
      cleanName(body.name),
      now,
      normalizeBurn(body.burnAfter)
    ),
    env.DB.prepare(
      `INSERT INTO presence (room, uid, name, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (room, uid) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`
    ).bind(room, sender, cleanName(body.name), now),
  ]);

  // Keep a room from growing without bound.
  await env.DB.prepare(
    `DELETE FROM messages WHERE room = ? AND id NOT IN (
       SELECT id FROM messages WHERE room = ? ORDER BY created DESC LIMIT ?
     )`
  )
    .bind(room, room, MAX_MESSAGES)
    .run();

  return json({ ok: true });
}

async function handleSeen(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'Bad request.' }, 400);

  const room = normalizeRoom(body.room);
  const uid = String(body.uid || '').slice(0, 40);
  const id = String(body.id || '');
  if (!room || !id || !uid) return json({ error: 'Bad request.' }, 400);

  await ensureSchema(env);

  const now = Date.now();
  const message = await env.DB.prepare(
    'SELECT id, sender, burn_after, seen_at, delete_at FROM messages WHERE id = ? AND room = ?'
  )
    .bind(id, room)
    .first();

  if (!message) return json({ error: 'Message already burned.' }, 404);
  if (message.sender === uid) return json({ ok: true, skipped: true });
  if (message.seen_at) return json({ ok: true, deleteAt: message.delete_at });

  const ttl = message.burn_after || DEFAULT_BURN;
  const deleteAt = now + ttl;
  await env.DB.prepare(
    'UPDATE messages SET seen_at = ?, delete_at = ? WHERE id = ? AND seen_at IS NULL'
  )
    .bind(now, deleteAt, id)
    .run();

  return json({ ok: true, deleteAt, deleteIn: ttl });
}

async function handleLeave(request, env) {
  const body = await readJson(request);
  const room = normalizeRoom(body && body.room);
  const uid = String((body && body.uid) || '').slice(0, 40);
  if (!room || !uid) return json({ ok: true });

  await ensureSchema(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM presence WHERE room = ? AND uid = ?').bind(room, uid),
    // Nothing left in the room? Take the messages with it.
    env.DB.prepare(
      'DELETE FROM messages WHERE room = ? AND NOT EXISTS (SELECT 1 FROM presence WHERE room = ?)'
    ).bind(room, room),
  ]);

  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        if (url.pathname === '/api/poll' && request.method === 'GET') {
          return await handlePoll(url, env);
        }
        if (url.pathname === '/api/send' && request.method === 'POST') {
          return await handleSend(request, env);
        }
        if (url.pathname === '/api/seen' && request.method === 'POST') {
          return await handleSeen(request, env);
        }
        if (url.pathname === '/api/leave' && request.method === 'POST') {
          return await handleLeave(request, env);
        }
        return json({ error: 'Not found' }, 404);
      } catch (error) {
        return json({ error: 'Server hiccup. Try again.' }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
