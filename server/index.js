const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const fetch   = require('node-fetch');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '1498034089545044049';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '790Oz-Q_ZhPzhYZsopAFwdGskvosz4ag';
const BASE_URL              = process.env.BASE_URL               || 'https://pfevent-control.onrender.com';
const REDIRECT_URI          = BASE_URL + '/auth/discord/callback';
const SESSION_SECRET        = process.env.SESSION_SECRET         || 'pfevent-secret-2025';
const PORT                  = process.env.PORT                   || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory stores ──────────────────────────────────────
const rooms = {};  // roomId -> room object
const users = {};  // discordId -> user object

function getUser(req) {
  if (!req.session.userId) return null;
  if (!users[req.session.userId] && req.session.userData) {
    users[req.session.userId] = req.session.userData;
  }
  return users[req.session.userId] || null;
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit('room:update', room);
}

function squawk() {
  const d = () => Math.floor(Math.random() * 8);
  return `${d()}${d()}${d()}${d()}`;
}

function makeATIS(airport, info) {
  const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
  const time   = new Date().toISOString().slice(11, 16).replace(':', '') + 'Z';
  return {
    letter,
    raw: `${airport} ATIS INFO ${letter} ${time}. WIND ${info.wind || '000/00KT'}. VIS ${info.vis || '10KM'}. ${info.cloud || 'SKY CLEAR'}. TEMP ${info.temp || '25'}/DEW ${info.dew || '15'}. QNH ${info.qnh || '1013'}. RWY IN USE ${info.rwy || '12'}. ${info.remarks || ''} ADVISE ON FIRST CONTACT YOU HAVE INFO ${letter}.`
  };
}

// ── Discord OAuth ─────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: 'identify'
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=' + (error || 'no_code'));
  try {
    const tok = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
    }).then(r => r.json());

    if (!tok.access_token) throw new Error('no token');

    const du = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tok.access_token }
    }).then(r => r.json());

    const user = {
      id: du.id, username: du.username,
      avatar: du.avatar ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png',
      role: null, ratings: []
    };
    users[du.id] = user;
    req.session.userId   = du.id;
    req.session.userData = user;
    req.session.save(err => {
      if (err) return res.redirect('/?error=session_failed');
      res.redirect('/');
    });
  } catch(e) {
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ── API ───────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const user = getUser(req);
  res.json({ user: user || null });
});

app.post('/api/me/role', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const { role } = req.body;
  if (!['pilot', 'atc'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  user.role = role;
  req.session.userData = user;
  req.session.save();
  res.json({ user });
});

app.post('/api/rooms', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.role !== 'atc') return res.status(403).json({ error: 'ATC only' });
  const { eventName, airport } = req.body;
  if (!eventName) return res.status(400).json({ error: 'eventName required' });
  const id = uuidv4().slice(0, 6).toUpperCase();
  rooms[id] = { id, eventName, airport: (airport || '').toUpperCase(), strips: [], atis: null, connectedCount: 0, voiceUrl: null, createdAt: Date.now() };
  res.json({ roomId: id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', socket => {
  let roomId = null;
  let me = null;

  socket.on('room:join', ({ roomId: rid, userId }) => {
    const room = rooms[(rid || '').toUpperCase()];
    const user = users[userId];
    if (!room) { socket.emit('room:error', { message: 'Room not found.' }); return; }
    if (!user) { socket.emit('room:error', { message: 'Not authenticated.' }); return; }
    roomId = room.id; me = user;
    socket.join(roomId);
    room.connectedCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    socket.emit('room:joined', room);
    broadcastRoom(roomId);
    io.to(roomId).emit('room:message', { text: `${user.username} (${user.role?.toUpperCase()}) joined` });
  });

  socket.on('strip:add', ({ roomId: rid, strip }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'atc') return;
    room.strips.push({ id: uuidv4(), callsign: strip.callsign || '???', actype: strip.actype || '---', va: strip.va || '', orig: strip.orig || '----', dest: strip.dest || '----', gate: strip.gate || '', fl: strip.fl || '', pilot: strip.pilot || 'Unknown', pilotId: null, remarks: strip.remarks || '', flightRules: strip.flightRules || 'IFR', squawk: null, sid: '', star: '', clearance: null, pdcStatus: 'none', status: 'registered', addedAt: Date.now(), updatedAt: Date.now() });
    broadcastRoom(rid);
  });

  socket.on('strip:update', ({ roomId: rid, stripId, changes }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'atc') return;
    const s = room.strips.find(s => s.id === stripId);
    if (s) { Object.assign(s, changes, { updatedAt: Date.now() }); broadcastRoom(rid); }
  });

  socket.on('strip:remove', ({ roomId: rid, stripId }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'atc') return;
    room.strips = room.strips.filter(s => s.id !== stripId);
    broadcastRoom(rid);
  });

  socket.on('flightplan:file', ({ roomId: rid, plan }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'pilot') return;
    const strip = { id: uuidv4(), callsign: plan.callsign || me.username.toUpperCase(), actype: plan.actype || '---', va: plan.va || '', orig: (plan.orig || '----').toUpperCase(), dest: (plan.dest || '----').toUpperCase(), gate: (plan.gate || '').toUpperCase(), fl: (plan.fl || '').toUpperCase(), pilot: me.username, pilotId: me.id, remarks: plan.remarks || '', flightRules: plan.flightRules || 'IFR', route: plan.route || '', runway: plan.runway || '', squawk: null, sid: '', star: '', clearance: null, pdcStatus: 'pending', status: 'registered', addedAt: Date.now(), updatedAt: Date.now() };
    room.strips.push(strip);
    broadcastRoom(rid);
    io.to(rid).emit('room:message', { text: `✈ ${me.username} filed ${plan.flightRules} — ${strip.orig}→${strip.dest}` });
    socket.emit('flightplan:accepted', { stripId: strip.id });
  });

  socket.on('pdc:request', ({ roomId: rid, stripId }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'pilot') return;
    const s = room.strips.find(s => s.id === stripId);
    if (s) { s.pdcStatus = 'pending'; s.updatedAt = Date.now(); broadcastRoom(rid); io.to(rid).emit('room:message', { text: `📋 PDC requested by ${me.username}` }); }
  });

  socket.on('pdc:issue', ({ roomId: rid, stripId, clearance }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'atc') return;
    const s = room.strips.find(s => s.id === stripId);
    if (!s) return;
    s.squawk = clearance.squawk || squawk();
    s.sid = clearance.sid || ''; s.star = clearance.star || '';
    s.fl = clearance.fl || s.fl;
    s.clearance = { ...clearance, squawk: s.squawk, issuedBy: me.username, issuedByDiscordId: me.id, issuedAt: Date.now() };
    s.pdcStatus = 'issued'; s.updatedAt = Date.now();
    broadcastRoom(rid);
    io.to(rid).emit('room:message', { text: `✅ PDC issued to ${s.pilot} — Squawk ${s.squawk}` });
  });

  socket.on('atis:generate', ({ roomId: rid, info }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'atc') return;
    room.atis = makeATIS(room.airport || 'ZZZZ', info || {});
    broadcastRoom(rid);
    io.to(rid).emit('room:message', { text: `📡 ATIS ${room.atis.letter} broadcast` });
  });

  socket.on('chat:send', ({ roomId: rid, message }) => {
    if (!me || !message?.trim()) return;
    io.to(rid).emit('chat:receive', { userId: me.id, username: me.username, avatar: me.avatar, role: me.role, message: message.trim().slice(0, 300), ts: Date.now() });
  });

  socket.on('voice:set', ({ roomId: rid, url }) => {
    const room = rooms[rid];
    if (!room || me?.role !== 'atc') return;
    room.voiceUrl = url;
    io.to(rid).emit('voice:update', url);
  });

  socket.on('atc:rate', ({ atcId, stars, comment }) => {
    if (!me || me.role !== 'pilot') return;
    if (users[atcId]) {
      users[atcId].ratings = users[atcId].ratings || [];
      users[atcId].ratings.push({ stars, comment, pilotId: me.id, pilotName: me.username, ts: Date.now() });
    }
    socket.emit('atc:rated');
  });

  socket.on('disconnect', () => {
    if (roomId && rooms[roomId]) {
      rooms[roomId].connectedCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      broadcastRoom(roomId);
    }
  });
});

server.listen(PORT, () => console.log(`PFEvent Control on port ${PORT}`));