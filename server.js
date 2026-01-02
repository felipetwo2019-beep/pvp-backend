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
  transports: ["polling", "websocket"],
  pingTimeout: 20000,
  pingInterval: 25000,
  allowEIO3: true
});

// Health check / wake-up
app.get("/", (req, res) => res.send("Servidor PVP ONLINE"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Redis
const redis = new Redis(process.env.REDIS_URL);

// --- Redis keys ---
const ROOMS_KEY = "pvp:rooms";
const MATCH_KEY = (matchId) => `pvp:match:${matchId}`;  // salva estado do match
const MATCH_TTL_SECONDS = 60 * 60; // 1h (ajuste se quiser)

// --- Rooms helpers ---
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

// --- Match helpers ---
async function saveMatch(match) {
  await redis.set(MATCH_KEY(match.matchId), JSON.stringify(match), "EX", MATCH_TTL_SECONDS);
}

async function getMatch(matchId) {
  const data = await redis.get(MATCH_KEY(matchId));
  return data ? JSON.parse(data) : null;
}

function roleForSocket(match, socketId) {
  if (!match) return null;
  if (match.players?.A?.id === socketId) return "A";
  if (match.players?.B?.id === socketId) return "B";
  return null;
}

// Estado inicial (placeholder)
// OBS: continua placeholder, mas agora o match guarda e sincroniza.
function createInitialState(players) {
  return {
    playerA: { hp: 1000, pi: 7 },
    playerB: { hp: 1000, pi: 7 }
  };
}

// Logs úteis do engine
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

  await broadcastRooms();

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

    // reseta estado ao fechar 2/2
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
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.ready = !!ready;
    player.deck = Array.isArray(deck) ? deck : null;

    await saveRooms(rooms);
    io.to(room.id).emit('room_state', room);

    // Start
    if (room.players.length === 2 && room.players.every(p => p.ready) && room.status !== 'playing') {
      room.status = 'playing';
      room.started = true;
      await saveRooms(rooms);

      io.to(room.id).emit('room_state', room);
      await broadcastRooms();

      const p1 = room.players[0];
      const p2 = room.players[1];

      const initial = createInitialState(room.players);

      const p1Deck = Array.isArray(p1.deck) ? p1.deck : [];
      const p2Deck = Array.isArray(p2.deck) ? p2.deck : [];

      // ✅ cria o MATCH autoritário no Redis
      const match = {
        matchId: room.id,
        roomId: room.id,
        status: "playing",
        createdAt: Date.now(),
        // turno inicial (simples): A começa
        turn: "A",
        // sequência de ações (autoridade do servidor)
        serverSeq: 0,
        players: {
          A: { id: p1.id, name: p1.name || "Player 1", deck: p1Deck },
          B: { id: p2.id, name: p2.name || "Player 2", deck: p2Deck }
        },
        // snapshot base do estado
        state: {
          playerA: initial.playerA,
          playerB: initial.playerB
        }
      };

      await saveMatch(match);

      console.log('[MATCH_START] matchId:', match.matchId, 'A:', p1.id, 'B:', p2.id);

      // Cada um recebe sua perspectiva "PLAYER"
      io.to(p1.id).emit('match_start', {
        matchId: match.matchId,
        yourRole: 'A',
        you: match.state.playerA,
        opp: match.state.playerB,
        youDeck: p1Deck,
        oppDeck: p2Deck,
        turn: match.turn
      });

      io.to(p2.id).emit('match_start', {
        matchId: match.matchId,
        yourRole: 'B',
        you: match.state.playerB,
        opp: match.state.playerA,
        youDeck: p2Deck,
        oppDeck: p1Deck,
        turn: match.turn
      });

      // ✅ manda também um sync_state “autoridade”
      io.to(match.matchId).emit("sync_state", {
        matchId: match.matchId,
        turn: match.turn,
        serverSeq: match.serverSeq,
        state: match.state
      });

      return;
    }

    await broadcastRooms();
  });

  /**
   * ✅ AÇÃO PVP (AUTORITÁRIO)
   * O cliente manda uma ação. O servidor:
   * - verifica se o socket faz parte do match
   * - verifica se é o turno dele
   * - atribui serverSeq (ordem única)
   * - (por enquanto) NÃO aplica regras do jogo aqui
   * - retransmite para os dois em ordem
   *
   * Próxima etapa: aplicar regras no servidor em vez de só retransmitir.
   */
  socket.on("pvp_action", async ({ matchId, type, payload, clientSeq }) => {
    const match = await getMatch(matchId);
    if (!match) {
      socket.emit("pvp_reject", { reason: "MATCH_NOT_FOUND", matchId });
      return;
    }

    const role = roleForSocket(match, socket.id);
    if (!role) {
      socket.emit("pvp_reject", { reason: "NOT_IN_MATCH", matchId });
      return;
    }

    // Autoridade de turno (ninguém joga fora do turno)
    if (match.turn !== role) {
      socket.emit("pvp_reject", { reason: "NOT_YOUR_TURN", matchId, turn: match.turn });
      return;
    }

    // incrementa seq do servidor
    match.serverSeq = (match.serverSeq || 0) + 1;

    // ✅ REGRA de turno simples:
    // - Apenas PASS_TURN troca o turno.
    // (Depois ajustamos com suas regras reais.)
    if (type === "PASS_TURN") {
      match.turn = (match.turn === "A") ? "B" : "A";
    }

    await saveMatch(match);

    // retransmite ação para sala inteira
    io.to(match.matchId).emit("pvp_action", {
      matchId: match.matchId,
      serverSeq: match.serverSeq,
      role,        // quem executou (A/B)
      type,
      payload,
      clientSeq: clientSeq ?? null,
      turn: match.turn
    });
  });

  /**
   * ✅ RESYNC (se cair/recarregar)
   * Cliente pede o estado autoritário atual do match.
   */
  socket.on("pvp_request_sync", async ({ matchId }) => {
    const match = await getMatch(matchId);
    if (!match) {
      socket.emit("pvp_reject", { reason: "MATCH_NOT_FOUND", matchId });
      return;
    }

    const role = roleForSocket(match, socket.id);
    if (!role) {
      socket.emit("pvp_reject", { reason: "NOT_IN_MATCH", matchId });
      return;
    }

    socket.emit("sync_state", {
      matchId: match.matchId,
      turn: match.turn,
      serverSeq: match.serverSeq || 0,
      state: match.state,
      // decks por perspectiva (pra reconstruir se precisar)
      youDeck: role === "A" ? match.players.A.deck : match.players.B.deck,
      oppDeck: role === "A" ? match.players.B.deck : match.players.A.deck
    });
  });

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
