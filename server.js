const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Redis = require("ioredis");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Health check
app.get("/", (req, res) => res.send("Servidor PVP ONLINE"));

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
// OBS: aqui ainda é placeholder. Depois podemos montar a partir do deck.
function createInitialState(players) {
  return {
    playerA: { hp: 1000, pi: 7 },
    playerB: { hp: 1000, pi: 7 }
  };
}

// --- Socket.IO ---
io.on('connection', async (socket) => {
  console.log('User connected:', socket.id);

  // Sempre que alguém conectar, já manda a lista atual de salas
  await broadcastRooms();

  // Botão "ATUALIZAR SALAS" (front emite ping_rooms)
  socket.on('ping_rooms', async () => {
    const rooms = await getRooms();
    socket.emit('rooms_updated', rooms.map(formatRoom));
  });

  // Caso queira pedir lista explicitamente
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
      started: false // ✅ evita start duplicado
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
    await saveRooms(rooms);

    socket.join(room.id);
    io.to(room.id).emit('room_state', room);
    await broadcastRooms();
  });

  // Pronto / não pronto
  socket.on('set_ready', async ({ ready, deck }) => {
    const rooms = await getRooms();
    const room = rooms.find(r => r.players.some(p => p.id === socket.id));
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    player.ready = !!ready;
    player.deck = deck || null;

    // Atualiza sala antes de começar
    await saveRooms(rooms);
    io.to(room.id).emit('room_state', room);

    // ✅ Start só uma vez, e só se 2 jogadores e 2 prontos
    if (
      room.players.length === 2 &&
      room.players.every(p => p.ready) &&
      room.status !== 'playing' &&
      !room.started
    ) {
      room.status = 'playing';
      room.started = true;
      await saveRooms(rooms);

      // manda update de status antes do start
      io.to(room.id).emit('room_state', room);
      await broadcastRooms();

      const p1 = room.players[0];
      const p2 = room.players[1];

      const initial = createInitialState(room.players);

      // Envia "match_start" separado, cada um com sua perspectiva:
      io.to(p1.id).emit('match_start', {
        matchId: room.id,
        yourRole: 'A',
        you: initial.playerA,
        opp: initial.playerB
      });

      io.to(p2.id).emit('match_start', {
        matchId: room.id,
        yourRole: 'B',
        you: initial.playerB,
        opp: initial.playerA
      });

      return;
    }

    // se não iniciou, só atualiza lobby
    await broadcastRooms();
  });

  // Sair da sala
  socket.on('leave_room', async () => {
    let rooms = await getRooms();
    const room = rooms.find(r => r.players.some(p => p.id === socket.id));
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    // Se ainda tem alguém na sala, reseta estado pra não travar
    if (room.players.length > 0) {
      room.status = 'waiting';
      room.started = false;
      room.players.forEach(p => { p.ready = false; p.deck = null; });
      await saveRooms(rooms);

      socket.leave(room.id);
      io.to(room.id).emit('room_state', room);
    } else {
      // remove sala vazia
      rooms = rooms.filter(r => r.id !== room.id);
      await saveRooms(rooms);
      socket.leave(room.id);
    }

    await broadcastRooms();
  });

  // Disconnect
  socket.on('disconnect', async () => {
    let rooms = await getRooms();

    for (const room of rooms) {
      const hadPlayer = room.players.some(p => p.id === socket.id);
      if (!hadPlayer) continue;

      room.players = room.players.filter(p => p.id !== socket.id);

      // Se sobrou alguém, reseta pra waiting (evita travar em playing)
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
