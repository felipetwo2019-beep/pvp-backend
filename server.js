const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Redis = require("ioredis");

const app = express();

// CORS (mais compatível)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  credentials: false
}));

const server = http.createServer(app);

// Socket.IO com configs anti-timeout (Render free / redes ruins)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false
  },

  // deixa o server aceitar ambos (o front começa em polling)
  transports: ["polling", "websocket"],

  // timeouts mais “folgados”
  pingTimeout: 20000,
  pingInterval: 25000,

  // útil em alguns cenários (clientes diferentes)
  allowEIO3: true
});

// Health check / wake-up
app.get("/", (req, res) => res.send("Servidor PVP ONLINE"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Redis (usa a variável que você colocou no Render)
const redis = new Redis(process.env.REDIS_URL);

// --- Redis helpers ---
const ROOMS_KEY = "pvp:rooms";

async function getRooms() {
  const data = await redis.get(ROOMS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveRooms(rooms) {
  await redis.set(ROOMS_KEY, JSON.stringify(rooms));
}

function formatRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hasPassword: room.hasPassword,
    players: room.players.length,
    status: room.status
  };
}

async function broadcastRooms() {
  const rooms = await getRooms();
  io.emit("rooms_updated", rooms.map(formatRoom));
}

// Estado inicial (placeholder)
function createInitialState(players) {
  return {
    playerA: { hp: 1000, pi: 7 },
    playerB: { hp: 1000, pi: 7 }
  };
}

// Logs úteis do engine (pra debug no Render)
io.engine.on("connection_error", (err) => {
  console.log("[ENGINE] connection_error:", {
    code: err.code,
    message: err.message,
    context: err.context
  });
});

// --- Socket.IO ---
io.on('connection', async (socket) => {
  console.log('[SOCKET] connected:', socket.id);

  // Sempre que alguém conectar, já manda a lista atual de salas
  await broadcastRooms();

  // Botão "ATUALIZAR SALAS"
  socket.on('ping_rooms', async () => {
    const rooms = await getRooms();
    socket.emit('rooms_updated', rooms.map(formatRoom));
  });

  socket.on('rooms_list', async () => {
    const rooms = await getRooms();
    socket.emit('rooms_updated', rooms.map(formatRoom));
  });

  // Criar sala
  socket.on('create_room', async ({ name, password }) => {
    const rooms = await getRooms();

    const room = {
      id: 'room_' + Date.now(),
      name: name || "Sala",
      password: password || null,
      hasPassword: !!password,
      players: [{ id: socket.id, name: "Player 1", ready: false, deck: null }],
      status: 'waiting',
      started: false
    };

    rooms.push(room);
    await saveRooms(rooms);

    socket.join(room.id);
    socket.emit('room_state', room);
    await broadcastRooms();
  });

  // Entrar na sala
  socket.on('join_room', async ({ roomId, password }) => {
    const rooms = await getRooms();
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    if (room.password && room.password !== password) {
      socket.emit('error_msg', 'Senha incorreta');
      return;
    }

    if (room.players.length >= 2) return;

    room.players.push({ id: socket.id, name: "Player 2", ready: false, deck: null });

    // ✅ MUITO IMPORTANTE: reseta estado ao fechar 2/2 para evitar sala travada no Redis
    room.status = 'waiting';
    room.started = false;
    room.players.forEach(p => { p.ready = false; });

    await saveRooms(rooms);

    socket.join(room.id);
    io.to(room.id).emit('room_state', room);
    await broadcastRooms();
  });

  // Pronto / não pronto
  socket.on('set_ready', async ({ ready, deck }) => {
    const rooms = await getRooms();
    const room = rooms.find(r => r.players.some(p => p.id === socket.id));
    if (!room) {
      console.log('[READY] room not found for socket:', socket.id);
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) {
      console.log('[READY] player not found in room for socket:', socket.id);
      return;
    }

    player.ready = !!ready;
    player.deck = deck || null;

    // Atualiza sala antes de começar
    await saveRooms(rooms);
    io.to(room.id).emit('room_state', room);

    console.log('[READY] room:', room.id, 'players:', room.players.map(p => ({ id: p.id, ready: p.ready })));

    // ✅ START DEFINITIVO: só depende de status, não depende de started (evita travar no Redis)
    if (
      room.players.length === 2 &&
      room.players.every(p => p.ready) &&
      room.status !== 'playing'
    ) {
      room.status = 'playing';
      room.started = true; // opcional: só informativo
      await saveRooms(rooms);

      io.to(room.id).emit('room_state', room);
      await broadcastRooms();

      const p1 = room.players[0];
      const p2 = room.players[1];

      const initial = createInitialState(room.players);

      console.log('[MATCH_START] starting match for room:', room.id);
      console.log('[MATCH_START] p1:', p1.id, 'p2:', p2.id);

      io.to(p1.id).emit('match_start', {
        matchId: room.id,
        yourRole: 'A',
        you: initial.playerA,
        opp: initial.playerB,
        initialState: initial
      });

      io.to(p2.id).emit('match_start', {
        matchId: room.id,
        yourRole: 'B',
        you: initial.playerB,
        opp: initial.playerA,
        initialState: initial
      });

      return;
    }

    await broadcastRooms();
  });

  // Sair da sala
  socket.on('leave_room', async () => {
    let rooms = await getRooms();
    const room = rooms.find(r => r.players.some(p => p.id === socket.id));
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length > 0) {
      room.status = 'waiting';
      room.started = false;
      room.players.forEach(p => { p.ready = false; p.deck = null; });
      await saveRooms(rooms);

      socket.leave(room.id);
      io.to(room.id).emit('room_state', room);
    } else {
      rooms = rooms.filter(r => r.id !== room.id);
      await saveRooms(rooms);
      socket.leave(room.id);
    }

    await broadcastRooms();
  });

  // Disconnect
  socket.on('disconnect', async (reason) => {
    console.log('[SOCKET] disconnected:', socket.id, 'reason:', reason);

    let rooms = await getRooms();

    for (const room of rooms) {
      const hadPlayer = room.players.some(p => p.id === socket.id);
      if (!hadPlayer) continue;

      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.players.length > 0) {
        room.status = 'waiting';
        room.started = false;
        room.players.forEach(p => { p.ready = false; p.deck = null; });
        io.to(room.id).emit('room_state', room);
      }
    }

    rooms = rooms.filter(r => r.players.length > 0);
    await saveRooms(rooms);

    await broadcastRooms();
  });
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port', PORT));
