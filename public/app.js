/* PFEvent Control — app.js */
'use strict';

const socket = io();

const S = {
  user: null, room: null,
  activeStripId: null, pdcStripId: null,
  myStripId: null, flightRules: 'IFR',
  starRating: 0, atcIdForRating: null,
  clearanceShown: false
};

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Screen management ── */
function show(id) {
  ['screen-login','screen-role','screen-home','screen-atc','screen-pilot'].forEach(sid => {
    const el = document.getElementById(sid);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = id === 'screen-atc' ? 'flex' : 'block';
}

/* ── Boot ── */
async function boot() {
  try {
    const { user } = await fetch('/api/me').then(r => r.json());
    const err = new URLSearchParams(location.search).get('error');
    if (err) {
      const el = document.getElementById('login-error');
      if (el) el.textContent = err === 'auth_failed' ? 'Discord login failed.' : 'Error: ' + err;
    }
    if (!user) { show('screen-login'); return; }
    S.user = user;
    if (!user.role) { show('screen-role'); setNavUser('nav-user-role'); }
    else showHome();
  } catch(e) {
    show('screen-login');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

function setNavUser(id) {
  const el = document.getElementById(id);
  if (el && S.user) el.textContent = S.user.username;
}

/* ── Role ── */
async function selectRole(role) {
  await fetch('/api/me/role', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role}) });
  S.user.role = role;
  showHome();
}
function switchRole() { S.user.role = null; show('screen-role'); setNavUser('nav-user-role'); }

/* ── Home ── */
function showHome() {
  show('screen-home');
  setNavUser('nav-user-home');
  const badge = document.getElementById('nav-role-badge');
  if (badge) { badge.textContent = S.user.role.toUpperCase(); badge.className = 'nav-role-badge ' + S.user.role; }
  const cards = document.getElementById('home-cards');
  if (!cards) return;
  cards.innerHTML = S.user.role === 'atc' ? `
    <div class="home-card" onclick="openModal('create-modal')"><div class="home-card-icon">🗼</div><div class="home-card-title">Create event room</div><div class="home-card-desc">Start a new ATC session</div></div>
    <div class="home-card" onclick="openModal('join-modal')"><div class="home-card-icon">🔑</div><div class="home-card-title">Join room</div><div class="home-card-desc">Join with a room code</div></div>`
  : `<div class="home-card" onclick="openModal('join-modal')"><div class="home-card-icon">✈️</div><div class="home-card-title">Join event</div><div class="home-card-desc">Enter the room code from your organizer</div></div>`;
}

function goHome() {
  S.room = null; S.activeStripId = null; S.myStripId = null;
  S.pdcStripId = null; S.clearanceShown = false;
  showHome();
}

/* ── Modals ── */
function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.querySelectorAll('.modal-backdrop').forEach(b => {
  b.addEventListener('click', e => { if (e.target === b) b.classList.remove('open'); });
});

/* ── Create / Join room ── */
async function createRoom() {
  const name = document.getElementById('c-name').value.trim();
  const airport = document.getElementById('c-airport').value.trim().toUpperCase();
  const err = document.getElementById('create-error');
  if (!name) { err.textContent = 'Event name required.'; return; }
  err.textContent = '';
  const data = await fetch('/api/rooms', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({eventName:name,airport}) }).then(r=>r.json());
  if (data.error) { err.textContent = data.error; return; }
  closeModal('create-modal');
  joinRoomSocket(data.roomId);
}

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

/* ── Socket ── */
socket.on('room:joined', room => {
  S.room = room;
  if (S.user.role === 'atc') launchATC(room);
  else launchPilot(room);
});
socket.on('room:error', ({ message }) => {
  const el = document.getElementById('join-error');
  if (el) el.textContent = message;
  openModal('join-modal');
});
socket.on('room:update', room => {
  S.room = room;
  if (S.user.role === 'atc') { renderStrips(room.strips); updateATCStats(room); if (room.atis) showATISBanner(room.atis); }
  else { updatePilotStats(room); if (room.atis) renderPilotATIS(room.atis); checkClearance(room); }
});
socket.on('room:message', ({ text }) => {
  if (S.user?.role === 'atc') showToast('atc-toast', text);
  else { showToast('pilot-toast', text); addPilotMsg(text); }
});
socket.on('flightplan:accepted', ({ stripId }) => { S.myStripId = stripId; });
socket.on('atc:rated', () => showToast('pilot-toast', 'Rating saved'));

function checkClearance(room) {
  if (!S.myStripId || S.clearanceShown) return;
  const strip = room.strips.find(s => s.id === S.myStripId);
  if (strip?.pdcStatus === 'issued' && strip.clearance) showClearance(strip);
}

/* ══════ ATC BOARD ══════ */
function launchATC(room) {
  show('screen-atc');
  const n = document.getElementById('atc-event-name');
  const c = document.getElementById('atc-room-code');
  if (n) n.textContent = room.eventName + (room.airport ? ' — ' + room.airport : '');
  if (c) c.textContent = room.id;
  renderStrips(room.strips);
  updateATCStats(room);
  if (room.atis) showATISBanner(room.atis);
}

function updateATCStats(room) {
  const t = document.getElementById('atc-stat-total');
  const c = document.getElementById('atc-stat-conn');
  const pill = document.getElementById('atc-pdc-pill');
  const cnt  = document.getElementById('atc-pdc-count');
  if (t) t.textContent = room.strips.length;
  if (c) c.textContent = room.connectedCount || 1;
  const pending = room.strips.filter(s => s.pdcStatus === 'pending').length;
  if (pill) pill.style.display = pending > 0 ? 'flex' : 'none';
  if (cnt)  cnt.textContent = pending;
}

const STATUSES = [
  { key:'registered', label:'Registered', color:'#6b7280' },
  { key:'departing',  label:'Departing',  color:'#3b82f6' },
  { key:'enroute',    label:'En Route',   color:'#22c55e' },
  { key:'arrived',    label:'Arrived',    color:'#a855f7' }
];

function utcTime(ts) { return new Date(ts).toISOString().slice(11,16) + 'z'; }

function renderStrips(strips) {
  STATUSES.forEach(({ key }) => {
    const el  = document.getElementById('strips-' + key);
    const cnt = document.getElementById('cnt-' + key);
    if (!el) return;
    const lane = strips.filter(s => s.status === key);
    if (cnt) cnt.textContent = lane.length;
    el.innerHTML = lane.length ? lane.map(stripHTML).join('') : '<div class="strip-empty">No flights</div>';
  });
  document.querySelectorAll('.strip').forEach(el => el.addEventListener('click', () => openDetail(el.dataset.id)));
}

function stripHTML(f) {
  const pdc = f.pdcStatus === 'pending' ? ' pdc-pending' : '';
  const rules = (f.flightRules||'IFR').toLowerCase();
  return `<div class="strip${pdc}" data-id="${esc(f.id)}" data-status="${esc(f.status)}">
    <div class="s-row1"><span class="s-cs">${esc(f.callsign)}</span><span class="s-ac">${esc(f.actype)}</span><span class="s-rules ${rules}">${esc(f.flightRules||'IFR')}</span><span class="s-va">${esc(f.va||'—')}</span></div>
    <div class="s-row2"><span>${esc(f.orig)}</span><span class="s-arr">→</span><span>${esc(f.dest)}</span>${f.gate?`<span style="margin-left:auto;font-size:10px;color:var(--text3)">${esc(f.gate)}</span>`:''}</div>
    <div class="s-row3">
      ${f.fl?`<span class="s-tag">${esc(f.fl)}</span>`:''}
      ${f.squawk?`<span class="s-tag s-sq">SQ ${esc(f.squawk)}</span>`:''}
      ${f.pdcStatus==='pending'?`<span class="s-tag s-pdc">PDC</span>`:''}
      ${f.sid?`<span class="s-tag">${esc(f.sid)}</span>`:''}
      <span class="s-pilot">${esc(f.pilot)}</span>
    </div>
  </div>`;
}

function openDetail(stripId) {
  const f = S.room?.strips.find(s => s.id === stripId);
  if (!f) return;
  S.activeStripId = stripId;
  const hdr = document.getElementById('d-cs-header');
  if (hdr) hdr.textContent = f.callsign;
  const body = document.getElementById('detail-body');
  if (!body) return;
  body.innerHTML = `
    <div class="detail-cs">${esc(f.callsign)}</div>
    <div class="detail-sub">${esc(f.orig)} → ${esc(f.dest)} · ${esc(f.flightRules)} · ${utcTime(f.addedAt)}</div>
    ${f.squawk?`<div class="squawk-display">${esc(f.squawk)}</div>`:''}
    <div class="detail-grid">
      <div class="detail-item"><label>Aircraft</label><span>${esc(f.actype)}</span></div>
      <div class="detail-item"><label>VA</label><span>${esc(f.va||'—')}</span></div>
      <div class="detail-item"><label>Gate</label><span>${esc(f.gate||'—')}</span></div>
      <div class="detail-item"><label>FL</label><span>${esc(f.fl||'—')}</span></div>
      <div class="detail-item"><label>Pilot</label><span>${esc(f.pilot)}</span></div>
      <div class="detail-item"><label>PDC</label><span style="color:${f.pdcStatus==='issued'?'#4ade80':f.pdcStatus==='pending'?'#fbbf24':'var(--text2)'}">${esc(f.pdcStatus)}</span></div>
      ${f.sid?`<div class="detail-item"><label>SID</label><span>${esc(f.sid)}</span></div>`:''}
      ${f.star?`<div class="detail-item"><label>STAR</label><span>${esc(f.star)}</span></div>`:''}
    </div>
    ${f.pdcStatus==='pending'?`<div class="pdc-alert">⚠️ PDC requested</div><button class="btn-primary" style="margin-bottom:8px" onclick="openPDCPanel('${esc(f.id)}')">Issue PDC Clearance</button>`:''}
    <div class="section-label">Move to status</div>
    <div class="status-btn-list">
      ${STATUSES.map(s=>`<button class="status-btn ${f.status===s.key?'current':''}" onclick="moveStrip('${s.key}')"><span class="s-dot-sm" style="background:${s.color}"></span>${s.label}</button>`).join('')}
    </div>
    <div class="section-label">Squawk</div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <input id="d-sq-input" class="mono" style="flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px" maxlength="4" placeholder="0000" value="${esc(f.squawk||'')}">
      <button onclick="assignSquawk()" style="padding:7px 12px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">Assign</button>
    </div>
    <button class="btn-danger" onclick="removeStrip()">Remove strip</button>`;
  openPanel('detail-panel');
}

function moveStrip(status) { socket.emit('strip:update',{roomId:S.room.id,stripId:S.activeStripId,changes:{status}}); closePanel('detail-panel'); showToast('atc-toast','Moved to '+status); }
function assignSquawk() { const sq=document.getElementById('d-sq-input')?.value.trim(); if(!sq)return; socket.emit('strip:update',{roomId:S.room.id,stripId:S.activeStripId,changes:{squawk:sq}}); showToast('atc-toast','Squawk '+sq+' assigned'); }
function removeStrip() { socket.emit('strip:remove',{roomId:S.room.id,stripId:S.activeStripId}); closePanel('detail-panel'); showToast('atc-toast','Strip removed'); }

function addStrip() {
  const cs = document.getElementById('a-cs')?.value.trim().toUpperCase();
  if (!cs) { showToast('atc-toast','Callsign required'); return; }
  socket.emit('strip:add', { roomId: S.room.id, strip: {
    callsign: cs,
    actype:   document.getElementById('a-ac')?.value.trim().toUpperCase()||'---',
    va:       document.getElementById('a-va')?.value.trim(),
    orig:     document.getElementById('a-orig')?.value.trim().toUpperCase()||'----',
    dest:     document.getElementById('a-dest')?.value.trim().toUpperCase()||'----',
    gate:     document.getElementById('a-gate')?.value.trim().toUpperCase(),
    fl:       document.getElementById('a-fl')?.value.trim().toUpperCase(),
    pilot:    document.getElementById('a-pilot')?.value.trim()||'Unknown',
    flightRules: document.getElementById('a-rules')?.value,
    remarks:  document.getElementById('a-remarks')?.value.trim()
  }});
  ['a-cs','a-ac','a-va','a-orig','a-dest','a-gate','a-fl','a-pilot','a-remarks'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  closePanel('add-panel');
  showToast('atc-toast','Strip added');
}

function openPDCPanel(stripId) {
  S.pdcStripId = stripId;
  const f = S.room.strips.find(s => s.id === stripId);
  if (!f) return;
  closePanel('detail-panel');
  const info = document.getElementById('pdc-pilot-info');
  if (info) info.innerHTML = `<strong>${esc(f.callsign)}</strong><br>${esc(f.pilot)} · ${esc(f.orig)} → ${esc(f.dest)} · ${esc(f.flightRules)}<br>FL: ${esc(f.fl||'N/A')} · Gate: ${esc(f.gate||'N/A')}`;
  const flEl = document.getElementById('pdc-fl');
  if (flEl) flEl.value = f.fl || '';
  openPanel('pdc-panel');
}

function issuePDC() {
  if (!S.pdcStripId) return;
  socket.emit('pdc:issue', { roomId:S.room.id, stripId:S.pdcStripId, clearance: {
    squawk:  document.getElementById('pdc-squawk')?.value.trim()||null,
    sid:     document.getElementById('pdc-sid')?.value.trim().toUpperCase(),
    star:    document.getElementById('pdc-star')?.value.trim().toUpperCase(),
    fl:      document.getElementById('pdc-fl')?.value.trim().toUpperCase(),
    freq:    document.getElementById('pdc-freq')?.value.trim(),
    remarks: document.getElementById('pdc-remarks')?.value.trim()
  }});
  ['pdc-squawk','pdc-sid','pdc-star','pdc-fl','pdc-freq','pdc-remarks'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  closePanel('pdc-panel');
  showToast('atc-toast','PDC issued');
}

function generateATIS() {
  socket.emit('atis:generate', { roomId:S.room.id, info: {
    wind:    document.getElementById('at-wind')?.value.trim(),
    qnh:     document.getElementById('at-qnh')?.value.trim(),
    vis:     document.getElementById('at-vis')?.value.trim(),
    rwy:     document.getElementById('at-rwy')?.value.trim().toUpperCase(),
    temp:    document.getElementById('at-temp')?.value.trim(),
    dew:     document.getElementById('at-dew')?.value.trim(),
    cloud:   document.getElementById('at-cloud')?.value.trim(),
    remarks: document.getElementById('at-remarks')?.value.trim()
  }});
  closePanel('atis-panel');
}

function showATISBanner(atis) {
  const banner = document.getElementById('atis-banner');
  if (!banner) return;
  banner.style.display = 'flex';
  const l = document.getElementById('atis-letter'); if (l) l.textContent = atis.letter;
  const r = document.getElementById('atis-raw');    if (r) r.textContent = atis.raw;
}

/* ══════ PILOT ACARS ══════ */
function launchPilot(room) {
  show('screen-pilot');
  S.clearanceShown = false;
  const codeEl = document.getElementById('pilot-room-code');
  const evtEl  = document.getElementById('pilot-event-name');
  if (codeEl) codeEl.textContent = room.id;
  if (evtEl)  evtEl.textContent  = room.eventName;

  const pre  = document.getElementById('acars-preflight-bar');
  const pdc  = document.getElementById('acars-pdc-bar');
  const post = document.getElementById('acars-post-bar');

  const myStrip = room.strips.find(s => s.pilotId === S.user.id);
  if (myStrip) {
    S.myStripId = myStrip.id;
    const t = document.getElementById('acars-callsign-title');
    if (t) t.textContent = myStrip.callsign + ' ACARS';
    renderFlightNotes(myStrip);
    if (myStrip.pdcStatus === 'issued') {
      if (pre) pre.style.display='none'; if (pdc) pdc.style.display='none'; if (post) post.style.display='flex';
      showClearance(myStrip);
    } else if (myStrip.pdcStatus === 'pending') {
      if (pre) pre.style.display='none'; if (pdc) pdc.style.display='flex'; if (post) post.style.display='none';
    }
  } else {
    if (pre) pre.style.display='flex'; if (pdc) pdc.style.display='none'; if (post) post.style.display='none';
  }

  updatePilotStats(room);
  setTimeout(() => {
    termLine('DO NOT CLOSE THIS WINDOW. CONTROLLERS MAY SEND PRE DEPARTURE CLEARANCES THROUGH THE ACARS TERMINAL', 'red');
    termLine('System ready. File a flight plan to begin.', 'dim');
  }, 200);

  document.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', () => {
      S.starRating = parseInt(star.dataset.v);
      document.querySelectorAll('.star').forEach(s => s.classList.toggle('active', parseInt(s.dataset.v) <= S.starRating));
    });
  });
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
  el.innerHTML = room.airport
    ? `<div class="controller-item"><span class="ctrl-airport">${esc(room.airport)}</span><img class="ctrl-avatar" src="https://cdn.discordapp.com/embed/avatars/0.png" alt=""><div class="ctrl-info"><div class="ctrl-name">Event ATC</div><div class="ctrl-pos">APP</div></div></div>`
    : '<div class="alp-empty">No controllers online</div>';
}

function renderPilotATIS(atis) {
  const el = document.getElementById('atis-list');
  if (!el) return;
  el.innerHTML = `<div class="atis-item"><div class="atis-airport">${esc(S.room?.airport||'EVENT')} ATIS ${esc(atis.letter)}</div><div class="atis-text">${esc(atis.raw)}</div></div>`;
}

function addPilotMsg(text) { termLine(text,'cyan','[MSG]','atc'); }

function termLine(msg, color='', source='[SYSTEM]', sourceClass='system') {
  const term = document.getElementById('acars-terminal');
  if (!term) return;
  const now = new Date().toISOString().slice(11,16)+'Z';
  const line = document.createElement('div'); line.className = 'term-line';
  const t = document.createElement('span'); t.className='term-time';              t.textContent=now;
  const s = document.createElement('span'); s.className=`term-source ${sourceClass}`; s.textContent=source+':';
  const m = document.createElement('span'); m.className=`term-msg ${color}`;     m.textContent=msg;
  line.append(t,s,m); term.appendChild(line); term.scrollTop=term.scrollHeight;
}

function setFlightRules(rules) {
  S.flightRules = rules;
  document.getElementById('btn-ifr')?.classList.toggle('active', rules==='IFR');
  document.getElementById('btn-vfr')?.classList.toggle('active', rules==='VFR');
}

function openFilingModal() { openModal('filing-modal'); }

function fileFlight() {
  const cs = document.getElementById('p-cs')?.value.trim().toUpperCase();
  if (!cs) { showToast('pilot-toast','Callsign required'); return; }
  const plan = {
    callsign: cs,
    actype:   document.getElementById('p-ac')?.value.trim().toUpperCase()||'---',
    va:       document.getElementById('p-va')?.value.trim(),
    orig:     document.getElementById('p-orig')?.value.trim().toUpperCase()||'----',
    dest:     document.getElementById('p-dest')?.value.trim().toUpperCase()||'----',
    gate:     document.getElementById('p-gate')?.value.trim().toUpperCase(),
    fl:       document.getElementById('p-fl')?.value.trim().toUpperCase(),
    flightRules: S.flightRules,
    route:    document.getElementById('p-route')?.value.trim().toUpperCase(),
    runway:   document.getElementById('p-rwy')?.value.trim().toUpperCase(),
    remarks:  document.getElementById('p-remarks')?.value.trim()
  };
  closeModal('filing-modal');
  socket.emit('flightplan:file', { roomId:S.room.id, plan });
  const t = document.getElementById('acars-callsign-title'); if (t) t.textContent = cs+' ACARS';
  termLine('FLIGHT PLAN DETAILS,','white');
  termLine(`    CALLSIGN: ${plan.callsign} (${plan.va||'Independent'}),`,'white');
  termLine(`    TYPE: ${plan.actype},`,'white');
  termLine(`    RULES: ${plan.flightRules},`,'white');
  if (plan.gate)   termLine(`    STAND: ${plan.gate},`,'white');
  if (plan.runway) termLine(`    RUNWAY: ${plan.runway},`,'white');
  termLine(`    DEPARTING: ${plan.orig},`,'white');
  termLine(`    ARRIVING: ${plan.dest}`,'white');
  if (plan.route) termLine(`    ROUTE: ${plan.route}`,'white');
  if (plan.fl)    termLine(`    CRUISING FL: ${plan.fl}`,'white');
  termLine(`FLIGHT PLAN: ${plan.callsign} SUBMITTED SUCCESSFULLY`,'green');
  const pre=document.getElementById('acars-preflight-bar'); if(pre) pre.style.display='none';
  const pdc=document.getElementById('acars-pdc-bar');       if(pdc) pdc.style.display='flex';
  renderFlightNotes(plan);
}

function renderFlightNotes(plan) {
  const el = document.getElementById('flight-notes');
  if (!el) return;
  el.innerHTML = `
    <div class="fn-row"><div class="fn-key">Callsign</div><div class="fn-val">${esc(plan.callsign)}${plan.va?' ('+esc(plan.va)+')':''}</div></div>
    <div class="fn-row"><div class="fn-key">Aircraft</div><div class="fn-val">${esc(plan.actype)}</div></div>
    <div class="fn-row"><div class="fn-key">Flight Type</div><div class="fn-val">${esc(plan.flightRules)}</div></div>
    <div class="fn-divider"></div>
    <div class="fn-row"><div class="fn-key">Departure</div><div class="fn-val">${esc(plan.orig)}</div></div>
    <div class="fn-row"><div class="fn-key">Arrival</div><div class="fn-val">${esc(plan.dest)}</div></div>
    ${plan.gate?`<div class="fn-row"><div class="fn-key">Stand</div><div class="fn-val">${esc(plan.gate)}</div></div>`:''}
    ${plan.runway?`<div class="fn-row"><div class="fn-key">Runway</div><div class="fn-val">${esc(plan.runway)}</div></div>`:''}
    ${plan.fl?`<div class="fn-row"><div class="fn-key">Cruising FL</div><div class="fn-val">${esc(plan.fl)}</div></div>`:''}
    ${plan.route?`<div class="fn-row"><div class="fn-key">Route</div><div class="fn-val" style="font-size:10px">${esc(plan.route)}</div></div>`:''}
    <div class="fn-divider"></div>
    <div class="fn-row"><div class="fn-key">Notes</div><textarea class="fn-notes-area" rows="4" placeholder="Personal notes..."></textarea></div>`;
}

function requestPDC() {
  if (!S.myStripId) { showToast('pilot-toast','File a flight plan first'); return; }
  socket.emit('pdc:request', { roomId:S.room.id, stripId:S.myStripId });
  termLine('PRE-DEPARTURE CLEARANCE REQUESTED. STANDBY...','yellow');
}

function showClearance(strip) {
  if (S.clearanceShown) return;
  S.clearanceShown = true;
  S.atcIdForRating = strip.clearance?.issuedByDiscordId || null;
  termLine('═══════════════════════════════════════════════','dim');
  termLine('PRE-DEPARTURE CLEARANCE','green');
  termLine('═══════════════════════════════════════════════','dim');
  termLine(`CALLSIGN: ${strip.callsign}`,'white');
  termLine(`SQUAWK: ${strip.squawk}`,'green');
  termLine(`FLIGHT RULES: ${strip.flightRules}`,'white');
  termLine(`CLEARED TO: ${strip.dest}`,'white');
  termLine(`CLEARED FL: ${strip.clearance?.fl||strip.fl}`,'green');
  if (strip.clearance?.sid)     termLine(`SID: ${strip.clearance.sid}`,'white');
  if (strip.clearance?.star)    termLine(`STAR: ${strip.clearance.star}`,'white');
  if (strip.clearance?.freq)    termLine(`FREQUENCY: ${strip.clearance.freq}`,'white');
  if (strip.clearance?.remarks) termLine(`REMARKS: ${strip.clearance.remarks}`,'yellow');
  termLine(`ISSUED BY: ${strip.clearance?.issuedBy}`,'dim');
  termLine('═══════════════════════════════════════════════','dim');
  const fn = document.getElementById('flight-notes');
  if (fn && strip.squawk) {
    const sq = document.createElement('div'); sq.className='fn-row';
    sq.innerHTML=`<div class="fn-key">Squawk</div><div class="fn-val highlight">${esc(strip.squawk)}</div>`;
    fn.insertBefore(sq, fn.firstChild);
  }
  const pdc=document.getElementById('acars-pdc-bar');  if(pdc)  pdc.style.display='none';
  const post=document.getElementById('acars-post-bar'); if(post) post.style.display='flex';
  showToast('pilot-toast','✅ PDC received — Squawk '+strip.squawk);
}

function showRateModal() { openModal('rate-modal'); }
function submitRating() {
  if (!S.starRating) { showToast('pilot-toast','Pick a star rating'); return; }
  socket.emit('atc:rate', { atcId:S.atcIdForRating||'unknown', stars:S.starRating, comment:document.getElementById('rate-comment')?.value.trim() });
  closeModal('rate-modal');
  termLine(`Rating submitted: ${S.starRating}★ — Thank you!`,'green');
  showToast('pilot-toast','Rating submitted!');
}

/* ══════ CHAT ══════ */
function toggleChat() { document.getElementById('atc-chat-panel')?.classList.toggle('open'); document.querySelectorAll('.btn-chat').forEach(b=>b.classList.remove('unread')); }
function togglePilotChat() { document.getElementById('pilot-chat-panel')?.classList.toggle('open'); document.querySelectorAll('.btn-chat').forEach(b=>b.classList.remove('unread')); }
function sendChat(role) {
  const input = document.getElementById(`${role}-chat-input`);
  const msg = input?.value.trim();
  if (!msg || !S.room) return;
  socket.emit('chat:send', { roomId:S.room.id, message:msg });
  if (input) input.value='';
}
socket.on('chat:receive', data => {
  ['atc','pilot'].forEach(r => {
    const c = document.getElementById(`${r}-chat-messages`);
    if (!c) return;
    const isMine = data.userId === S.user?.id;
    const div = document.createElement('div'); div.className=`chat-msg ${isMine?'mine':''}`;
    div.innerHTML=`<div class="chat-meta"><span class="chat-name">${esc(data.username)}</span><span class="chat-role ${esc(data.role)}">${esc(data.role?.toUpperCase())}</span></div><div class="chat-bubble">${esc(data.message)}</div>`;
    c.appendChild(div); c.scrollTop=c.scrollHeight;
    const panel=document.getElementById(`${r}-chat-panel`);
    if (!isMine && panel && !panel.classList.contains('open')) document.querySelectorAll('.btn-chat').forEach(b=>b.classList.add('unread'));
  });
});

/* ── Voice ── */
function promptVoiceLink() { openModal('voice-modal'); }
function setVoiceLink() {
  const url = document.getElementById('voice-link-input')?.value.trim();
  if (!url || !url.includes('discord')) { alert('Provide a valid Discord link.'); return; }
  socket.emit('voice:set', { roomId:S.room.id, url });
  closeModal('voice-modal');
}
socket.on('voice:update', url => {
  const d=document.getElementById('voice-link-display'); if(d) d.style.display='block';
  const a=document.getElementById('voice-link-anchor');  if(a&&url) a.href=url;
  document.getElementById('atc-voice-btn')?.classList.add('active');
  document.getElementById('pilot-voice-btn')?.classList.add('active');
});

/* ══════ PANELS / TOAST / KEYBOARD ══════ */
function openPanel(id) { document.querySelectorAll('.side-panel').forEach(p=>p.classList.remove('open')); document.getElementById(id)?.classList.add('open'); }
function closePanel(id) { document.getElementById(id)?.classList.remove('open'); if(id==='detail-panel') S.activeStripId=null; if(id==='pdc-panel') S.pdcStripId=null; }

function showToast(elId, msg) {
  const t = document.getElementById(elId);
  if (!t) return;
  t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),3000);
}

document.addEventListener('keydown', e => {
  if (e.key==='Escape') { document.querySelectorAll('.side-panel.open').forEach(p=>p.classList.remove('open')); document.querySelectorAll('.modal-backdrop.open').forEach(m=>m.classList.remove('open')); }
  if (e.key==='n' && !e.target.matches('input,textarea,select') && S.room && S.user?.role==='atc') { openPanel('add-panel'); setTimeout(()=>document.getElementById('a-cs')?.focus(),50); }
});