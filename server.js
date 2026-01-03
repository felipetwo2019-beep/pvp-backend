// === SERVER.JS PVP FINAL (LOBBY + MATCH + SNAPSHOT SYNC) ===
// Node/Express + Socket.IO + Redis (Render-friendly)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const Redis = require("ioredis");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], credentials: false }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "OPTIONS"] },
  transports: ["polling", "websocket"],
  pingTimeout: 20000,
  pingInterval: 25000,
  allowEIO3: true,
});

app.get("/", (req, res) => res.send("Servidor PVP ONLINE"));
app.get("/health", (req, res) => res.json({ ok: true }));

const redis = new Redis(process.env.REDIS_URL);

// -------------------- Redis keys / TTL --------------------
const ROOMS_KEY = "pvp:rooms"; // array de salas
const MATCH_KEY = (id) => `pvp:match:${id}`;

const MATCH_TTL_SECONDS = 60 * 60; // 1h
const ROOMS_TTL_SECONDS = 60 * 60 * 6; // 6h (rooms ficam no ROOMS_KEY; limpamos manualmente quando vazias)

// -------------------- Helpers --------------------
function uid(prefix = "room") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}
function sha256(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

async function getRooms() {
  const d = await redis.get(ROOMS_KEY);
  return d ? JSON.parse(d) : [];
}
async function saveRooms(rooms) {
  await redis.set(ROOMS_KEY, JSON.stringify(rooms), "EX", ROOMS_TTL_SECONDS);
}
async function saveMatch(match) {
  await redis.set(MATCH_KEY(match.matchId), JSON.stringify(match), "EX", MATCH_TTL_SECONDS);
}
async function getMatch(matchId) {
  const d = await redis.get(MATCH_KEY(matchId));
  return d ? JSON.parse(d) : null;
}
async function delMatch(matchId) {
  try { await redis.del(MATCH_KEY(matchId)); } catch (_) {}
}

function roleForSocket(match, sid) {
  if (!match?.players?.A?.id || !match?.players?.B?.id) return null;
  if (match.players.A.id === sid) return "A";
  if (match.players.B.id === sid) return "B";
  return null;
}

function minimalRoomView(room) {
  return {
    id: room.id,
    name: room.name,
    hasPassword: !!room.hasPassword,
    players: Array.isArray(room.players) ? room.players.length : 0,
    status: room.status || "waiting",
  };
}

async function emitRoomsUpdated() {
  const rooms = await getRooms();
  io.emit("rooms_updated", (rooms || []).map(minimalRoomView));
}

function safeEmitReject(socket, matchId, reason, extra = {}) {
  socket.emit("pvp_reject", { matchId, reason, ...extra });
}

function createInitialState() {
  // Estado mínimo para bootstrap. O front manda snapshots completos após ações.
  return {
    playerA: { hp: 1000, maxHp: 1000, def: 20, pi: 7, hand: [], deck: [], gy: [], field: {}, teamEffects: [] },
    playerB: { hp: 1000, maxHp: 1000, def: 20, pi: 7, hand: [], deck: [], gy: [], field: {}, teamEffects: [] },
  };
}

async function removePlayerFromRooms(socketId) {
  const rooms = await getRooms();
  let changed = false;
  const affectedRooms = [];

  for (const room of rooms) {
    const before = room.players?.length || 0;
    if (Array.isArray(room.players)) {
      room.players = room.players.filter((p) => p.id !== socketId);
      if (room.players.length !== before) {
        changed = true;
        affectedRooms.push(room);
        // se sala ficou vazia, marca pra remover
        if (room.players.length === 0) room._delete = true;
        // se estava jogando e alguém saiu, volta pra waiting (match encerra em outro lugar)
        if (room.status === "playing") room.status = "waiting";
      }
    }
  }

  if (changed) {
    const kept = rooms.filter((r) => !r._delete);
    await saveRooms(kept);
    // atualiza room_state para quem restou
    for (const room of affectedRooms) {
      if (room._delete) continue;
      io.to(room.id).emit("room_state", room);
    }
    await emitRoomsUpdated();
  }
}

// -------------------- Socket.IO --------------------
io.on("connection", async (socket) => {
  console.log("[SOCKET] connected", socket.id);

  // Compat legado: alguns fronts antigos chamam ping_rooms
  socket.on("ping_rooms", async () => {
    await emitRoomsUpdated();
  });

  // -------- Lobby: listar salas (front novo) --------
  socket.on("rooms_list", async () => {
    await emitRoomsUpdated();
  });

  // -------- Lobby: criar sala --------
  socket.on("create_room", async ({ name, password }, ack) => {
    try {
      const rooms = await getRooms();
      const roomId = uid("match");
      const room = {
        id: roomId,
        name: (name && String(name).trim()) || "Sala",
        hasPassword: !!(password && String(password).length > 0),
        passwordHash: password ? sha256(password) : null,
        players: [{ id: socket.id, name: "Jogador 1", ready: false, deck: [] }],
        status: "waiting",
        createdAt: Date.now(),
      };
      rooms.push(room);
      await saveRooms(rooms);

      socket.join(roomId);

      // confirma via ack (mais confiável que depender só de event)
      if (typeof ack === "function") ack({ ok: true, room });

      // mantém compat: evento para o client e atualiza lista global
      socket.emit("room_state", room);
      await emitRoomsUpdated();
    } catch (e) {
      console.error("[create_room] error", e);
      if (typeof ack === "function") ack({ ok: false, error: "Falha ao criar sala." });
      socket.emit("error_msg", "Falha ao criar sala.");
    }
  });

  // -------- Lobby: entrar em sala --------
  socket.on("join_room", async ({ roomId, password }, ack) => {
    try {
      const rooms = await getRooms();
      const room = rooms.find((r) => r.id === roomId);
      if (!room) {
        if (typeof ack === "function") ack({ ok: false, error: "Sala não encontrada." });
        return socket.emit("error_msg", "Sala não encontrada.");
      }

      // já está na sala?
      if (room.players?.some((p) => p.id === socket.id)) {
        socket.join(roomId);
        if (typeof ack === "function") ack({ ok: true, room });
        socket.emit("room_state", room);
        return;
      }

      if ((room.players?.length || 0) >= 2) {
        if (typeof ack === "function") ack({ ok: false, error: "Sala cheia." });
        return socket.emit("error_msg", "Sala cheia.");
      }

      if (room.hasPassword) {
        if (!password || sha256(password) !== room.passwordHash) {
          if (typeof ack === "function") ack({ ok: false, error: "Senha inválida." });
          return socket.emit("error_msg", "Senha inválida.");
        }
      }

      room.players = room.players || [];
      room.players.push({
        id: socket.id,
        name: room.players.length === 0 ? "Jogador 1" : "Jogador 2",
        ready: false,
        deck: [],
      });
      room.status = "waiting";

      await saveRooms(rooms);

      socket.join(roomId);

      if (typeof ack === "function") ack({ ok: true, room });

      io.to(roomId).emit("room_state", room);
      await emitRoomsUpdated();
    } catch (e) {
      console.error("[join_room] error", e);
      if (typeof ack === "function") ack({ ok: false, error: "Falha ao entrar na sala." });
      socket.emit("error_msg", "Falha ao entrar na sala.");
    }
  });

  // -------- Lobby: sair da sala --------
  socket.on("leave_room", async () => {
    const rooms = await getRooms();
    const room = rooms.find((r) => r.players?.some((p) => p.id === socket.id));
    if (!room) return;

    socket.leave(room.id);
    room.players = (room.players || []).filter((p) => p.id !== socket.id);

    // se sala vazia, remove
    const kept = room.players.length === 0 ? rooms.filter((r) => r.id !== room.id) : rooms;

    // se ficou 1, reseta ready/status
    if (room.players.length === 1) {
      room.players[0].ready = false;
      room.status = "waiting";
    }

    await saveRooms(kept);

    // atualiza UI de quem ficou
    if (room.players.length > 0) io.to(room.id).emit("room_state", room);
    await emitRoomsUpdated();
  });

  // -------- Ready/Start match --------
  socket.on("set_ready", async ({ ready, deck }) => {
    const rooms = await getRooms();
    const room = rooms.find((r) => r.players?.some((p) => p.id === socket.id));
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    player.ready = !!ready;
    player.deck = Array.isArray(deck) ? deck : [];

    await saveRooms(rooms);
    io.to(room.id).emit("room_state", room);

    if (room.players.length === 2 && room.players.every((p) => p.ready) && room.status !== "playing") {
      room.status = "playing";
      await saveRooms(rooms);

      const [p1, p2] = room.players;

      const match = {
        matchId: room.id,
        status: "playing",
        createdAt: Date.now(),

        turn: "A",
        serverSeq: 0,
        lastAction: null,

        players: {
          A: { id: p1.id, deck: p1.deck || [] },
          B: { id: p2.id, deck: p2.deck || [] },
        },

        // snapshot autoritário (inicia mínimo, depois o client manda completo)
        state: createInitialState(),
      };

      await saveMatch(match);

      // garante que os 2 sockets estão no room do match
      io.sockets.sockets.get(p1.id)?.join(match.matchId);
      io.sockets.sockets.get(p2.id)?.join(match.matchId);

      console.log("[MATCH_START]", match.matchId, "A=", p1.id, "B=", p2.id);

      io.to(p1.id).emit("match_start", {
        matchId: match.matchId,
        yourRole: "A",
        you: match.state.playerA,
        opp: match.state.playerB,
        youDeck: match.players.A.deck,
        oppDeck: match.players.B.deck,
        turn: match.turn,
      });

      io.to(p2.id).emit("match_start", {
        matchId: match.matchId,
        yourRole: "B",
        you: match.state.playerB,
        opp: match.state.playerA,
        youDeck: match.players.B.deck,
        oppDeck: match.players.A.deck,
        turn: match.turn,
      });

      io.to(match.matchId).emit("sync_state", {
        matchId: match.matchId,
        state: match.state,
        turn: match.turn,
        serverSeq: match.serverSeq,
      });
    }
  });

  // -------- RESYNC --------
  socket.on("pvp_request_sync", async ({ matchId }) => {
    const match = await getMatch(matchId);
    if (!match) return safeEmitReject(socket, matchId, "MATCH_NOT_FOUND");

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
      lastAction: match.lastAction || null,
    });
  });

  // -------- PVP ACTION (autoritário em turno + seq + snapshot) --------
  socket.on("pvp_action", async ({ matchId, type, payload, clientSeq }) => {
    const match = await getMatch(matchId);
    if (!match) return safeEmitReject(socket, matchId, "MATCH_NOT_FOUND");

    const role = roleForSocket(match, socket.id);
    if (!role) return safeEmitReject(socket, matchId, "NOT_IN_MATCH");

    socket.join(matchId);

    // Turno autoritário
    if (match.turn !== role) return safeEmitReject(socket, matchId, "NOT_YOUR_TURN", { turn: match.turn });

    match.serverSeq = (match.serverSeq || 0) + 1;

    // Snapshot autoritário: payload.state deve ser { playerA, playerB }
    if (payload && payload.state && payload.state.playerA && payload.state.playerB) {
      match.state = payload.state;
    }

    // Regras mínimas autoritárias de turno
    if (type === "PASS_TURN" || type === "END_TURN") {
      match.turn = match.turn === "A" ? "B" : "A";
    }

    match.lastAction = {
      serverSeq: match.serverSeq,
      fromRole: role,
      type,
      payload: payload ?? null,
      clientSeq: clientSeq ?? null,
      ts: Date.now(),
    };

    await saveMatch(match);

    // broadcast para os 2 (inclusive sender)
    io.to(matchId).emit("pvp_action", {
      matchId,
      serverSeq: match.serverSeq,
      fromRole: role,
      type,
      payload: payload ?? null,
      turn: match.turn,
    });

    // mini sync periódico (a cada 5 ações) ou sempre que receber snapshot
    const shouldSync = (match.serverSeq % 5 === 0) || (payload && payload.state);
    if (shouldSync) {
      io.to(matchId).emit("sync_state", {
        matchId,
        state: match.state,
        turn: match.turn,
        serverSeq: match.serverSeq,
      });
    }
  });

  // -------- Disconnect handling --------
  socket.on("disconnect", async (reason) => {
    console.log("[SOCKET] disconnected", socket.id, "reason=", reason);

    // 1) se estava em algum match, encerra com segurança
    // (a) tenta descobrir matchId pelo ROOMS (status playing) para não iterar Redis keys
    const rooms = await getRooms();
    const playingRoom = rooms.find((r) => r.status === "playing" && r.players?.some((p) => p.id === socket.id));
    if (playingRoom) {
      const matchId = playingRoom.id;
      const match = await getMatch(matchId);
      if (match) {
        const role = roleForSocket(match, socket.id);
        const otherRole = role === "A" ? "B" : "A";
        const otherId = match.players?.[otherRole]?.id;

        if (otherId) io.to(otherId).emit("opponent_left", { matchId });

        await delMatch(matchId);
      }
    }

    // 2) remove de salas e limpa salas vazias
    await removePlayerFromRooms(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on", PORT));
