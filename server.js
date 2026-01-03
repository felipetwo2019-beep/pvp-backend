import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN, credentials: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN, methods: ["GET", "POST"] },
});

const rooms = new Map(); // roomId -> room
const socketToRoom = new Map(); // socket.id -> roomId

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function roomPublicState(room) {
  return {
    id: room.id,
    name: room.name,
    players: room.players.length,
    locked: !!room.password,
    status: room.status, // 'waiting'|'in-game'
  };
}

function broadcastRooms() {
  const list = [...rooms.values()].map(roomPublicState);
  io.emit("rooms:state", list);
}

function broadcastRoomUpdate(room) {
  const decksText = room.players.map(p => `${p.seat}:${p.deckName || "Deck"}`).join(" | ");
  const readyText = room.players.map(p => `${p.seat}:${p.ready ? "✅" : "⏳"}`).join(" | ");
  io.to(room.id).emit("room:update", {
    roomId: room.id,
    players: room.players.length,
    status: room.status,
    decksText,
    readyText,
  });
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.players.length === 0) {
    rooms.delete(roomId);
    broadcastRooms();
  }
}

io.on("connection", (socket) => {
  // basic naive rate limit
  let lastMsgAt = 0;
  function rateLimit() {
    const now = Date.now();
    if (now - lastMsgAt < 30) return false;
    lastMsgAt = now;
    return true;
  }

  socket.on("rooms:list", () => {
    if (!rateLimit()) return;
    const list = [...rooms.values()].map(roomPublicState);
    socket.emit("rooms:state", list);
  });

  socket.on("room:create", ({ name, password = "", deckName = "Deck", playerName = "Player" } = {}) => {
    if (!rateLimit()) return;
    try {
      if (!name || typeof name !== "string" || name.trim().length < 2) {
        socket.emit("room:error", "Nome de sala inválido.");
        return;
      }
      const id = makeId();
      const room = {
        id,
        name: name.trim().slice(0, 40),
        password: password ? String(password) : "",
        status: "waiting",
        players: [],
      };
      rooms.set(id, room);

      // auto-join creator
      const seat = "A";
      room.players.push({ socketId: socket.id, seat, deckName, playerName, ready: false });
      socket.join(id);
      socketToRoom.set(socket.id, id);

      socket.emit("room:joined", { roomId: id, roomName: room.name, seat, players: room.players.length, decksText: `A:${deckName}` });
      broadcastRoomUpdate(room);
      broadcastRooms();
    } catch (e) {
      socket.emit("room:error", "Falha ao criar sala.");
    }
  });

  socket.on("room:join", ({ roomId, password = "", deckName = "Deck", playerName = "Player" } = {}) => {
    if (!rateLimit()) return;
    const room = rooms.get(roomId);
    if (!room) return socket.emit("room:error", "Sala não existe.");
    if (room.players.length >= 2) return socket.emit("room:error", "Sala cheia.");
    if (room.password && room.password !== String(password || "")) return socket.emit("room:error", "Senha incorreta.");

    const seat = room.players.some(p => p.seat === "A") ? "B" : "A";
    room.players.push({ socketId: socket.id, seat, deckName, playerName, ready: false });
    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);

    const decksText = room.players.map(p => `${p.seat}:${p.deckName}`).join(" | ");
    socket.emit("room:joined", { roomId, roomName: room.name, seat, players: room.players.length, decksText });
    broadcastRoomUpdate(room);
    broadcastRooms();
  });

  socket.on("room:leave", ({ roomId } = {}) => {
    if (!rateLimit()) return;
    const id = roomId || socketToRoom.get(socket.id);
    if (!id) return;
    const room = rooms.get(id);
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);
    socket.leave(id);
    socketToRoom.delete(socket.id);

    broadcastRoomUpdate(room);
    cleanupRoomIfEmpty(id);
  });

  socket.on("room:ready", ({ roomId } = {}) => {
    if (!rateLimit()) return;
    const id = roomId || socketToRoom.get(socket.id);
    const room = rooms.get(id);
    if (!room) return socket.emit("room:error", "Sala não existe.");

    const p = room.players.find(p => p.socketId === socket.id);
    if (!p) return;
    p.ready = true;

    broadcastRoomUpdate(room);

    if (room.players.length === 2 && room.players.every(p => p.ready) && room.status !== "in-game") {
      room.status = "in-game";
      // Notify each seat
      for (const pl of room.players) {
        io.to(pl.socketId).emit("match:start", { roomId: room.id, seat: pl.seat });
      }
      broadcastRooms();
    }
  });

  // Seat B -> server -> seat A (host) : action intents
  socket.on("action:intent", ({ roomId, intent } = {}) => {
    if (!rateLimit()) return;
    const id = roomId || socketToRoom.get(socket.id);
    const room = rooms.get(id);
    if (!room) return;

    const from = room.players.find(p => p.socketId === socket.id);
    if (!from) return;

    const host = room.players.find(p => p.seat === "A");
    if (!host) return;

    // Only forward intents from non-host (B) to host
    if (from.seat !== "B") return;

    io.to(host.socketId).emit("match:intent", { roomId: id, fromSeat: from.seat, intent });
  });

  // Seat A -> server -> seat B : state snapshots
  socket.on("match:state", ({ roomId, state } = {}) => {
    if (!rateLimit()) return;
    const id = roomId || socketToRoom.get(socket.id);
    const room = rooms.get(id);
    if (!room) return;

    const from = room.players.find(p => p.socketId === socket.id);
    if (!from || from.seat !== "A") return;

    const other = room.players.find(p => p.seat === "B");
    if (!other) return;

    io.to(other.socketId).emit("match:state", { roomId: id, state });
  });

  socket.on("disconnect", () => {
    const id = socketToRoom.get(socket.id);
    if (!id) return;
    const room = rooms.get(id);
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);
    socketToRoom.delete(socket.id);
    broadcastRoomUpdate(room);
    cleanupRoomIfEmpty(id);
  });
});

server.listen(PORT, () => {
  console.log(`PVP server listening on :${PORT}`);
});
