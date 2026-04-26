/* ============================================================
   VAControl — client app
   ============================================================ */

const socket = io();

// ── State ──────────────────────────────────────────────────
let state = {
  room: null,
  username: '',
  activeStripId: null
};

const STATUSES = [
  { key: 'registered', label: 'Registered', color: '#6b7280' },
  { key: 'departing',  label: 'Departing',  color: '#3b82f6' },
  { key: 'enroute',    label: 'En Route',   color: '#22c55e' },
  { key: 'arrived',    label: 'Arrived',    color: '#a855f7' }
];

// ── Helpers ────────────────────────────────────────────────
function utcTime(ts) {
  return new Date(ts).toISOString().slice(11, 16) + 'z';
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function openPanel(id) {
  document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
  document.getElementById(id).classList.add('open');
}
function closePanel(id) {
  document.getElementById(id).classList.remove('open');
  state.activeStripId = null;
}

// ── Home page interactions ─────────────────────────────────
document.getElementById('create-card').addEventListener('click', () => openModal('create-modal'));
document.getElementById('join-card').addEventListener('click', () => openModal('join-modal'));

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) backdrop.classList.remove('open');
  });
});

// Create room
document.getElementById('create-btn').addEventListener('click', async () => {
  const name = document.getElementById('c-name').value.trim();
  const airport = document.getElementById('c-airport').value.trim().toUpperCase();
  const user = document.getElementById('c-user').value.trim();
  const err = document.getElementById('create-error');

  if (!name) { err.textContent = 'Event name is required.'; return; }
  if (!user) { err.textContent = 'Username is required.'; return; }
  err.textContent = '';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventName: name, airport })
    });
    const data = await res.json();
    if (!data.roomId) throw new Error('No room ID');
    state.username = user;
    joinRoom(data.roomId, user);
    closeModal('create-modal');
  } catch (e) {
    err.textContent = 'Failed to create room. Try again.';
  }
});

// Join room
document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('j-code').value.trim().toUpperCase();
  const user = document.getElementById('j-user').value.trim();
  const err = document.getElementById('join-error');

  if (!code || code.length < 4) { err.textContent = 'Enter a valid room code.'; return; }
  if (!user) { err.textContent = 'Username is required.'; return; }
  err.textContent = '';

  state.username = user;
  joinRoom(code, user);
  closeModal('join-modal');
});

// ── Socket: join room ──────────────────────────────────────
function joinRoom(roomId, username) {
  socket.emit('room:join', { roomId, username });
}

socket.on('room:joined', (room) => {
  state.room = room;
  showBoard(room);
});

socket.on('room:error', ({ message }) => {
  const jErr = document.getElementById('join-error');
  if (jErr) jErr.textContent = message;
  toast('Error: ' + message);
});

socket.on('room:update', (room) => {
  state.room = room;
  renderStrips(room.strips);
  updateStats(room);
});

socket.on('room:message', ({ text }) => {
  toast(text);
});

// ── Show board ─────────────────────────────────────────────
function showBoard(room) {
  document.getElementById('home-screen').style.display = 'none';
  const board = document.getElementById('board-screen');
  board.style.display = 'flex';

  document.getElementById('board-event-name').textContent = room.eventName + (room.airport ? ` — ${room.airport}` : '');
  document.getElementById('board-room-code').textContent = room.id;

  renderStrips(room.strips);
  updateStats(room);
}

function updateStats(room) {
  document.getElementById('stat-total').textContent = room.strips.length;
  document.getElementById('stat-conn').textContent = room.connectedCount || 1;
}

// ── Render strips ──────────────────────────────────────────
function renderStrips(strips) {
  STATUSES.forEach(({ key }) => {
    const el = document.getElementById('strips-' + key);
    const lane = strips.filter(s => s.status === key);
    document.getElementById('cnt-' + key).textContent = lane.length;

    if (lane.length === 0) {
      el.innerHTML = '<div class="strip-empty">No flights yet</div>';
      return;
    }
    el.innerHTML = lane.map(buildStrip).join('');
  });

  // Re-attach strip click handlers
  document.querySelectorAll('.strip').forEach(el => {
    el.addEventListener('click', () => openDetail(el.dataset.id));
  });
}

function buildStrip(f) {
  const tags = [
    f.gate  ? `<span class="s-tag">${f.gate}</span>` : '',
    f.fl    ? `<span class="s-tag">${f.fl}</span>` : '',
    f.remarks ? `<span class="s-tag s-remark">★ ${f.remarks.slice(0, 18)}</span>` : ''
  ].join('');

  return `
    <div class="strip" data-id="${f.id}" data-status="${f.status}">
      <div class="s-row1">
        <span class="s-cs">${f.callsign}</span>
        <span class="s-ac">${f.actype}</span>
        <span class="s-va">${f.va || '—'}</span>
      </div>
      <div class="s-row2">
        <span>${f.orig}</span>
        <span class="s-arr">→</span>
        <span>${f.dest}</span>
      </div>
      <div class="s-row3">
        ${tags}
        <span class="s-time">${utcTime(f.addedAt)}</span>
        <span class="s-pilot">${f.pilot}</span>
      </div>
    </div>`;
}

// ── Add strip ──────────────────────────────────────────────
document.getElementById('open-add-btn').addEventListener('click', () => {
  openPanel('add-panel');
});
document.getElementById('close-add-btn').addEventListener('click', () => {
  closePanel('add-panel');
});

document.getElementById('add-strip-btn').addEventListener('click', () => {
  const cs = document.getElementById('a-cs').value.trim().toUpperCase();
  if (!cs) { toast('Callsign is required'); return; }

  socket.emit('strip:add', {
    roomId: state.room.id,
    strip: {
      callsign: cs,
      actype:   document.getElementById('a-ac').value.trim().toUpperCase() || '---',
      va:       document.getElementById('a-va').value.trim() || '',
      orig:     document.getElementById('a-orig').value.trim().toUpperCase() || '----',
      dest:     document.getElementById('a-dest').value.trim().toUpperCase() || '----',
      gate:     document.getElementById('a-gate').value.trim().toUpperCase() || '',
      fl:       document.getElementById('a-fl').value.trim().toUpperCase() || '',
      pilot:    document.getElementById('a-pilot').value.trim() || 'Unknown',
      remarks:  document.getElementById('a-remarks').value.trim() || ''
    }
  });

  ['a-cs','a-ac','a-va','a-orig','a-dest','a-gate','a-fl','a-pilot','a-remarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
  closePanel('add-panel');
  toast('Strip added');
});

// ── Strip detail ───────────────────────────────────────────
function openDetail(stripId) {
  const strips = state.room?.strips || [];
  const f = strips.find(s => s.id === stripId);
  if (!f) return;
  state.activeStripId = stripId;

  document.getElementById('d-callsign-header').textContent = f.callsign;
  document.getElementById('d-cs').textContent = f.callsign;
  document.getElementById('d-sub').textContent = `${f.orig} → ${f.dest} · Added ${utcTime(f.addedAt)}`;

  document.getElementById('d-grid').innerHTML = `
    <div class="detail-item"><label>Aircraft</label><span>${f.actype}</span></div>
    <div class="detail-item"><label>VA</label><span>${f.va || '—'}</span></div>
    <div class="detail-item"><label>Gate</label><span>${f.gate || '—'}</span></div>
    <div class="detail-item"><label>Flight Level</label><span>${f.fl || '—'}</span></div>
    <div class="detail-item"><label>Pilot</label><span>${f.pilot}</span></div>
    <div class="detail-item"><label>Status</label><span style="text-transform:capitalize">${f.status}</span></div>
  `;

  const btns = document.getElementById('status-btns');
  btns.innerHTML = STATUSES.map(s => `
    <button class="status-btn ${f.status === s.key ? 'current' : ''}" data-key="${s.key}">
      <span class="s-dot" style="background:${s.color}"></span>
      ${s.label}
    </button>`).join('');

  btns.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('strip:update', {
        roomId: state.room.id,
        stripId: state.activeStripId,
        changes: { status: btn.dataset.key }
      });
      closePanel('detail-panel');
      toast(`Moved to ${btn.dataset.key}`);
    });
  });

  document.getElementById('d-remarks').value = f.remarks || '';
  openPanel('detail-panel');
}

document.getElementById('close-detail-btn').addEventListener('click', () => closePanel('detail-panel'));

document.getElementById('save-remarks-btn').addEventListener('click', () => {
  const remarks = document.getElementById('d-remarks').value.trim();
  socket.emit('strip:update', {
    roomId: state.room.id,
    stripId: state.activeStripId,
    changes: { remarks }
  });
  toast('Remarks saved');
});

document.getElementById('delete-strip-btn').addEventListener('click', () => {
  if (!state.activeStripId) return;
  socket.emit('strip:remove', {
    roomId: state.room.id,
    stripId: state.activeStripId
  });
  closePanel('detail-panel');
  toast('Strip removed');
});

// ── Back button ────────────────────────────────────────────
document.getElementById('back-btn').addEventListener('click', () => {
  document.getElementById('board-screen').style.display = 'none';
  document.getElementById('home-screen').style.display = 'block';
  state.room = null;
  state.activeStripId = null;
});

// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.side-panel.open').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
    state.activeStripId = null;
  }
  if (e.key === 'n' && !e.target.matches('input, textarea') && state.room) {
    openPanel('add-panel');
    setTimeout(() => document.getElementById('a-cs').focus(), 50);
  }
});