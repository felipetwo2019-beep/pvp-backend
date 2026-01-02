// === SERVER.JS PVP (EVOLUÇÃO 1): PASS_TURN 100% AUTORITÁRIO + RESYNC ===

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Redis = require("ioredis");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  credentials: false
}));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "OPTIONS"] },
  transports: ["polling", "websocket"],
  pingTimeout: 20000,
  pingInterval: 25000,
  allowEIO3: true
});

app.get("/", (req, res) => res.send("Servidor PVP ONLINE"));
app.get("/health", (req, res) => res.json({ ok: true }));

const redis = new Redis(process.env.REDIS_URL);

const ROOMS_KEY = "pvp:rooms"; // (mantido por compatibilidade do seu projeto)
const MATCH_KEY = (id) => `pvp:match:${id}`;
const MATCH_TTL_SECONDS = 60 * 60;

// ---------- helpers ----------
async function getRooms() {
  const d = await redis.get(ROOMS_KEY);
  return d ? JSON.parse(d) : [];
}
async function saveRooms(r) {
  await redis.set(ROOMS_KEY, JSON.stringify(r));
}
async function saveMatch(m) {
  await redis.set(MATCH_KEY(m.matchId), JSON.stringify(m), "EX", MATCH_TTL_SECONDS);
}
async function getMatch(id) {
  const d = await redis.get(MATCH_KEY(id));
  return d ? JSON.parse(d) : null;
}

function roleForSocket(match, sid) {
  if (!match?.players?.A?.id || !match?.players?.B?.id) return null;
  if (match.players.A.id === sid) return "A";
  if (match.players.B.id === sid) return "B";
  return null;
}

function createInitialState() {
  return {
    playerA: { hp: 1000, pi: 7 },
    playerB: { hp: 1000, pi: 7 }
  };
}

function safeEmitReject(socket, matchId, reason, extra = {}) {
  socket.emit("pvp_reject", { matchId, reason, ...extra });
}

// ---------- socket ----------
io.on("connection", async (socket) => {
  console.log("[SOCKET] connected", socket.id);

  // (Opcional) Se você ainda usa rooms em algum ponto do seu front antigo
  // não quebra nada manter isso:
  socket.on("ping_rooms", async () => {
    const rooms = await getRooms();
    socket.emit("rooms_updated", (rooms || []).map(r => ({
      id: r.id,
      name: r.name,
      hasPassword: !!r.hasPassword,
      players: (r.players || []).length,
      status: r.status || "waiting"
    })));
  });

  // -------- START MATCH (mantive seu fluxo atual) --------
  socket.on("set_ready", async ({ ready, deck }) => {
    const rooms = await getRooms();
    const room = rooms.find(r => r.players?.some(p => p.id === socket.id));
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.ready = !!ready;
    player.deck = Array.isArray(deck) ? deck : [];

    await saveRooms(rooms);
    io.to(room.id).emit("room_state", room);

    if (
      room.players.length === 2 &&
      room.players.every(p => p.ready) &&
      room.status !== "playing"
    ) {
      room.status = "playing";
      await saveRooms(rooms);

      const [p1, p2] = room.players;
      const initial = createInitialState();

      const match = {
        matchId: room.id,
        status: "playing",
        createdAt: Date.now(),

        // 🔥 Agora o turno é autoritário do servidor
        turn: "A",

        // 🔥 Sequência autoritária (ordem global)
        serverSeq: 0,

        // Para debug/recuperação
        lastAction: null,

        players: {
          A: { id: p1.id, deck: p1.deck || [] },
          B: { id: p2.id, deck: p2.deck || [] }
        },

        // Snapshot base (ainda simples)
        state: {
          playerA: initial.playerA,
          playerB: initial.playerB
        }
      };

      await saveMatch(match);

      // garante que os 2 sockets estão no "room" do match
      io.sockets.sockets.get(p1.id)?.join(match.matchId);
      io.sockets.sockets.get(p2.id)?.join(match.matchId);

      console.log("[MATCH_START] matchId=", match.matchId, "A=", p1.id, "B=", p2.id);

      io.to(p1.id).emit("match_start", {
        matchId: match.matchId,
        yourRole: "A",
        you: match.state.playerA,
        opp: match.state.playerB,
        youDeck: match.players.A.deck,
        oppDeck: match.players.B.deck,
        turn: match.turn
      });

      io.to(p2.id).emit("match_start", {
        matchId: match.matchId,
        yourRole: "B",
        you: match.state.playerB,
        opp: match.state.playerA,
        youDeck: match.players.B.deck,
        oppDeck: match.players.A.deck,
        turn: match.turn
      });

      // snapshot inicial (não é mais “o caminho” no futuro, mas ajuda no start)
      io.to(match.matchId).emit("sync_state", {
        matchId: match.matchId,
        state: match.state,
        turn: match.turn,
        serverSeq: match.serverSeq
      });
    }
  });

  // -------- RESYNC: cliente pede o estado autoritário atual --------
  socket.on("pvp_request_sync", async ({ matchId }) => {
    const match = await getMatch(matchId);
    if (!match) return safeEmitReject(socket, matchId, "MATCH_NOT_FOUND");

    // Garante que só player do match recebe
    const role = roleForSocket(match, socket.id);
    if (!role) return safeEmitReject(socket, matchId, "NOT_IN_MATCH");

    socket.join(matchId);

    socket.emit("sync_state", {
      matchId,
      state: match.state,
      turn: match.turn,
      serverSeq: match.serverSeq || 0,
      youDeck: role === "A" ? match.players.A.deck : match.players.B.deck,
      oppDeck: role === "A" ? match.players.B.deck : match.players.A.deck,
      lastAction: match.lastAction || null
    });
  });

  // -------- PVP ACTION (EVOLUÇÃO): PASS_TURN autoritário --------
  socket.on("pvp_action", async ({ matchId, type, payload, clientSeq }) => {
    const match = await getMatch(matchId);
    if (!match) {
      console.log("[PVP_ACTION] MATCH_NOT_FOUND", matchId);
      return safeEmitReject(socket, matchId, "MATCH_NOT_FOUND");
    }

    // Segurança: garante que esse socket é do match
    const role = roleForSocket(match, socket.id);
    if (!role) {
      console.log("[PVP_ACTION] NOT_IN_MATCH socket=", socket.id, "match=", matchId);
      return safeEmitReject(socket, matchId, "NOT_IN_MATCH");
    }

    // Garantir que ele está na sala do match (evita “perdi eventos”)
    socket.join(matchId);

    // Turno autoritário: ninguém age fora do turno
    if (match.turn !== role) {
      console.log("[PVP_ACTION] NOT_YOUR_TURN role=", role, "turn=", match.turn);
      return safeEmitReject(socket, matchId, "NOT_YOUR_TURN", { turn: match.turn });
    }

    // Sequência global (ordem única do servidor)
    match.serverSeq = (match.serverSeq || 0) + 1;

    // ✅ PASS_TURN (100% autoritário)
    if (type === "PASS_TURN") {
      match.turn = (match.turn === "A") ? "B" : "A";
    } else {
      // Por enquanto só aceitamos PASS_TURN como “autoritário real”
      // Outras ações vamos adicionar no próximo passo (PLAY_CARD / ATTACK etc)
      console.log("[PVP_ACTION] Unsupported type for now:", type);
      return safeEmitReject(socket, matchId, "UNSUPPORTED_ACTION", { type });
    }

    match.lastAction = {
      serverSeq: match.serverSeq,
      from: role,
      type,
      payload: payload ?? null,
      clientSeq: clientSeq ?? null,
      ts: Date.now()
    };

    await saveMatch(match);

    // Broadcast autoritário para os 2 (inclusive quem enviou)
    io.to(matchId).emit("pvp_action", {
      matchId,
      role,
      type,
      payload: payload ?? null,
      clientSeq: clientSeq ?? null,
      serverSeq: match.serverSeq,
      turn: match.turn
    });

    // Opcional: também manda um “mini sync” do turno atual (mais robusto)
    io.to(matchId).emit("turn_update", {
      matchId,
      turn: match.turn,
      serverSeq: match.serverSeq
    });

    console.log("[PVP_ACTION] OK", matchId, "seq=", match.serverSeq, "turn=", match.turn);
  });

  socket.on("disconnect", (reason) => {
    console.log("[SOCKET] disconnected", socket.id, "reason=", reason);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));
