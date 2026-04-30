const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BASE_URL              = process.env.BASE_URL || 'https://pfevent-control.onrender.com';
const REDIRECT_URI          = `${BASE_URL}/auth/discord/callback`;
const SESSION_SECRET        = process.env.SESSION_SECRET || 'pfevent-super-secret-2025';
const PORT                  = process.env.PORT || 3000;

function serverEsc(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../public')));

const rooms = {};
const users = {};

function getRoom(id) { return rooms[id] || null; }

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (room) io.to(roomId).emit('room:update', room);
}

function generateSquawk() {
  const d = () => Math.floor(Math.random() * 8);
  return `${d()}${d()}${d()}${d()}`;
}

function generateATIS(airport, info) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letter = letters[Math.floor(Math.random() * 26)];
  const time = new Date().toISOString().slice(11, 16).replace(':', '') + 'Z';
  return {
    letter,
    raw: `${airport} ATIS INFORMATION ${letter} ${time}. ` +
         `WIND ${info.wind || '000/00KT'}. ` +
         `VISIBILITY ${info.vis || '10KM'}. ` +
         `${info.cloud || 'SKY CLEAR'}. ` +
         `TEMPERATURE ${info.temp || '25'}/DEWPOINT ${info.dew || '15'}. ` +
         `QNH ${info.qnh || '1013'}. ` +
         `ACTIVE RUNWAY ${info.rwy || '12'}. ` +
         `${info.remarks || ''} ` +
         `ADVISE ON INITIAL CONTACT YOU HAVE INFORMATION ${letter}.`
  };
}

// ── Auth ──────────────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + error);
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    users[discordUser.id] = {
      id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
      role: null,
      ratings: []
    };

    req.session.userId = discordUser.id;
    req.session.userData = users[discordUser.id];
    req.session.save((err) => {
      if (err) return res.redirect('/?error=session_failed');
      res.redirect('/');
    });
  } catch (e) {
    console.error('[OAuth] error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

function getUser(req) {
  if (!req.session.userId) return null;
  if (!users[req.session.userId] && req.session.userData) {
    users[req.session.userId] = req.session.userData;
  }
  return users[req.session.userId] || null;
}

app.get('/api/me', (req, res) => {
  const user = getUser(req);
  if (!user) return res.json({ user: null });
  res.json({ user });
});

app.post('/api/me/role', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const { role } = req.body;
  if (!['pilot', 'atc'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  user.role = role;
  req.session.userData = user;
  res.json({ user });
});

app.post('/api/rooms', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.role !== 'atc') return res.status(403).json({ error: 'ATC only' });
  const { eventName, airport } = req.body;
  if (!eventName) return res.status(400).json({ error: 'eventName required' });
  const id = uuidv4().slice(0, 6).toUpperCase();
  rooms[id] = {
    id, eventName,
    airport: (airport || '').toUpperCase(),
    strips: [], atis: null,
    connectedCount: 0, createdAt: Date.now()
  };
  res.json({ roomId: id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Socket.io ──────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let socketUser = null;

  socket.on('room:join', ({ roomId, userId }) => {
    const id = (roomId || '').toUpperCase();
    const room = getRoom(id);
    if (!room) { socket.emit('room:error', { message: 'Room not found.' }); return; }
    const user = users[userId];
    if (!user) { socket.emit('room:error', { message: 'Not authenticated.' }); return; }
    currentRoom = id;
    socketUser = user;
    socket.join(id);
    room.connectedCount = io.sockets.adapter.rooms.get(id)?.size || 0;
    socket.emit('room:joined', room);
    broadcastRoom(id);
    io.to(id).emit('room:message', { text: `${user.username} (${user.role?.toUpperCase()}) joined` });
  });

  socket.on('strip:add', ({ roomId, strip }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    room.strips.push({
      id: uuidv4(),
      callsign: serverEsc(strip.callsign) || '???',
      actype:   serverEsc(strip.actype)   || '---',
      va:       serverEsc(strip.va)       || '',
      orig:     serverEsc(strip.orig)     || '----',
      dest:     serverEsc(strip.dest)     || '----',
      gate:     serverEsc(strip.gate)     || '',
      fl:       serverEsc(strip.fl)       || '',
      pilot:    serverEsc(strip.pilot)    || 'Unknown',
      pilotId:  strip.pilotId || null,
      remarks:  serverEsc(strip.remarks)  || '',
      flightRules: strip.flightRules || 'IFR',
      squawk: null, sid: '', star: '',
      clearance: null, pdcStatus: 'none',
      status: 'registered',
      addedAt: Date.now(), updatedAt: Date.now()
    });
    broadcastRoom(roomId);
  });

  socket.on('flightplan:file', ({ roomId, plan }) => {
    const room = getRoom(roomId);
    if (!room || !socketUser || socketUser.role !== 'pilot') return;
    const strip = {
      id: uuidv4(),
      callsign:    serverEsc(plan.callsign) || socketUser.username.toUpperCase(),
      actype:      serverEsc(plan.actype)   || '---',
      orig:        serverEsc(plan.orig)     || 'ZZZZ',
      dest:        serverEsc(plan.dest)     || 'ZZZZ',
      route:       serverEsc(plan.route)    || 'DIRECT',
      remarks:     serverEsc(plan.remarks)  || '',
      va:          serverEsc(plan.va)       || '',
      fl:          serverEsc(plan.fl)       || '000',
      flightRules: plan.flightRules || 'IFR',
      pilot:       socketUser.username,
      pilotId:     socketUser.id,
      status: 'registered', pdcStatus: 'none',
      squawk: null, sid: '', star: '', clearance: null,
      addedAt: Date.now(), updatedAt: Date.now()
    };
    room.strips.push(strip);
    broadcastRoom(roomId);
    io.to(roomId).emit('room:message', {
      text: `✈ ${socketUser.username} filed ${strip.flightRules} — ${strip.orig}→${strip.dest}`
    });
    socket.emit('flightplan:accepted', { stripId: strip.id });
  });

  socket.on('pdc:request', ({ roomId, stripId }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'pilot') return;
    const strip = room.strips.find(s => s.id === stripId);
    if (!strip) return;
    strip.pdcStatus = 'pending';
    strip.updatedAt = Date.now();
    broadcastRoom(roomId);
    io.to(roomId).emit('room:message', { text: `📋 PDC requested by ${socketUser.username}` });
  });

  socket.on('pdc:issue', ({ roomId, stripId, clearance }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    const strip = room.strips.find(s => s.id === stripId);
    if (!strip) return;
    strip.squawk = serverEsc(clearance.squawk) || generateSquawk();
    strip.sid     = serverEsc(clearance.sid)  || '';
    strip.star    = serverEsc(clearance.star) || '';
    strip.fl      = serverEsc(clearance.fl)   || strip.fl;
    strip.remarks = serverEsc(clearance.remarks) || strip.remarks;
    strip.clearance = {
      ...clearance,
      squawk: strip.squawk,
      issuedBy: socketUser.username,
      issuedByDiscordId: socketUser.id,
      issuedAt: Date.now()
    };
    strip.pdcStatus = 'issued';
    strip.updatedAt = Date.now();
    broadcastRoom(roomId);
    io.to(roomId).emit('room:message', {
      text: `✅ PDC issued to ${strip.pilot} — Squawk ${strip.squawk}`
    });
  });

  socket.on('strip:update', ({ roomId, stripId, changes }) => {
    const room = getRoom(roomId);
    if (!room || !socketUser || socketUser.role !== 'atc') return;
    const strip = room.strips.find(s => s.id === stripId);
    if (!strip) return;
    if (changes.squawk)  changes.squawk  = serverEsc(changes.squawk);
    if (changes.remarks) changes.remarks = serverEsc(changes.remarks);
    if (changes.sid)     changes.sid     = serverEsc(changes.sid);
    Object.assign(strip, changes, { updatedAt: Date.now() });
    broadcastRoom(roomId);
  });

  socket.on('strip:remove', ({ roomId, stripId }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    room.strips = room.strips.filter(s => s.id !== stripId);
    broadcastRoom(roomId);
  });

  socket.on('atis:generate', ({ roomId, info }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    room.atis = generateATIS(room.airport, info || {});
    broadcastRoom(roomId);
    io.to(roomId).emit('room:message', { text: `📡 ATIS ${room.atis.letter} issued` });
  });

  socket.on('atc:rate', ({ atcId, stars, comment }) => {
    if (!socketUser || socketUser.role !== 'pilot') return;
    if (users[atcId]) {
      users[atcId].ratings = users[atcId].ratings || [];
      users[atcId].ratings.push({
        stars, comment,
        pilotId: socketUser.id,
        pilotName: socketUser.username,
        ts: Date.now()
      });
    }
    socket.emit('atc:rated', { ok: true });
  });

  socket.on('chat:send', ({ roomId, message }) => {
    const room = getRoom(roomId);
    if (!room || !socketUser) return;
    io.to(roomId).emit('chat:receive', {
      userId:   socketUser.id,
      username: socketUser.username,
      role:     socketUser.role,
      message:  serverEsc(message),
      ts: Date.now()
    });
  });

  socket.on('voice:set', ({ roomId, url }) => {
    const room = getRoom(roomId);
    if (!room || !socketUser) return;
    room.voiceUrl = url;
    io.to(roomId).emit('voice:update', url);
    io.to(roomId).emit('room:message', { text: `🎙 Voice channel updated by ${socketUser.username}` });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].connectedCount = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      broadcastRoom(currentRoom);
    }
  });
});

server.listen(PORT, () => console.log(`PFEvent Control running on port ${PORT}`));