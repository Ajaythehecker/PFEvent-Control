/* ============================================================
   PFEvent Control — client app.js
   ============================================================ */

const socket = io();

const S = {
  user: null, room: null,
  activeStripId: null, pdcStripId: null,
  myStripId: null, flightRules: 'IFR',
  starRating: 0, atcIdForRating: null
};

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    const user = data.user;

    const err = new URLSearchParams(location.search).get('error');
    if (err) {
      const el = document.getElementById('login-error');
      if (el) el.textContent = err === 'auth_failed' ? 'Discord login failed. Try again.' : 'Error: ' + err;
    }

    if (!user) { show('screen-login'); return; }
    S.user = user;
    if (!user.role) { show('screen-role'); renderNavUser('nav-user-role'); }
    else showHome();
  } catch (e) {
    show('screen-login');
    const el = document.getElementById('login-error');
    if (el) el.textContent = 'Failed to connect to server. Try refreshing.';
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// ── Helpers ────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = '';
}

function renderNavUser(elId) {
  const el = document.getElementById(elId);
  if (el && S.user) el.textContent = S.user.username;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── Role ───────────────────────────────────────────────────
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

// ── Home ───────────────────────────────────────────────────
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
  S.room = null; S.activeStripId = null;
  S.myStripId = null; S.pdcStripId = null;
  showHome();
}

// ── Modals ─────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('.modal-backdrop').forEach(b => {
  b.addEventListener('click', e => { if (e.target === b) b.classList.remove('open'); });
});

// ── Create / Join ──────────────────────────────────────────
async function createRoom() {
  const name    = document.getElementById('c-name').value.trim();
  const airport = document.getElementById('c-airport').value.trim().toUpperCase();
  const err     = document.getElementById('create-error');
  if (!name) { err.textContent = 'Event name required.'; return; }
  err.textContent = '';
  const res  = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventName: name, airport })
  });
  const data = await res.json();
  if (data.error) { err.textContent = data.error; return; }
  closeModal('create-modal');
  joinRoomSocket(data.roomId);
}

function joinRoom() {
  const code = document.getElementById('j-code').value.trim().toUpperCase();
  const err  = document.getElementById('join-error');
  if (!code || code.length < 4) { err.textContent = 'Enter a valid room code.'; return; }
  err.textContent = '';
  closeModal('join-modal');
  joinRoomSocket(code);
}

function joinRoomSocket(roomId) {
  socket.emit('room:join', { roomId, userId: S.user.id });
}

// ── Socket events ──────────────────────────────────────────
socket.on('room:joined', (room) => {
  S.room = room;
  if (S.user.role === 'atc') launchATCBoard(room);
  else launchPilotACARs(room);
});

socket.on('room:error', ({ message }) => {
  document.getElementById('join-error').textContent = message;
  openModal('join-modal');
});

// Single room:update handler
socket.on('room:update', (room) => {
  S.room = room;
  if (S.user.role === 'atc') {
    renderStrips(room.strips);
    updateATCStats(room);
    if (room.atis) renderATISBanner(room.atis);
  } else {
    updatePilotStats(room);
    if (room.atis) renderPilotATIS(room.atis);
    if (S.myStripId) {
      const strip = room.strips.find(s => s.id === S.myStripId);
      if (strip?.pdcStatus === 'issued' && strip.clearance) showClearance(strip);
    }
  }
});

socket.on('room:message', ({ text }) => {
  if (S.user?.role === 'atc') toast('atc-toast', text);
  else { toast('pilot-toast', text); addPilotMessage(text); }
});

// ── ATC Board ──────────────────────────────────────────────
function launchATCBoard(room) {
  show('screen-atc');
  document.getElementById('atc-event-name').textContent = room.eventName + (room.airport ? ` — ${room.airport}` : '');
  document.getElementById('atc-room-code').textContent  = room.id;
  renderStrips(room.strips);
  updateATCStats(room);
  if (room.atis) renderATISBanner(room.atis);
}

function updateATCStats(room) {
  document.getElementById('atc-stat-total').textContent = room.strips.length;
  document.getElementById('atc-stat-conn').textContent  = room.connectedCount || 1;
  const pending = room.strips.filter(s => s.pdcStatus === 'pending');
  const pill    = document.getElementById('atc-pdc-pill');
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
    const el   = document.getElementById('strips-' + key);
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
  const pdcClass  = f.pdcStatus === 'pending' ? ' pdc-pending' : '';
  const rulesClass = (f.flightRules || 'IFR').toLowerCase();
  const sqTag  = f.squawk    ? `<span class="s-tag s-sq">SQ ${f.squawk}</span>` : '';
  const pdcTag = f.pdcStatus === 'pending' ? `<span class="s-tag s-pdc">PDC</span>` : '';
  return `
    <div class="strip${pdcClass}" data-id="${f.id}" data-status="${f.status}">
      <div class="s-row1">
        <span class="s-cs">${esc(f.callsign)}</span>
        <span class="s-ac">${esc(f.actype)}</span>
        <span class="s-rules ${rulesClass}">${esc(f.flightRules || 'IFR')}</span>
        <span class="s-va">${esc(f.va || '—')}</span>
      </div>
      <div class="s-row2">
        <span>${esc(f.orig)}</span><span class="s-arr">→</span><span>${esc(f.dest)}</span>
        ${f.gate ? `<span style="margin-left:auto;font-size:10px;color:var(--text3)">${esc(f.gate)}</span>` : ''}
      </div>
      <div class="s-row3">
        ${f.fl ? `<span class="s-tag">${esc(f.fl)}</span>` : ''}
        ${sqTag}${pdcTag}
        ${f.sid ? `<span class="s-tag">${esc(f.sid)}</span>` : ''}
        <span class="s-pilot">${esc(f.pilot)}</span>
      </div>
    </div>`;
}

// ── Strip detail panel ─────────────────────────────────────
function openDetail(stripId) {
  const f = S.room?.strips.find(s => s.id === stripId);
  if (!f) return;
  S.activeStripId = stripId;
  document.getElementById('d-cs-header').textContent = f.callsign;

  const body = document.getElementById('detail-body');
  body.innerHTML = `
    <div class="detail-cs">${esc(f.callsign)}</div>
    <div class="detail-sub">${esc(f.orig)} → ${esc(f.dest)} · ${esc(f.flightRules)} · ${utcTime(f.addedAt)}</div>
    ${f.squawk ? `<div class="squawk-display">${esc(f.squawk)}</div>` : ''}
    <div class="detail-grid">
      <div class="detail-item"><label>Aircraft</label><span>${esc(f.actype)}</span></div>
      <div class="detail-item"><label>VA</label><span>${esc(f.va || '—')}</span></div>
      <div class="detail-item"><label>Gate</label><span>${esc(f.gate || '—')}</span></div>
      <div class="detail-item"><label>FL</label><span>${esc(f.fl || '—')}</span></div>
      <div class="detail-item"><label>Pilot</label><span>${esc(f.pilot)}</span></div>
      <div class="detail-item"><label>PDC</label><span style="text-transform:capitalize;color:${f.pdcStatus==='issued'?'#4ade80':f.pdcStatus==='pending'?'#fbbf24':'var(--text2)'}">${esc(f.pdcStatus)}</span></div>
      ${f.sid  ? `<div class="detail-item"><label>SID</label><span>${esc(f.sid)}</span></div>`  : ''}
      ${f.star ? `<div class="detail-item"><label>STAR</label><span>${esc(f.star)}</span></div>` : ''}
      ${f.route ? `<div class="detail-item" style="grid-column:span 2"><label>Route</label><span style="font-family:'JetBrains Mono',monospace;font-size:11px">${esc(f.route)}</span></div>` : ''}
    </div>
    ${f.pdcStatus === 'pending' ? `<div class="pdc-alert">⚠️ Pilot requesting PDC clearance</div><button class="btn-primary" style="margin-bottom:8px" onclick="openPDCPanel('${f.id}')">Issue PDC Clearance</button>` : ''}
    <div class="section-label">Move to status</div>
    <div class="status-btn-list">
      ${STATUSES.map(s => `
        <button class="status-btn ${f.status===s.key?'current':''}" onclick="moveStrip('${s.key}')">
          <span class="s-dot-sm" style="background:${s.color}"></span>${esc(s.label)}
        </button>`).join('')}
    </div>
    <div class="section-label">Squawk</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <input id="d-sq-input" class="mono" style="flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px" maxlength="4" placeholder="0000" value="${esc(f.squawk||'')}">
      <button onclick="assignSquawk()" style="padding:7px 12px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">Assign</button>
    </div>
    <button class="btn-danger" onclick="removeStrip()">Remove strip</button>
  `;
  openPanel('detail-panel');
}

// Move strip to a new status
function moveStrip(newStatus) {
  if (!S.activeStripId || !S.room) return;
  socket.emit('strip:update', {
    roomId:  S.room.id,
    stripId: S.activeStripId,
    changes: { status: newStatus }
  });
}

// Assign squawk from detail panel input
function assignSquawk() {
  const val = document.getElementById('d-sq-input')?.value.trim();
  if (!val || !S.activeStripId || !S.room) return;
  socket.emit('strip:update', {
    roomId:  S.room.id,
    stripId: S.activeStripId,
    changes: { squawk: val }
  });
  toast('atc-toast', `Squawk ${val} assigned`);
}

function removeStrip() {
  if (!S.activeStripId || !S.room) return;
  socket.emit('strip:remove', { roomId: S.room.id, stripId: S.activeStripId });
  closePanel('detail-panel');
}

// ── Add strip ──────────────────────────────────────────────
function addStrip() {
  const cs = document.getElementById('a-cs').value.trim().toUpperCase();
  if (!cs) { toast('atc-toast', 'Callsign required'); return; }
  socket.emit('strip:add', {
    roomId: S.room.id,
    strip: {
      callsign:    cs,
      actype:      document.getElementById('a-ac').value.trim().toUpperCase() || '---',
      va:          document.getElementById('a-va').value.trim(),
      orig:        document.getElementById('a-orig').value.trim().toUpperCase() || '----',
      dest:        document.getElementById('a-dest').value.trim().toUpperCase() || '----',
      gate:        document.getElementById('a-gate').value.trim().toUpperCase(),
      fl:          document.getElementById('a-fl').value.trim().toUpperCase(),
      pilot:       document.getElementById('a-pilot').value.trim() || 'Unknown',
      flightRules: document.getElementById('a-rules').value,
      remarks:     document.getElementById('a-remarks').value.trim()
    }
  });
  ['a-cs','a-ac','a-va','a-orig','a-dest','a-gate','a-fl','a-pilot','a-remarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
  closePanel('add-panel');
  toast('atc-toast', 'Strip added');
}

// ── PDC panel ──────────────────────────────────────────────
function openPDCPanel(stripId) {
  S.pdcStripId = stripId;
  const f = S.room.strips.find(s => s.id === stripId);
  if (!f) return;
  closePanel('detail-panel');
  document.getElementById('pdc-pilot-info').innerHTML = `
    <strong>${esc(f.callsign)}</strong>
    ${esc(f.pilot)} · ${esc(f.orig)} → ${esc(f.dest)} · ${esc(f.flightRules)}<br>
    Requested FL: ${esc(f.fl || 'N/A')} · Gate: ${esc(f.gate || 'N/A')}
    ${f.route ? `<br>Route: <span style="font-family:'JetBrains Mono',monospace;font-size:11px">${esc(f.route)}</span>` : ''}
  `;
  document.getElementById('pdc-fl').value = f.fl || '';
  openPanel('pdc-panel');
}

function issuePDC() {
  if (!S.pdcStripId) return;
  socket.emit('pdc:issue', {
    roomId:  S.room.id,
    stripId: S.pdcStripId,
    clearance: {
      squawk:  document.getElementById('pdc-squawk').value.trim() || null,
      sid:     document.getElementById('pdc-sid').value.trim().toUpperCase(),
      star:    document.getElementById('pdc-star').value.trim().toUpperCase(),
      fl:      document.getElementById('pdc-fl').value.trim().toUpperCase(),
      freq:    document.getElementById('pdc-freq').value.trim(),
      remarks: document.getElementById('pdc-remarks').value.trim()
    }
  });
  ['pdc-squawk','pdc-sid','pdc-star','pdc-fl','pdc-freq','pdc-remarks'].forEach(id => {
    document.getElementById(id).value = '';
  });
  closePanel('pdc-panel');
  toast('atc-toast', 'PDC clearance issued');
}

// ── ATIS ───────────────────────────────────────────────────
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
  document.getElementById('atis-raw').textContent    = atis.raw;
}

// ── Pilot ACARS ────────────────────────────────────────────
function launchPilotACARs(room) {
  show('screen-pilot');
  const titleEl = document.getElementById('acars-callsign-title');
  if (titleEl) titleEl.textContent = 'ACARS TERMINAL';
  const airportEl = document.getElementById('pilot-event-airport');
  if (airportEl) airportEl.textContent = room.airport || '---';
  updatePilotStats(room);

  // Boot terminal messages — now safely inside this function so DOM exists
  setTimeout(() => {
    termLine('DO NOT CLOSE THIS WINDOW. CONTROLLERS MAY SEND PRE DEPARTURE CLEARANCES THROUGH THE ACARS TERMINAL', 'red');
    termLine('System ready. File a flight plan to begin.', 'dim');
  }, 300);

  // Star rating listeners
  document.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', () => {
      S.starRating = parseInt(star.dataset.v);
      document.querySelectorAll('.star').forEach(s => {
        s.classList.toggle('active', parseInt(s.dataset.v) <= S.starRating);
      });
    });
  });
}

// ── Secure terminal line helper ────────────────────────────
function termLine(msg, color='', source='[SYSTEM]', sourceClass='system') {
  const term = document.getElementById('acars-terminal');
  if (!term) return;
  const now  = new Date().toISOString().slice(11, 16) + 'Z';
  const line = document.createElement('div');
  line.className = 'term-line';

  const timeSpan = document.createElement('span');
  timeSpan.className   = 'term-time';
  timeSpan.textContent = now;

  const sourceSpan = document.createElement('span');
  sourceSpan.className   = `term-source ${sourceClass}`;
  sourceSpan.textContent = `${source}:`;

  const msgSpan = document.createElement('span');
  msgSpan.className   = `term-msg ${color}`;
  msgSpan.textContent = msg;

  line.appendChild(timeSpan);
  line.appendChild(sourceSpan);
  line.appendChild(msgSpan);
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

function updatePilotStats(room) {
  const el = document.getElementById('pilot-stat-conn');
  if (el) el.textContent = room.connectedCount || 1;
  renderControllers(room);
  if (room.atis) renderPilotATIS(room.atis);
}

function renderControllers(room) {
  const el = document.getElementById('controllers-list');
  if (!el) return;
  if (room.airport) {
    el.innerHTML = `
      <div class="controller-item">
        <span class="ctrl-airport">${esc(room.airport)}</span>
        <img class="ctrl-avatar" src="https://cdn.discordapp.com/embed/avatars/0.png" alt="">
        <div class="ctrl-info">
          <div class="ctrl-name">Event ATC</div>
          <div class="ctrl-pos">APP</div>
        </div>
      </div>`;
  } else {
    el.innerHTML = '<div class="alp-empty">No controllers online</div>';
  }
}

function renderPilotATIS(atis) {
  const list = document.getElementById('atis-list');
  if (!list) return;
  list.innerHTML = `
    <div class="atis-item">
      <div class="atis-airport">${esc(S.room?.airport || 'EVENT')} ATIS ${esc(atis.letter)}</div>
      <div class="atis-text">${esc(atis.raw)}</div>
    </div>`;
}

function addPilotMessage(text) {
  termLine(text, 'cyan', '[MSG]', 'atc');
}

// Flight rules toggle
function setFlightRules(rules) {
  S.flightRules = rules;
  document.getElementById('btn-ifr').classList.toggle('active', rules === 'IFR');
  document.getElementById('btn-vfr').classList.toggle('active', rules === 'VFR');
}

function openFilingModal() { openModal('filing-modal'); }

// File flight plan
function fileFlight() {
  const cs = document.getElementById('p-cs').value.trim().toUpperCase();
  if (!cs) { toast('pilot-toast', 'Callsign required'); return; }

  const plan = {
    callsign:    cs,
    actype:      document.getElementById('p-ac').value.trim().toUpperCase() || '---',
    va:          document.getElementById('p-va').value.trim(),
    orig:        document.getElementById('p-orig').value.trim().toUpperCase() || '----',
    dest:        document.getElementById('p-dest').value.trim().toUpperCase() || '----',
    gate:        document.getElementById('p-gate').value.trim().toUpperCase(),
    fl:          document.getElementById('p-fl').value.trim().toUpperCase(),
    flightRules: S.flightRules,
    route:       document.getElementById('p-route').value.trim().toUpperCase(),
    runway:      document.getElementById('p-rwy').value.trim().toUpperCase(),
    remarks:     document.getElementById('p-remarks').value.trim()
  };

  closeModal('filing-modal');
  socket.emit('flightplan:file', { roomId: S.room.id, plan });

  document.getElementById('acars-callsign-title').textContent = cs + ' ACARS';

  termLine('FLIGHT PLAN DETAILS,', 'white');
  termLine(`    CALLSIGN: ${plan.callsign} (${plan.va || 'Independent'}),`, 'white');
  termLine(`    TYPE: ${plan.actype},`, 'white');
  termLine(`    RULES: ${plan.flightRules},`, 'white');
  termLine(`    STAND: ${plan.gate || 'N/A'},`, 'white');
  if (plan.runway) termLine(`    RUNWAY: ${plan.runway},`, 'white');
  termLine(`    DEPARTING: ${plan.orig},`, 'white');
  termLine(`    ARRIVING: ${plan.dest}`, 'white');
  if (plan.route) termLine(`    ROUTE: ${plan.route}`, 'white');
  if (plan.fl)    termLine(`    CRUISING FL: ${plan.fl}`, 'white');
  termLine(`FLIGHT PLAN: ${plan.callsign} SUBMITTED SUCCESSFULLY`, 'green');

  document.getElementById('acars-preflight-bar').style.display = 'none';
  document.getElementById('acars-pdc-bar').style.display       = 'flex';

  renderFlightNotes(plan);
}

function renderFlightNotes(plan) {
  const el = document.getElementById('flight-notes');
  if (!el) return;
  el.innerHTML = `
    <div class="fn-row"><div class="fn-key">Callsign</div><div class="fn-val">${esc(plan.callsign)}${plan.va ? ' ('+esc(plan.va)+')' : ''}</div></div>
    <div class="fn-row"><div class="fn-key">Aircraft</div><div class="fn-val">${esc(plan.actype)}</div></div>
    <div class="fn-row"><div class="fn-key">Flight Type</div><div class="fn-val">${esc(plan.flightRules)}</div></div>
    <div class="fn-divider"></div>
    <div class="fn-row"><div class="fn-key">Departure</div><div class="fn-val">${esc(plan.orig)}</div></div>
    <div class="fn-row"><div class="fn-key">Arrival</div><div class="fn-val">${esc(plan.dest)}</div></div>
    ${plan.gate   ? `<div class="fn-row"><div class="fn-key">Stand</div><div class="fn-val">${esc(plan.gate)}</div></div>` : ''}
    ${plan.runway ? `<div class="fn-row"><div class="fn-key">Runway</div><div class="fn-val">${esc(plan.runway)}</div></div>` : ''}
    ${plan.fl     ? `<div class="fn-row"><div class="fn-key">Cruising FL</div><div class="fn-val">${esc(plan.fl)}</div></div>` : ''}
    ${plan.route  ? `<div class="fn-row"><div class="fn-key">Route</div><div class="fn-val" style="font-size:10px">${esc(plan.route)}</div></div>` : ''}
    <div class="fn-divider"></div>
    <div class="fn-row"><div class="fn-key">Notes</div><textarea class="fn-notes-area" rows="4" placeholder="Add personal notes..."></textarea></div>
  `;
}

function requestPDC() {
  if (!S.myStripId) { toast('pilot-toast', 'Flight plan not filed yet'); return; }
  socket.emit('pdc:request', { roomId: S.room.id, stripId: S.myStripId });
  termLine('PRE-DEPARTURE CLEARANCE REQUESTED. STANDBY...', 'yellow');
}

socket.on('flightplan:accepted', ({ stripId }) => {
  S.myStripId = stripId;
});

let clearanceShown = false;
function showClearance(strip) {
  if (clearanceShown) return;
  clearanceShown = true;
  S.atcIdForRating = strip.clearance.issuedByDiscordId || null;

  termLine('═══════════════════════════════════════════════', 'dim');
  termLine('PRE-DEPARTURE CLEARANCE', 'green');
  termLine('═══════════════════════════════════════════════', 'dim');
  termLine(`CALLSIGN: ${strip.callsign}`, 'white');
  termLine(`SQUAWK: ${strip.squawk}`, 'green');
  termLine(`FLIGHT RULES: ${strip.flightRules}`, 'white');
  termLine(`CLEARED TO: ${strip.dest}`, 'white');
  termLine(`CLEARED FL: ${strip.clearance.fl || strip.fl}`, 'green');
  if (strip.clearance.sid)     termLine(`SID: ${strip.clearance.sid}`, 'white');
  if (strip.clearance.star)    termLine(`STAR: ${strip.clearance.star}`, 'white');
  if (strip.clearance.freq)    termLine(`FREQUENCY: ${strip.clearance.freq}`, 'white');
  if (strip.clearance.remarks) termLine(`REMARKS: ${strip.clearance.remarks}`, 'yellow');
  termLine(`ISSUED BY: ${strip.clearance.issuedBy}`, 'dim');
  termLine('═══════════════════════════════════════════════', 'dim');

  const fn = document.getElementById('flight-notes');
  if (fn) {
    const sqRow = document.createElement('div');
    sqRow.className = 'fn-row';
    sqRow.innerHTML = `<div class="fn-key">Squawk</div><div class="fn-val highlight">${esc(strip.squawk)}</div>`;
    fn.insertBefore(sqRow, fn.firstChild);
    if (strip.clearance.sid) {
      const sidRow = document.createElement('div');
      sidRow.className = 'fn-row';
      sidRow.innerHTML = `<div class="fn-key">SID</div><div class="fn-val accent">${esc(strip.clearance.sid)}</div>`;
      fn.insertBefore(sidRow, fn.children[1]);
    }
  }

  document.getElementById('acars-pdc-bar').style.display  = 'none';
  document.getElementById('acars-post-bar').style.display = 'flex';
  toast('pilot-toast', `✅ PDC received — Squawk ${strip.squawk}`);
}

// ── Rate ATC ───────────────────────────────────────────────
function showRateModal() { openModal('rate-modal'); }

function submitRating() {
  if (!S.starRating) { toast('pilot-toast', 'Pick a star rating'); return; }
  socket.emit('atc:rate', {
    atcId:   S.atcIdForRating || 'unknown',
    stars:   S.starRating,
    comment: document.getElementById('rate-comment').value.trim()
  });
  closeModal('rate-modal');
  termLine(`Rating submitted: ${S.starRating}★ — Thank you!`, 'green');
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
  if (id === 'pdc-panel')    S.pdcStripId    = null;
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

// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.side-panel.open').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  }
  if (e.key === 'n' && !e.target.matches('input,textarea,select') && S.room && S.user?.role === 'atc') {
    openPanel('add-panel');
    setTimeout(() => document.getElementById('a-cs')?.focus(), 50);
  }
});

// ── Chat ───────────────────────────────────────────────────
function toggleChat() {
  const p = document.getElementById('atc-chat-panel');
  if (p) {
    p.classList.toggle('open');
    document.querySelectorAll('#screen-atc .btn-chat').forEach(b => b.classList.remove('unread'));
  }
}

function togglePilotChat() {
  const p = document.getElementById('pilot-chat-panel');
  if (p) {
    p.classList.toggle('open');
    document.querySelectorAll('#screen-pilot .btn-chat').forEach(b => b.classList.remove('unread'));
  }
}

function sendChat(role) {
  const input = document.getElementById(`${role}-chat-input`);
  const msg   = input.value.trim();
  if (!msg || !S.room) return;
  socket.emit('chat:send', { roomId: S.room.id, message: msg });
  input.value = '';
}

socket.on('chat:receive', (data) => {
  ['atc', 'pilot'].forEach(r => {
    const container = document.getElementById(`${r}-chat-messages`);
    const panel     = document.getElementById(`${r}-chat-panel`);
    const btn       = document.querySelector(`#screen-${r === 'atc' ? 'atc' : 'pilot'} .btn-chat`);
    if (!container) return;

    const isMine = data.userId === S.user?.id;
    const div    = document.createElement('div');
    div.className = `chat-msg ${isMine ? 'mine' : ''}`;
    div.innerHTML = `
      <div class="chat-meta">
        <span class="chat-name">${esc(data.username)}</span>
        <span class="chat-role ${data.role}">${data.role.toUpperCase()}</span>
      </div>
      <div class="chat-bubble">${esc(data.message)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    if (panel && !panel.classList.contains('open') && !isMine) {
      btn?.classList.add('unread');
    }
  });
});

// ── Voice link ─────────────────────────────────────────────
function promptVoiceLink() { openModal('voice-modal'); }

function setVoiceLink() {
  const url = document.getElementById('voice-link-input').value.trim();
  if (!url.includes('discord')) { alert('Please provide a valid Discord link.'); return; }
  socket.emit('voice:set', { roomId: S.room.id, url });
  closeModal('voice-modal');
}

socket.on('voice:update', (url) => {
  if (!url) return;
  document.querySelectorAll('.voice-link-display').forEach(el => el.style.display = 'block');
  document.querySelectorAll('.voice-link-anchor').forEach(a => a.href = url);
  document.getElementById('atc-voice-btn')?.classList.add('active');
  document.getElementById('pilot-voice-btn')?.classList.add('active');
});