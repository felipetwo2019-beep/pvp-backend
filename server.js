const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// rota simples para teste
app.get("/", (req, res) => {
  res.send("Servidor PVP ONLINE");
});

// salas em memória (simples)
let rooms = [];

// quando um jogador conecta
io.on('connection', (socket) => {
  console.log("Jogador conectado:", socket.id);

  // criar sala
  socket.on('create_room', ({ name, password }) => {
    const room = {
      id: "room_" + Date.now(),
      name,
      password: password || null,
      hasPassword: !!password,
      players: [{ id: socket.id, ready: false }],
      status: "waiting"
    };

    rooms.push(room);
    socket.join(room.id);

    socket.emit('room_state', room);
    io.emit('rooms_updated', rooms.map(formatRoom));
  });

  // entrar em sala
  socket.on('join_room', ({ roomId, password }) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    if (room.hasPassword && room.password !== password) {
      socket.emit('error_msg', 'Senha incorreta');
      return;
    }

    if (room.players.length >= 2) return;

    room.players.push({ id: socket.id, ready: false });
    socket.join(room.id);

    io.to(room.id).emit('room_state', room);
    io.emit('rooms_updated', rooms.map(formatRoom));
  });

  // pronto / não pronto
  socket.on('set_ready', ({ ready }) => {
    const room = rooms.find(r => r.players.some(p => p.id === socket.id));
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    player.ready = ready;

    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.status = "playing";
      io.to(room.id).emit('match_start', {
        initialState: createInitialState()
      });
    }

    io.to(room.id).emit('room_state', room);
  });

  // sair / desconectar
  socket.on('disconnect', () => {
    rooms.forEach(room => {
      room.players = room.players.filter(p => p.id !== socket.id);
    });

    rooms = rooms.filter(r => r.players.length > 0);
    io.emit('rooms_updated', rooms.map(formatRoom));
  });
});

// formata lista do lobby
function formatRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hasPassword: room.hasPassword,
    players: room.players.length,
    status: room.status
  };
}

// estado inicial da partida (exemplo)
function createInitialState() {
  return {
    playerA: { hp: 1000, pi: 7 },
    playerB: { hp: 1000, pi: 7 }
  };
}

// iniciar servidor (OBRIGATÓRIO)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
