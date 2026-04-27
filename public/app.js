/* ============================================================
   PFEvent Control — client app.js
   Roles: ATC | Pilot
   ============================================================ */

const socket = io();

// ── State ──────────────────────────────────────────────────
const S = {
  user: null,
  room: null,
  activeStripId: null,
  pdcStripId: null,       // strip pilot is waiting on
  myStripId: null,        // pilot's own filed strip
  flightRules: 'IFR',
  starRating: 0,
  atcIdForRating: null
};

// ── Boot: check who's logged in ────────────────────────────
async function boot() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    const user = data.user;
    console.log('[boot] /api/me returned:', user);

    const err = new URLSearchParams(location.search).get('error');
    if (err) {
      const el = document.getElementById('login-error');
      if (el) el.textContent = err === 'auth_failed' ? 'Discord login failed. Try again.' : 'Error: ' + err;
    }

    if (!user) {
      show('screen-login');
      return;
    }
    S.user = user;
    if (!user.role) {
      show('screen-role');
      renderNavUser('nav-user-role');
    } else {
      showHome();
    }
  } catch (e) {
    console.error('[boot] failed:', e);
    show('screen-login');
    const el = document.getElementById('login-error');
    if (el) el.textContent = 'Failed to connect to server. Try refreshing.';
  }
}

// Wait for DOM then boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// ── Screen helpers ─────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = '';
}

function renderNavUser(elId) {
  const el = document.getElementById(elId);
  if (el && S.user) el.textContent = S.user.username;
}

// ── Role selection ─────────────────────────────────────────
async function selectRole(role) {
  await fetch('/api/me/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role })
  });
  S.user.role = role;
  showHome();
}

function switchRole() {
  S.user.role = null;
  show('screen-role');
  renderNavUser('nav-user-role');
}

// ── Home screen ────────────────────────────────────────────
function showHome() {
  show('screen-home');
  renderNavUser('nav-user-home');
  const badge = document.getElementById('nav-role-badge');
  badge.textContent = S.user.role.toUpperCase();
  badge.className = 'nav-role-badge ' + S.user.role;

  const cards = document.getElementById('home-cards');
  if (S.user.role === 'atc') {
    cards.innerHTML = `
      <div class="home-card" onclick="openModal('create-modal')">
        <div class="home-card-icon">🗼</div>
        <div class="home-card-title">Create event room</div>
        <div class="home-card-desc">Start a new ATC session and get a room code</div>
      </div>
      <div class="home-card" onclick="openModal('join-modal')">
        <div class="home-card-icon">🔑</div>
        <div class="home-card-title">Join room</div>
        <div class="home-card-desc">Join an existing event with a room code</div>
      </div>`;
  } else {
    cards.innerHTML = `
      <div class="home-card" onclick="openModal('join-modal')">
        <div class="home-card-icon">✈️</div>
        <div class="home-card-title">Join event</div>
        <div class="home-card-desc">Enter the room code from your event organizer</div>
      </div>`;
  }
}

function goHome() {
  S.room = null;
  S.activeStripId = null;
  S.myStripId = null;
  S.pdcStripId = null;
  showHome();
}

// ── Modals ─────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('.modal-backdrop').forEach(b => {
  b.addEventListener('click', e => { if (e.target === b) b.classList.remove('open'); });
});

// ── Create room (ATC) ──────────────────────────────────────
async function createRoom() {
  const name = document.getElementById('c-name').value.trim();
  const airport = document.getElementById('c-airport').value.trim().toUpperCase();
  const err = document.getElementById('create-error');
  if (!name) { err.textContent = 'Event name required.'; return; }
  err.textContent = '';
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventName: name, airport })
  });
  const data = await res.json();
  if (data.error) { err.textContent = data.error; return; }
  closeModal('create-modal');
  joinRoomSocket(data.roomId);
}

// ── Join room ──────────────────────────────────────────────
function joinRoom() {
  const code = document.getElementById('j-code').value.trim().toUpperCase();
  const err = document.getElementById('join-error');
  if (!code || code.length < 4) { err.textContent = 'Enter a valid room code.'; return; }
  err.textContent = '';
  closeModal('join-modal');
  joinRoomSocket(code);
}

function joinRoomSocket(roomId) {
  socket.emit('room:join', { roomId, userId: S.user.id });
}

// ── Socket: joined ─────────────────────────────────────────
socket.on('room:joined', (room) => {
  S.room = room;
  if (S.user.role === 'atc') launchATCBoard(room);
  else launchPilotACARs(room);
});

socket.on('room:error', ({ message }) => {
  document.getElementById('join-error').textContent = message;
  openModal('join-modal');
});

socket.on('room:update', (room) => {
  S.room = room;
  if (S.user.role === 'atc') {
    renderStrips(room.strips);
    updateATCStats(room);
    if (room.atis) renderATISBanner(room.atis);
  } else {
    updatePilotStats(room);
    if (room.atis) renderPilotATIS(room.atis);
    // Check if my strip got a PDC
    if (S.myStripId) {
      const strip = room.strips.find(s => s.id === S.myStripId);
      if (strip?.pdcStatus === 'issued' && strip.clearance) {
        showClearance(strip);
      }
    }
  }
});

socket.on('room:message', ({ text }) => {
  if (S.user.role === 'atc') toast('atc-toast', text);
  else {
    toast('pilot-toast', text);
    addPilotMessage(text);
  }
});

// ── ATC BOARD ──────────────────────────────────────────────
function launchATCBoard(room) {
  show('screen-atc');
  document.getElementById('atc-event-name').textContent = room.eventName + (room.airport ? ` — ${room.airport}` : '');
  document.getElementById('atc-room-code').textContent = room.id;
  renderStrips(room.strips);
  updateATCStats(room);
  if (room.atis) renderATISBanner(room.atis);
}

function updateATCStats(room) {
  document.getElementById('atc-stat-total').textContent = room.strips.length;
  document.getElementById('atc-stat-conn').textContent = room.connectedCount || 1;
  const pending = room.strips.filter(s => s.pdcStatus === 'pending');
  const pill = document.getElementById('atc-pdc-pill');
  if (pending.length > 0) {
    pill.style.display = 'flex';
    document.getElementById('atc-pdc-count').textContent = pending.length;
  } else {
    pill.style.display = 'none';
  }
}

const STATUSES = [
  { key: 'registered', label: 'Registered', color: '#6b7280' },
  { key: 'departing',  label: 'Departing',  color: '#3b82f6' },
  { key: 'enroute',    label: 'En Route',   color: '#22c55e' },
  { key: 'arrived',    label: 'Arrived',    color: '#a855f7' }
];

function utcTime(ts) {
  return new Date(ts).toISOString().slice(11, 16) + 'z';
}

function renderStrips(strips) {
  STATUSES.forEach(({ key }) => {
    const el = document.getElementById('strips-' + key);
    if (!el) return;
    const lane = strips.filter(s => s.status === key);
    document.getElementById('cnt-' + key).textContent = lane.length;
    if (!lane.length) { el.innerHTML = '<div class="strip-empty">No flights</div>'; return; }
    el.innerHTML = lane.map(buildStrip).join('');
  });
  document.querySelectorAll('.strip').forEach(el => {
    el.addEventListener('click', () => openDetail(el.dataset.id));
  });
}

function buildStrip(f) {
  const pdcClass = f.pdcStatus === 'pending' ? ' pdc-pending' : '';
  const rulesClass = (f.flightRules || 'IFR').toLowerCase();
  const sqTag = f.squawk ? `<span class="s-tag s-sq">SQ ${f.squawk}</span>` : '';
  const pdcTag = f.pdcStatus === 'pending' ? `<span class="s-tag s-pdc">PDC</span>` : '';
  return `
    <div class="strip${pdcClass}" data-id="${f.id}" data-status="${f.status}">
      <div class="s-row1">
        <span class="s-cs">${f.callsign}</span>
        <span class="s-ac">${f.actype}</span>
        <span class="s-rules ${rulesClass}">${f.flightRules || 'IFR'}</span>
        <span class="s-va">${f.va || '—'}</span>
      </div>
      <div class="s-row2">
        <span>${f.orig}</span><span class="s-arr">→</span><span>${f.dest}</span>
        ${f.gate ? `<span style="margin-left:auto;font-size:10px;color:var(--text3)">${f.gate}</span>` : ''}
      </div>
      <div class="s-row3">
        ${f.fl ? `<span class="s-tag">${f.fl}</span>` : ''}
        ${sqTag}${pdcTag}
        ${f.sid ? `<span class="s-tag">${f.sid}</span>` : ''}
        <span class="s-pilot">${f.pilot}</span>
      </div>
    </div>`;
}

// ── ATC: Strip detail ──────────────────────────────────────
function openDetail(stripId) {
  const f = S.room?.strips.find(s => s.id === stripId);
  if (!f) return;
  S.activeStripId = stripId;
  document.getElementById('d-cs-header').textContent = f.callsign;

  const body = document.getElementById('detail-body');
  body.innerHTML = `
    <div class="detail-cs">${f.callsign}</div>
    <div class="detail-sub">${f.orig} → ${f.dest} · ${f.flightRules} · ${utcTime(f.addedAt)}</div>
    ${f.squawk ? `<div class="squawk-display">${f.squawk}</div>` : ''}
    <div class="detail-grid">
      <div class="detail-item"><label>Aircraft</label><span>${f.actype}</span></div>
      <div class="detail-item"><label>VA</label><span>${f.va || '—'}</span></div>
      <div class="detail-item"><label>Gate</label><span>${f.gate || '—'}</span></div>
      <div class="detail-item"><label>FL</label><span>${f.fl || '—'}</span></div>
      <div class="detail-item"><label>Pilot</label><span>${f.pilot}</span></div>
      <div class="detail-item"><label>PDC</label><span style="text-transform:capitalize;color:${f.pdcStatus==='issued'?'#4ade80':f.pdcStatus==='pending'?'#fbbf24':'var(--text2)'}">${f.pdcStatus}</span></div>
      ${f.sid ? `<div class="detail-item"><label>SID</label><span>${f.sid}</span></div>` : ''}
      ${f.star ? `<div class="detail-item"><label>STAR</label><span>${f.star}</span></div>` : ''}
      ${f.route ? `<div class="detail-item" style="grid-column:span 2"><label>Route</label><span style="font-family:'JetBrains Mono',monospace;font-size:11px">${f.route}</span></div>` : ''}
    </div>
    ${f.pdcStatus === 'pending' ? `<div class="pdc-alert">⚠️ Pilot requesting PDC clearance</div><button class="btn-primary" style="margin-bottom:8px" onclick="openPDCPanel('${f.id}')">Issue PDC Clearance</button>` : ''}
    <div class="section-label">Move to status</div>
    <div class="status-btn-list">
      ${STATUSES.map(s => `
        <button class="status-btn ${f.status===s.key?'current':''}" onclick="moveStrip('${s.key}')">
          <span class="s-dot-sm" style="background:${s.color}"></span>${s.label}
        </button>`).join('')}
    </div>
    <div class="section-label">Squawk</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <input id="d-sq-input" class="mono" style="flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px" maxlength="4" placeholder="0000" value="${f.squawk||''}">
      <button onclick="assignSquawk()" style="padding:7px 12px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">Assign</button>
    </div>
    <button class="btn-danger" onclick="removeStrip()">Remove strip</button>
  `;
  openPanel('detail-panel');
}

function moveStrip(status) {
  socket.emit('strip:update', { roomId: S.room.id, stripId: S.activeStripId, changes: { status } });
  closePanel('detail-panel');
  toast('atc-toast', `Moved to ${status}`);
}

function assignSquawk() {
  const sq = document.getElementById('d-sq-input').value.trim();
  if (!sq) return;
  socket.emit('strip:update', { roomId: S.room.id, stripId: S.activeStripId, changes: { squawk: sq } });
  toast('atc-toast', `Squawk ${sq} assigned`);
}

function removeStrip() {
  socket.emit('strip:remove', { roomId: S.room.id, stripId: S.activeStripId });
  closePanel('detail-panel');
  toast('atc-toast', 'Strip removed');
}

// ── ATC: Add strip ─────────────────────────────────────────
function addStrip() {
  const cs = document.getElementById('a-cs').value.trim().toUpperCase();
  if (!cs) { toast('atc-toast', 'Callsign required'); return; }
  socket.emit('strip:add', {
    roomId: S.room.id,
    strip: {
      callsign: cs,
      actype:   document.getElementById('a-ac').value.trim().toUpperCase() || '---',
      va:       document.getElementById('a-va').value.trim(),
      orig:     document.getElementById('a-orig').value.trim().toUpperCase() || '----',
      dest:     document.getElementById('a-dest').value.trim().toUpperCase() || '----',
      gate:     document.getElementById('a-gate').value.trim().toUpperCase(),
      fl:       document.getElementById('a-fl').value.trim().toUpperCase(),
      pilot:    document.getElementById('a-pilot').value.trim() || 'Unknown',
      flightRules: document.getElementById('a-rules').value,
      remarks:  document.getElementById('a-remarks').value.trim()
    }
  });
  ['a-cs','a-ac','a-va','a-orig','a-dest','a-gate','a-fl','a-pilot','a-remarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
  closePanel('add-panel');
  toast('atc-toast', 'Strip added');
}

// ── ATC: PDC panel ─────────────────────────────────────────
function openPDCPanel(stripId) {
  S.pdcStripId = stripId;
  const f = S.room.strips.find(s => s.id === stripId);
  if (!f) return;
  closePanel('detail-panel');
  document.getElementById('pdc-pilot-info').innerHTML = `
    <strong>${f.callsign}</strong>
    ${f.pilot} · ${f.orig} → ${f.dest} · ${f.flightRules}<br>
    Requested FL: ${f.fl || 'N/A'} · Gate: ${f.gate || 'N/A'}
    ${f.route ? `<br>Route: <span style="font-family:'JetBrains Mono',monospace;font-size:11px">${f.route}</span>` : ''}
  `;
  document.getElementById('pdc-fl').value = f.fl || '';
  openPanel('pdc-panel');
}

function issuePDC() {
  if (!S.pdcStripId) return;
  socket.emit('pdc:issue', {
    roomId: S.room.id,
    stripId: S.pdcStripId,
    clearance: {
      squawk:   document.getElementById('pdc-squawk').value.trim() || null,
      sid:      document.getElementById('pdc-sid').value.trim().toUpperCase(),
      star:     document.getElementById('pdc-star').value.trim().toUpperCase(),
      fl:       document.getElementById('pdc-fl').value.trim().toUpperCase(),
      freq:     document.getElementById('pdc-freq').value.trim(),
      remarks:  document.getElementById('pdc-remarks').value.trim()
    }
  });
  ['pdc-squawk','pdc-sid','pdc-star','pdc-fl','pdc-freq','pdc-remarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
  closePanel('pdc-panel');
  toast('atc-toast', 'PDC clearance issued');
}

// ── ATC: ATIS ──────────────────────────────────────────────
function generateATIS() {
  socket.emit('atis:generate', {
    roomId: S.room.id,
    info: {
      wind:    document.getElementById('at-wind').value.trim(),
      qnh:     document.getElementById('at-qnh').value.trim(),
      vis:     document.getElementById('at-vis').value.trim(),
      rwy:     document.getElementById('at-rwy').value.trim().toUpperCase(),
      temp:    document.getElementById('at-temp').value.trim(),
      dew:     document.getElementById('at-dew').value.trim(),
      cloud:   document.getElementById('at-cloud').value.trim(),
      remarks: document.getElementById('at-remarks').value.trim()
    }
  });
  closePanel('atis-panel');
}

function renderATISBanner(atis) {
  const banner = document.getElementById('atis-banner');
  banner.style.display = 'flex';
  document.getElementById('atis-letter').textContent = atis.letter;
  document.getElementById('atis-raw').textContent = atis.raw;
}

// ── PILOT ACARS ────────────────────────────────────────────
function launchPilotACARs(room) {
  show('screen-pilot');
  document.getElementById('pilot-room-code').textContent = room.id;
  document.getElementById('pilot-nav-user').textContent = S.user.username;
  updatePilotStats(room);
  if (room.atis) renderPilotATIS(room.atis);
}

function updatePilotStats(room) {
  document.getElementById('pilot-stat-conn').textContent = room.connectedCount || 1;
}

function renderPilotATIS(atis) {
  document.getElementById('pilot-atis').textContent = atis.raw;
}

function addPilotMessage(text) {
  const feed = document.getElementById('pilot-messages');
  if (!feed) return;
  const div = document.createElement('div');
  div.className = 'msg-item';
  div.textContent = text;
  feed.prepend(div);
}

// Flight rules toggle
function setFlightRules(rules) {
  S.flightRules = rules;
  document.getElementById('btn-ifr').classList.toggle('active', rules === 'IFR');
  document.getElementById('btn-vfr').classList.toggle('active', rules === 'VFR');
}

// File flight plan
function fileFlight() {
  const cs = document.getElementById('p-cs').value.trim().toUpperCase();
  if (!cs) { toast('pilot-toast', 'Callsign required'); return; }

  const plan = {
    callsign: cs,
    actype:   document.getElementById('p-ac').value.trim().toUpperCase() || '---',
    va:       document.getElementById('p-va').value.trim(),
    orig:     document.getElementById('p-orig').value.trim().toUpperCase() || '----',
    dest:     document.getElementById('p-dest').value.trim().toUpperCase() || '----',
    gate:     document.getElementById('p-gate').value.trim().toUpperCase(),
    fl:       document.getElementById('p-fl').value.trim().toUpperCase(),
    flightRules: S.flightRules,
    route:    document.getElementById('p-route').value.trim().toUpperCase(),
    remarks:  document.getElementById('p-remarks').value.trim()
  };

  socket.emit('flightplan:file', { roomId: S.room.id, plan });

  // Show filed info in waiting step
  document.getElementById('pdc-filed-info').innerHTML =
    `CALLSIGN: ${plan.callsign}\nAIRCRAFT: ${plan.actype}\nRULES:    ${plan.flightRules}\n` +
    `ROUTE:    ${plan.orig} → ${plan.dest}\nFL REQ:   ${plan.fl || 'N/A'}\nGATE:     ${plan.gate || 'N/A'}`;

  document.getElementById('step-file').style.display = 'none';
  document.getElementById('step-waiting').style.display = '';
}

socket.on('flightplan:accepted', ({ stripId }) => {
  S.myStripId = stripId;
});

// Listen for clearance pushed to this pilot
socket.on('room:update', (room) => {
  // Already handled above, but double-check clearance
  if (S.myStripId && S.user.role === 'pilot') {
    const strip = room.strips.find(s => s.id === S.myStripId);
    if (strip?.pdcStatus === 'issued' && strip.clearance) {
      showClearance(strip);
    }
  }
});

function showClearance(strip) {
  if (document.getElementById('step-clearance').style.display !== 'none') return; // already shown
  document.getElementById('step-waiting').style.display = 'none';
  document.getElementById('step-clearance').style.display = '';

  S.atcIdForRating = strip.clearance.issuedByDiscordId || null;

  document.getElementById('clearance-block').innerHTML = `
    <div class="cl-row"><span class="cl-k">CALLSIGN</span><span class="cl-v">${strip.callsign}</span></div>
    <div class="cl-row"><span class="cl-k">SQUAWK</span><span class="cl-v sq">${strip.squawk}</span></div>
    <div class="cl-row"><span class="cl-k">FLIGHT RULES</span><span class="cl-v">${strip.flightRules}</span></div>
    <div class="cl-row"><span class="cl-k">CLEARED TO</span><span class="cl-v">${strip.dest}</span></div>
    <div class="cl-row"><span class="cl-k">CLEARED FL</span><span class="cl-v green">${strip.clearance.fl || strip.fl}</span></div>
    ${strip.clearance.sid ? `<div class="cl-row"><span class="cl-k">SID</span><span class="cl-v green">${strip.clearance.sid}</span></div>` : ''}
    ${strip.clearance.star ? `<div class="cl-row"><span class="cl-k">STAR</span><span class="cl-v">${strip.clearance.star}</span></div>` : ''}
    ${strip.clearance.freq ? `<div class="cl-row"><span class="cl-k">FREQ</span><span class="cl-v">${strip.clearance.freq}</span></div>` : ''}
    ${strip.clearance.remarks ? `<div class="cl-row"><span class="cl-k">REMARKS</span><span class="cl-v" style="font-size:11px;text-align:right;max-width:160px">${strip.clearance.remarks}</span></div>` : ''}
    <div class="cl-row"><span class="cl-k">ISSUED BY</span><span class="cl-v">${strip.clearance.issuedBy}</span></div>
  `;

  toast('pilot-toast', `✅ PDC received — Squawk ${strip.squawk}`);
}

// ── Pilot: rate ATC ────────────────────────────────────────
function showRatePanel() {
  openPanel('rate-panel');
  // Star interactions
  document.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', () => {
      S.starRating = parseInt(star.dataset.v);
      document.querySelectorAll('.star').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.v) <= S.starRating);
      });
    });
  });
}

function submitRating() {
  if (!S.starRating) { toast('pilot-toast', 'Pick a star rating'); return; }
  socket.emit('atc:rate', {
    atcId: S.atcIdForRating || 'unknown',
    stars: S.starRating,
    comment: document.getElementById('rate-comment').value.trim()
  });
  closePanel('rate-panel');
  toast('pilot-toast', 'Rating submitted — thanks!');
}

socket.on('atc:rated', () => toast('pilot-toast', 'Rating saved'));

// ── Panels ─────────────────────────────────────────────────
function openPanel(id) {
  document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
  document.getElementById(id).classList.add('open');
}
function closePanel(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'detail-panel') S.activeStripId = null;
  if (id === 'pdc-panel') S.pdcStripId = null;
}

// ── Toast ──────────────────────────────────────────────────
function toast(elId, msg) {
  const t = document.getElementById(elId);
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Keyboard ───────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.side-panel.open').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  }
  if (e.key === 'n' && !e.target.matches('input,textarea,select') && S.room && S.user.role === 'atc') {
    openPanel('add-panel');
    setTimeout(() => document.getElementById('a-cs')?.focus(), 50);
  }
});