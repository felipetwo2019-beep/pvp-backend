const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { listRooms, createRoom, joinRoom, leaveRoom, setReady, getRoom } = require('./rooms');
const { createMatch, getMatchByRoom, handleIntent, getStateForPlayer } = require('./match');
const { SERVER_EVENTS } = require('./shared_constants');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const socketToRoom = new Map();

const broadcastLobby = () => {
  io.emit('lobby:list', listRooms());
};

const broadcastRoom = (roomId) => {
  const room = getRoom(roomId);
  if (!room) return;
  io.to(roomId).emit('room:update', {
    id: room.id,
    name: room.name,
    players: room.players,
    status: room.status
  });
};

const tryStartMatch = (room) => {
  if (room.players.length !== 2) return;
  if (!room.players.every(p => p.ready)) return;
  if (room.status === 'playing') return;

  room.status = 'playing';
  const match = createMatch(room);
  room.match = match.id;
  room.players.forEach(player => {
    io.to(player.id).emit(SERVER_EVENTS.STATE, getStateForPlayer(match, player.id));
  });
};

io.on('connection', (socket) => {
  const player = { id: socket.id, name: `Jogador ${socket.id.slice(0, 4)}` };

  socket.emit('lobby:list', listRooms());

  socket.on('lobby:create', ({ name, deck, playerName }) => {
    if (playerName) player.name = playerName;
    const room = createRoom({ name, owner: player });
    room.players[0].deck = deck || [];
    socketToRoom.set(socket.id, room.id);
    socket.join(room.id);
    broadcastLobby();
    broadcastRoom(room.id);
  });

  socket.on('lobby:refresh', () => {
    socket.emit('lobby:list', listRooms());
  });

  socket.on('lobby:join', ({ roomId, deck, playerName }) => {
    if (playerName) player.name = playerName;
    const { room, error } = joinRoom(roomId, player);
    if (error) {
      socket.emit('lobby:error', error);
      return;
    }
    const joinedPlayer = room.players.find(p => p.id === player.id);
    if (joinedPlayer) joinedPlayer.deck = deck || [];
    socketToRoom.set(socket.id, room.id);
    socket.join(room.id);
    broadcastLobby();
    broadcastRoom(room.id);
  });

  socket.on('room:ready', ({ ready, deck }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;
    const playerEntry = room.players.find(p => p.id === socket.id);
    if (playerEntry && deck) playerEntry.deck = deck;
    const result = setReady(roomId, socket.id, !!ready);
    if (result.error) {
      socket.emit('room:error', result.error);
      return;
    }
    broadcastRoom(roomId);
    tryStartMatch(room);
  });

  socket.on('match:intent', (intent) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const match = getMatchByRoom(roomId);
    if (!match) return;
    const result = handleIntent(match, socket.id, intent);
    if (result.error) {
      socket.emit(SERVER_EVENTS.ERROR, result.error);
      return;
    }
    const room = getRoom(roomId);
    room.players.forEach(playerEntry => {
      io.to(playerEntry.id).emit(SERVER_EVENTS.STATE, getStateForPlayer(match, playerEntry.id));
      if (result.events?.length) {
        io.to(playerEntry.id).emit(SERVER_EVENTS.EVENTS, result.events);
      }
    });
  });

  socket.on('disconnect', () => {
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = leaveRoom(roomId, socket.id);
      socketToRoom.delete(socket.id);
      if (room) {
        broadcastLobby();
        broadcastRoom(roomId);
      } else {
        broadcastLobby();
      }
    }
  });
});

server.listen(3000, () => {
  console.log('Servidor iniciado em http://localhost:3000');
});
