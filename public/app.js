'use strict';

/* Seen & Gone — client. Rooms live on the server in memory only. */

const els = {
  joinScreen: document.getElementById('joinScreen'),
  chatScreen: document.getElementById('chatScreen'),
  joinForm: document.getElementById('joinForm'),
  roomInput: document.getElementById('roomInput'),
  nameInput: document.getElementById('nameInput'),
  burnOptions: document.getElementById('burnOptions'),
  joinError: document.getElementById('joinError'),
  roomLabel: document.getElementById('roomLabel'),
  presence: document.getElementById('presence'),
  copyBtn: document.getElementById('copyBtn'),
  leaveBtn: document.getElementById('leaveBtn'),
  messages: document.getElementById('messages'),
  emptyState: document.getElementById('emptyState'),
  composer: document.getElementById('composer'),
  messageInput: document.getElementById('messageInput'),
  ttlLabel: document.getElementById('ttlLabel'),
};

const state = {
  room: '',
  name: '',
  uid: randomId(),
  burnAfter: 5000,
  source: null,
  nodes: new Map(), // id -> { el, timer, deleteAt }
  seenSent: new Set(),
  pendingTimer: null,
};

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function normalizeRoom(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 32);
}

function clock(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

/* ---------- screens ---------- */

function showChat() {
  els.joinScreen.hidden = true;
  els.chatScreen.hidden = false;
  els.roomLabel.textContent = state.room;
  els.ttlLabel.textContent = String(clock(state.burnAfter));
  els.messageInput.focus();
}

function showJoin() {
  els.joinScreen.hidden = false;
  els.chatScreen.hidden = true;
  els.roomInput.value = state.room;
  els.roomInput.focus();
}

function fail(message) {
  els.joinError.textContent = message;
  els.joinError.hidden = false;
}

/* ---------- room lifecycle ---------- */

function join(room, name) {
  leave();
  state.room = room;
  state.name = name;
  state.seenSent.clear();
  els.messages.querySelectorAll('.msg').forEach((el) => el.remove());
  els.emptyState.hidden = false;
  els.joinError.hidden = true;
  els.ttlLabel.textContent = String(clock(state.burnAfter));
  showChat();

  const params = new URLSearchParams({ room, uid: state.uid, name });
  state.source = new EventSource(`/api/stream?${params.toString()}`);


  state.source.addEventListener('msg', (event) => onMessage(JSON.parse(event.data)));
  state.source.addEventListener('seen', (event) => onSeen(JSON.parse(event.data)));
  state.source.addEventListener('burn', (event) => onBurn(JSON.parse(event.data)));
  state.source.addEventListener('presence', (event) => onPresence(JSON.parse(event.data)));
}

function leave() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  for (const entry of state.nodes.values()) {
    if (entry.timer) clearInterval(entry.timer);
  }
  state.nodes.clear();
  state.seenSent.clear();
  els.messages.querySelectorAll('.msg').forEach((el) => el.remove());
  els.emptyState.hidden = false;
}

/* ---------- messages ---------- */

function onMessage(message) {
  if (state.nodes.has(message.id)) return;
  renderMessage(message);

  if (message.from === state.uid) return;

  // Mark as seen once it is actually on screen (and the tab is in front).
  const markSeen = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', markSeen);
    markSeenOnServer(message.id);
  };
  if (document.visibilityState === 'visible') {
    setTimeout(markSeen, 700);
  } else {
    document.addEventListener('visibilitychange', markSeen);
  }
}

function markSeenOnServer(id) {
  if (state.seenSent.has(id)) return;
  state.seenSent.add(id);
  fetch('/api/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: state.room, id, uid: state.uid }),
  }).catch(() => {
    /* the message may already be gone — nothing to retry */
  });
}

function renderMessage(message) {
  els.emptyState.hidden = true;

  const mine = message.from === state.uid;
  const wrap = document.createElement('article');
  wrap.className = 'msg ' + (mine ? 'mine' : 'theirs');

  const author = document.createElement('div');
  author.className = 'author';
  author.textContent = mine ? 'You' : message.name || 'Anonymous';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text;

  const burnSeconds = clock(message.burnAfter || state.burnAfter);
  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = mine ? `sent • burns ${burnSeconds}s after read` : 'unread';

  wrap.append(author, bubble, status);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;

  const entry = { el: wrap, status, timer: null, deleteAt: null };
  state.nodes.set(message.id, entry);

  if (mine && message.seenAt) applySeen(message.id, message.deleteAt);
}

function onSeen(payload) {
  applySeen(payload.id, payload.deleteAt);
}

function applySeen(id, deleteAt) {
  const entry = state.nodes.get(id);
  if (!entry) return;

  entry.deleteAt = deleteAt;
  entry.el.classList.add('is-seen');

  const tick = () => {
    const left = (entry.deleteAt || 0) - Date.now();
    if (left <= 0) {
      entry.status.textContent = 'burning…';
      return;
    }
    entry.status.textContent = `seen • burns in ${clock(left)}s`;
  };

  tick();
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = setInterval(tick, 250);
  entry.el.classList.add('flash');
}

function onBurn(payload) {
  const entry = state.nodes.get(payload.id);
  if (!entry) return;

  if (entry.timer) clearInterval(entry.timer);
  entry.status.textContent = 'gone';
  entry.el.classList.add('burning');

  setTimeout(() => {
    entry.el.remove();
    state.nodes.delete(payload.id);
    state.seenSent.delete(payload.id);
    if (!els.messages.querySelector('.msg')) els.emptyState.hidden = false;
  }, 450);
}

function onPresence(payload) {
  const people = payload.people || [];
  const others = people.filter((p) => p.uid !== state.uid).length;
  els.presence.textContent = others > 0 ? `${people.length} here` : 'waiting for the other person…';
  els.presence.classList.toggle('alone', others === 0);
}

/* ---------- sending ---------- */

async function send(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  els.messageInput.value = '';
  try {
    const response = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: state.room,
        text: trimmed,
        uid: state.uid,
        name: state.name,
        burnAfter: state.burnAfter,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      els.messageInput.value = trimmed;
      toast(data.error || 'Could not send that. Try again.');
    }
  } catch (err) {
    els.messageInput.value = trimmed;
    toast('Connection lost. Reconnecting…');
  }
}

function toast(text) {
  let box = document.querySelector('.toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.classList.remove('show'), 2600);
}

/* ---------- wiring ---------- */

els.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const room = normalizeRoom(els.roomInput.value);
  if (room.length < 2) return fail('Use at least 2 letters or numbers for the room code.');
  const name = els.nameInput.value.trim().slice(0, 24);
  const picked = els.burnOptions.querySelector('input[name="burnAfter"]:checked');
  state.burnAfter = picked ? Number(picked.value) : 5000;
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
  join(room, name);
});

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  send(els.messageInput.value);
});

els.copyBtn.addEventListener('click', async () => {
  const link = `${location.origin}/?room=${encodeURIComponent(state.room)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch (err) {
    toast(link);
  }
});

els.leaveBtn.addEventListener('click', () => {
  leave();
  history.replaceState(null, '', location.pathname);
  showJoin();
});

const fromUrl = new URLSearchParams(location.search).get('room');
if (fromUrl) els.roomInput.value = normalizeRoom(fromUrl);
els.roomInput.focus();
