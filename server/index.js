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

// ── Config ─────────────────────────────────────────────────
const DISCORD_CLIENT_ID     = '1498034089545044049';
const DISCORD_CLIENT_SECRET = '790Oz-Q_ZhPzhYZsopAFwdGskvosz4ag';
const BASE_URL              = process.env.BASE_URL || 'https://pfevent-control.onrender.com';
const REDIRECT_URI          = `${BASE_URL}/auth/discord/callback`;
const SESSION_SECRET        = process.env.SESSION_SECRET || 'pfevent-super-secret-2025';
const PORT                  = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,       // HTTPS on Render
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory store ────────────────────────────────────────
// rooms[id] = { id, eventName, airport, strips[], connectedCount, createdAt }
const rooms = {};

// users[discordId] = { id, username, avatar, discriminator, role, ratings[] }
const users = {};

function getRoom(id) { return rooms[id] || null; }

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (room) io.to(roomId).emit('room:update', sanitizeRoom(room));
}

function sanitizeRoom(room) {
  return {
    ...room,
    strips: room.strips.map(s => ({
      ...s,
      // include full data — ATC and pilot see different things in frontend
    }))
  };
}

function generateSquawk() {
  // Generate a valid squawk (0000-7777, octal digits only)
  const digits = () => Math.floor(Math.random() * 8);
  return `${digits()}${digits()}${digits()}${digits()}`;
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

// ── Auth: Discord OAuth ────────────────────────────────────
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
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    // Exchange code for token
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

    // Get user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    // Store in memory
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
    res.redirect('/');
  } catch (e) {
    console.error('OAuth error:', e);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ── API: current user ──────────────────────────────────────
app.get('/api/me', (req, res) => {
  const user = users[req.session.userId];
  if (!user) return res.json({ user: null });
  res.json({ user });
});

app.post('/api/me/role', (req, res) => {
  const user = users[req.session.userId];
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const { role } = req.body;
  if (!['pilot', 'atc'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  user.role = role;
  res.json({ user });
});

// ── API: rooms ─────────────────────────────────────────────
app.post('/api/rooms', (req, res) => {
  const user = users[req.session.userId];
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.role !== 'atc') return res.status(403).json({ error: 'ATC only' });

  const { eventName, airport } = req.body;
  if (!eventName) return res.status(400).json({ error: 'eventName required' });

  const id = uuidv4().slice(0, 6).toUpperCase();
  rooms[id] = {
    id,
    eventName,
    airport: (airport || '').toUpperCase(),
    strips: [],
    atis: null,
    connectedCount: 0,
    createdAt: Date.now()
  };
  res.json({ roomId: id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

// ── API: ratings ───────────────────────────────────────────
app.post('/api/rooms/:id/rate', (req, res) => {
  const user = users[req.session.userId];
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.role !== 'pilot') return res.status(403).json({ error: 'Pilots only' });

  const { stars, comment, atcId } = req.body;
  const rating = { stars, comment, atcId, pilotId: user.id, pilotName: user.username, ts: Date.now() };

  if (users[atcId]) {
    users[atcId].ratings = users[atcId].ratings || [];
    users[atcId].ratings.push(rating);
  }
  res.json({ ok: true });
});

// ── Serve SPA ──────────────────────────────────────────────
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
    socket.emit('room:joined', sanitizeRoom(room));
    broadcastRoom(id);
    io.to(id).emit('room:message', { text: `${user.username} (${user.role?.toUpperCase()}) joined` });
  });

  // ── ATC: add strip manually ──────────────────────────────
  socket.on('strip:add', ({ roomId, strip }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    const newStrip = {
      id: uuidv4(),
      callsign: strip.callsign || '???',
      actype: strip.actype || '---',
      va: strip.va || '',
      orig: strip.orig || '----',
      dest: strip.dest || '----',
      gate: strip.gate || '',
      fl: strip.fl || '',
      pilot: strip.pilot || 'Unknown',
      pilotId: strip.pilotId || null,
      remarks: strip.remarks || '',
      flightRules: strip.flightRules || 'IFR',
      squawk: null,
      sid: strip.sid || '',
      star: strip.star || '',
      clearance: null,
      pdcStatus: 'none',  // none | pending | issued
      status: 'registered',
      addedAt: Date.now(),
      updatedAt: Date.now()
    };
    room.strips.push(newStrip);
    broadcastRoom(roomId);
  });

  // ── Pilot: file flight plan (IFR/VFR) ───────────────────
  socket.on('flightplan:file', ({ roomId, plan }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'pilot') return;

    const strip = {
      id: uuidv4(),
      callsign: plan.callsign || socketUser.username.toUpperCase(),
      actype: plan.actype || '---',
      va: plan.va || '',
      orig: (plan.orig || '----').toUpperCase(),
      dest: (plan.dest || '----').toUpperCase(),
      gate: (plan.gate || '').toUpperCase(),
      fl: (plan.fl || '').toUpperCase(),
      pilot: socketUser.username,
      pilotId: socketUser.id,
      remarks: plan.remarks || '',
      flightRules: plan.flightRules || 'IFR',
      route: plan.route || '',
      squawk: null,
      sid: '',
      star: '',
      clearance: null,
      pdcStatus: 'pending',
      status: 'registered',
      addedAt: Date.now(),
      updatedAt: Date.now()
    };

    room.strips.push(strip);
    broadcastRoom(roomId);

    // Notify ATCs
    io.to(roomId).emit('room:message', {
      text: `✈ ${socketUser.username} filed ${plan.flightRules} — ${strip.orig}→${strip.dest}`
    });

    // Send strip ID back to pilot so ACARS can track it
    socket.emit('flightplan:accepted', { stripId: strip.id });
  });

  // ── Pilot: request PDC ───────────────────────────────────
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

  // ── ATC: issue PDC / clearance ───────────────────────────
  socket.on('pdc:issue', ({ roomId, stripId, clearance }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    const strip = room.strips.find(s => s.id === stripId);
    if (!strip) return;

    strip.squawk = clearance.squawk || generateSquawk();
    strip.sid = clearance.sid || '';
    strip.star = clearance.star || '';
    strip.fl = clearance.fl || strip.fl;
    strip.remarks = clearance.remarks || strip.remarks;
    strip.clearance = {
      ...clearance,
      squawk: strip.squawk,
      issuedBy: socketUser.username,
      issuedAt: Date.now()
    };
    strip.pdcStatus = 'issued';
    strip.updatedAt = Date.now();
    broadcastRoom(roomId);

    // Push clearance directly to the pilot's socket
    io.to(roomId).emit(`pdc:clearance:${strip.pilotId}`, { strip });
    io.to(roomId).emit('room:message', {
      text: `✅ PDC issued to ${strip.pilot} — Squawk ${strip.squawk}`
    });
  });

  // ── ATC: update strip status / squawk ───────────────────
  socket.on('strip:update', ({ roomId, stripId, changes }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    const strip = room.strips.find(s => s.id === stripId);
    if (!strip) return;
    Object.assign(strip, changes, { updatedAt: Date.now() });
    broadcastRoom(roomId);
  });

  // ── ATC: remove strip ────────────────────────────────────
  socket.on('strip:remove', ({ roomId, stripId }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    room.strips = room.strips.filter(s => s.id !== stripId);
    broadcastRoom(roomId);
  });

  // ── ATC: generate ATIS ───────────────────────────────────
  socket.on('atis:generate', ({ roomId, info }) => {
    const room = getRoom(roomId);
    if (!room || socketUser?.role !== 'atc') return;
    room.atis = generateATIS(room.airport, info || {});
    broadcastRoom(roomId);
    io.to(roomId).emit('room:message', { text: `📡 ATIS ${room.atis.letter} issued` });
  });

  // ── Pilot: rate ATC ──────────────────────────────────────
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

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const size = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      rooms[currentRoom].connectedCount = size;
      broadcastRoom(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`PFEvent Control running on port ${PORT}`);
});