const { createMatchState, validateIntent, applyIntent, serializeState } = require('./game_engine');

const matches = new Map();

const createMatch = (room) => {
  const seed = Date.now();
  const decks = room.players.reduce((acc, player) => {
    acc[player.id] = player.deck || [];
    return acc;
  }, {});
  const matchState = createMatchState(room.players, seed, decks);
  const match = {
    id: matchState.id,
    roomId: room.id,
    state: matchState
  };
  matches.set(room.id, match);
  return match;
};

const getMatchByRoom = (roomId) => matches.get(roomId);

const handleIntent = (match, playerId, intent) => {
  const validation = validateIntent(match.state, playerId, intent);
  if (!validation.ok) return { error: validation.error };
  const result = applyIntent(match.state, playerId, intent);
  if (result.error) return { error: result.error };
  match.state = result.newState;
  return {
    state: match.state,
    events: result.events || [],
    logLines: result.logLines || []
  };
};

const getStateForPlayer = (match, playerId) => serializeState(match.state, playerId);

module.exports = {
  createMatch,
  getMatchByRoom,
  handleIntent,
  getStateForPlayer
};
