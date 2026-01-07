const { randomUUID } = require('crypto');

const rooms = new Map();

const listRooms = () => Array.from(rooms.values()).map(room => ({
  id: room.id,
  name: room.name,
  players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })),
  status: room.status
}));

const createRoom = ({ name, owner }) => {
  const id = randomUUID();
  const room = {
    id,
    name: name || `Sala ${id.slice(0, 4)}`,
    players: [{ id: owner.id, name: owner.name, ready: false }],
    status: 'lobby',
    match: null
  };
  rooms.set(id, room);
  return room;
};

const joinRoom = (roomId, player) => {
  const room = rooms.get(roomId);
  if (!room) return { error: 'Sala não encontrada.' };
  if (room.players.length >= 2) return { error: 'Sala cheia.' };
  if (room.players.some(p => p.id === player.id)) return { room };
  room.players.push({ id: player.id, name: player.name, ready: false });
  return { room };
};

const leaveRoom = (roomId, playerId) => {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.players = room.players.filter(player => player.id !== playerId);
  room.status = room.players.length === 2 ? room.status : 'lobby';
  if (room.players.length === 0) {
    rooms.delete(roomId);
    return null;
  }
  return room;
};

const setReady = (roomId, playerId, ready) => {
  const room = rooms.get(roomId);
  if (!room) return { error: 'Sala não encontrada.' };
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: 'Jogador não está na sala.' };
  player.ready = ready;
  return { room };
};

const getRoom = (roomId) => rooms.get(roomId);

module.exports = {
  listRooms,
  createRoom,
  joinRoom,
  leaveRoom,
  setReady,
  getRoom
};
