const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// In-memory store: rooms keyed by roomId
// room = { id, name, event, strips: [], atcs: [], createdAt }
const rooms = {};

function getRoom(id) {
  return rooms[id] || null;
}

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (room) io.to(roomId).emit('room:update', room);
}

// REST: create room
app.post('/api/rooms', (req, res) => {
  const { eventName, airport } = req.body;
  if (!eventName) return res.status(400).json({ error: 'eventName required' });
  const id = uuidv4().slice(0, 6).toUpperCase();
  rooms[id] = {
    id,
    eventName,
    airport: airport || '',
    strips: [],
    connectedCount: 0,
    createdAt: Date.now()
  };
  res.json({ roomId: id });
});

// REST: get room info
app.get('/api/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

// Serve index for all other routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:join', ({ roomId, username }) => {
    const id = (roomId || '').toUpperCase();
    const room = getRoom(id);
    if (!room) {
      socket.emit('room:error', { message: 'Room not found. Check your room code.' });
      return;
    }
    currentRoom = id;
    socket.join(id);
    room.connectedCount = io.sockets.adapter.rooms.get(id)?.size || 0;
    socket.emit('room:joined', room);
    broadcastRoom(id);
    io.to(id).emit('room:message', { type: 'join', text: `${username || 'Someone'} joined` });
  });

  socket.on('strip:add', ({ roomId, strip }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const newStrip = {
      id: uuidv4(),
      callsign: strip.callsign || '???',
      actype: strip.actype || '---',
      va: strip.va || '',
      orig: strip.orig || '----',
      dest: strip.dest || '----',
      gate: strip.gate || '--',
      fl: strip.fl || '---',
      pilot: strip.pilot || 'Unknown',
      remarks: strip.remarks || '',
      status: 'registered',
      addedAt: Date.now(),
      updatedAt: Date.now()
    };
    room.strips.push(newStrip);
    broadcastRoom(roomId);
  });

  socket.on('strip:update', ({ roomId, stripId, changes }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const strip = room.strips.find(s => s.id === stripId);
    if (!strip) return;
    Object.assign(strip, changes, { updatedAt: Date.now() });
    broadcastRoom(roomId);
  });

  socket.on('strip:remove', ({ roomId, stripId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.strips = room.strips.filter(s => s.id !== stripId);
    broadcastRoom(roomId);
  });

  socket.on('strip:reorder', ({ roomId, status, orderedIds }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const others = room.strips.filter(s => s.status !== status);
    const reordered = orderedIds
      .map(id => room.strips.find(s => s.id === id))
      .filter(Boolean);
    room.strips = [...others, ...reordered];
    broadcastRoom(roomId);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const size = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      rooms[currentRoom].connectedCount = size;
      broadcastRoom(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VAControl running on http://localhost:${PORT}`);
});