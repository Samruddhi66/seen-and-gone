'use strict';

/* Seen & Gone — client. Rooms live on the server only while people are inside. */

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

const POLL_MS = 1200;

const state = {
  room: '',
  name: '',
  uid: randomId(),
  burnAfter: 5000,
  loop: null,
  polls: 0,
  polling: false,
  online: true,
  nodes: new Map(), // id -> { el, status, timer, deleteAt }
  seenSent: new Set(),
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
  leave({ tellServer: false });
  state.room = room;
  state.name = name;
  state.polls = 0;
  showChat();

  poll();
  state.loop = setInterval(poll, POLL_MS);
}

function leave(options) {
  const tellServer = !options || options.tellServer !== false;

  if (state.loop) {
    clearInterval(state.loop);
    state.loop = null;
  }
  if (tellServer && state.room) {
    const body = JSON.stringify({ room: state.room, uid: state.uid });
    try {
      navigator.sendBeacon('/api/leave', body);
    } catch (err) {
      fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  }

  for (const entry of state.nodes.values()) {
    if (entry.timer) clearInterval(entry.timer);
  }
  state.nodes.clear();
  state.seenSent.clear();
  els.messages.querySelectorAll('.msg').forEach((el) => el.remove());
  els.emptyState.hidden = false;
}

/* ---------- talking to the server ---------- */

async function poll() {
  if (!state.room || state.polling) return;
  state.polling = true;
  const room = state.room;

  try {
    const beat = state.polls % 4 === 0 ? '1' : '0';
    state.polls += 1;
    const params = new URLSearchParams({ room, uid: state.uid, name: state.name, beat });
    const response = await fetch(`/api/poll?${params.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('poll failed');
    const data = await response.json();
    if (state.room !== room) return;
    applyState(data);
    setLinkState(true);
  } catch (err) {
    setLinkState(false);
  } finally {
    state.polling = false;
  }
}

function applyState(data) {
  updatePresence(data.people || []);
  if (data.burnDefault && state.burnDefault !== data.burnDefault) {
    state.burnDefault = data.burnDefault;
  }

  const ids = new Set();
  for (const message of data.messages || []) {
    ids.add(message.id);

    if (!state.nodes.has(message.id)) {
      renderMessage(message);
      if (message.from !== state.uid) markSeenSoon(message.id);
    } else if (message.from === state.uid && message.seenAt) {
      applySeen(message.id, message.deleteAt);
    }
  }

  for (const id of [...state.nodes.keys()]) {
    if (!ids.has(id)) removeMessage(id);
  }
}

function setLinkState(online) {
  if (state.online === online) return;
  state.online = online;
  if (!online) els.presence.textContent = 'reconnecting…';
}

/* ---------- messages ---------- */

function markSeenSoon(id) {
  if (state.seenSent.has(id)) return;
  state.seenSent.add(id);

  const send = () => {
    if (document.visibilityState !== 'visible') {
      setTimeout(send, 1500);
      return;
    }
    fetch('/api/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: state.room, id, uid: state.uid }),
    })
      .then(() => poll())
      .catch(() => {
        state.seenSent.delete(id);
      });
  };

  setTimeout(send, 700);
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

  state.nodes.set(message.id, { el: wrap, status, timer: null, deleteAt: null });

  if (mine && message.seenAt) applySeen(message.id, message.deleteAt);
}

function applySeen(id, deleteAt) {
  const entry = state.nodes.get(id);
  if (!entry || entry.timer) return;

  entry.deleteAt = deleteAt;
  entry.el.classList.add('is-seen', 'flash');

  const tick = () => {
    const left = (entry.deleteAt || 0) - Date.now();
    if (left <= 0) {
      entry.status.textContent = 'burning…';
      return;
    }
    entry.status.textContent = `seen • burns in ${clock(left)}s`;
  };

  tick();
  entry.timer = setInterval(tick, 250);
}

function removeMessage(id) {
  const entry = state.nodes.get(id);
  if (!entry) return;

  if (entry.timer) clearInterval(entry.timer);
  state.nodes.delete(id);
  state.seenSent.delete(id);

  entry.status.textContent = 'gone';
  entry.el.classList.add('burning');

  setTimeout(() => {
    entry.el.remove();
    if (!els.messages.querySelector('.msg')) els.emptyState.hidden = false;
  }, 450);
}

function updatePresence(people) {
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
      return;
    }
    poll();
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
  state.room = '';
  history.replaceState(null, '', location.pathname);
  showJoin();
});

window.addEventListener('pagehide', () => {
  if (state.room) leave();
});

const fromUrl = new URLSearchParams(location.search).get('room');
if (fromUrl) els.roomInput.value = normalizeRoom(fromUrl);
els.roomInput.focus();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
