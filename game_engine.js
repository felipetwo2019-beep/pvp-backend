const {
  BOARD_ROWS,
  BOARD_COLS,
  PLAYER_FRONT_ROW,
  PLAYER_BACK_ROW,
  OPP_FRONT_ROW,
  OPP_BACK_ROW,
  STARTING_HP,
  STARTING_DEF,
  STARTING_PI,
  STARTING_HAND,
  DRAW_PER_TURN,
  INTENTS
} = require('./shared_constants');
const { CARD_DATABASE } = require('./shared_cards');

const createRng = (seed = Date.now()) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

let uidCounter = 0;
const generateUid = (prefix) => `${prefix}_${Date.now()}_${uidCounter++}`;

const createCardInstance = (card, ownerId, rng) => ({
  ...card,
  uid: generateUid(ownerId),
  owner: ownerId,
  originalOwner: ownerId,
  currentHp: card.hp,
  currentAtk: card.atk,
  currentDef: card.def,
  pa: card.pa,
  statusEffects: [],
  turnActionUses: { skill: 0, ult: 0 }
});

const shuffle = (arr, rng) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const buildDeck = (deckList, ownerId, rng) => {
  if (deckList && deckList.length) {
    return deckList.map(card => {
      const base = typeof card === 'string'
        ? CARD_DATABASE.find(c => c.dbId === card)
        : card;
      return createCardInstance(base, ownerId, rng);
    });
  }

  const cardsByRarity = {
    legendary: CARD_DATABASE.filter(c => c.rarity === 'legendary'),
    rare: CARD_DATABASE.filter(c => c.rarity === 'rare'),
    common: CARD_DATABASE.filter(c => c.rarity === 'common'),
    utility: CARD_DATABASE.filter(c => c.rarity === 'utility'),
    epic: CARD_DATABASE.filter(c => c.rarity === 'epic')
  };

  const deck = [];
  const addCardsToDeck = (pool, maxTotal, maxCopies) => {
    const shuffled = shuffle(pool, rng);
    let count = 0;
    const addedIds = {};
    for (const card of shuffled) {
      if (count >= maxTotal) break;
      const currentCopies = addedIds[card.dbId] || 0;
      if (currentCopies < maxCopies) {
        deck.push(createCardInstance(card, ownerId, rng));
        addedIds[card.dbId] = currentCopies + 1;
        count += 1;
      }
    }
  };

  addCardsToDeck(cardsByRarity.legendary, 5, 1);
  addCardsToDeck(cardsByRarity.rare, 10, 2);
  addCardsToDeck(cardsByRarity.epic, 5, 1);
  addCardsToDeck(cardsByRarity.common, 25, 3);
  addCardsToDeck(cardsByRarity.utility, 10, 2);

  return shuffle(deck, rng);
};

const createPlayerState = (player, deck, rng) => ({
  id: player.id,
  name: player.name,
  hp: STARTING_HP,
  maxHp: STARTING_HP,
  def: STARTING_DEF,
  pi: STARTING_PI,
  hand: [],
  deck,
  gy: [],
  field: {},
  flags: {},
  rng
});

const drawCard = (entity) => {
  if (!entity.deck.length) return null;
  const card = entity.deck.pop();
  entity.hand.push(card);
  return card;
};

const resetTurnResources = (entity) => {
  entity.pi = STARTING_PI;
  Object.values(entity.field).forEach(card => {
    card.pa = Math.min(10, card.pa + 2);
    card.hasActed = false;
    card.turnActionUses = { skill: 0, ult: 0 };
  });
};

const calcDamage = (attacker, defender, ignoreDef = false) => {
  const atk = attacker.currentAtk ?? attacker.atk;
  const def = defender?.currentDef ?? defender?.def ?? 0;
  const base = ignoreDef ? atk : Math.max(0, atk - def);
  return Math.max(0, Math.floor(base));
};

const isPlayerRow = (playerIndex, row) => {
  if (playerIndex === 0) return row === PLAYER_FRONT_ROW || row === PLAYER_BACK_ROW;
  return row === OPP_FRONT_ROW || row === OPP_BACK_ROW;
};

const validateIntent = (state, playerId, intent) => {
  if (!state || !intent) return { ok: false, error: 'Intent inválida.' };
  if (state.activePlayerId !== playerId) return { ok: false, error: 'Não é seu turno.' };
  return { ok: true };
};

const applyIntent = (state, playerId, intent) => {
  const player = state.players[playerId];
  const opponentId = state.turnOrder.find(id => id !== playerId);
  const opponent = state.players[opponentId];
  const events = [];
  const logLines = [];

  const log = (message) => {
    logLines.push(message);
    state.logs.push(message);
  };

  switch (intent.type) {
    case INTENTS.PLAY_CARD: {
      const { cardInstanceId, position } = intent.payload || {};
      const cardIdx = player.hand.findIndex(card => card.uid === cardInstanceId);
      if (cardIdx === -1) return { error: 'Carta não encontrada na mão.' };
      const card = player.hand[cardIdx];
      if (card.rarity === 'utility') return { error: 'Use cartas utilitárias com USE_UTILITY.' };
      if (player.pi < card.piCost) return { error: 'PI insuficiente.' };
      if (!position || typeof position.r !== 'number' || typeof position.c !== 'number') return { error: 'Posição inválida.' };
      if (!isPlayerRow(state.turnOrder.indexOf(playerId), position.r)) return { error: 'Linha inválida.' };
      const key = `${position.r}-${position.c}`;
      if (player.field[key] || opponent.field[key]) return { error: 'Slot ocupado.' };

      player.hand.splice(cardIdx, 1);
      player.pi -= card.piCost;
      card.r = position.r;
      card.c = position.c;
      player.field[key] = card;
      log(`${player.name} invocou ${card.name}.`);
      events.push({ type: 'summon', cardId: card.uid, position });
      break;
    }
    case INTENTS.USE_UTILITY: {
      const { cardInstanceId, targetId } = intent.payload || {};
      const cardIdx = player.hand.findIndex(card => card.uid === cardInstanceId);
      if (cardIdx === -1) return { error: 'Carta utilitária não encontrada.' };
      const card = player.hand[cardIdx];
      if (card.rarity !== 'utility') return { error: 'Carta não é utilitária.' };
      if (player.pi < card.piCost) return { error: 'PI insuficiente.' };
      const target = Object.values(player.field).find(c => c.uid === targetId) ||
        Object.values(opponent.field).find(c => c.uid === targetId);
      if (!target) return { error: 'Alvo inválido.' };

      player.hand.splice(cardIdx, 1);
      player.pi -= card.piCost;
      if (card.effectType === 'add_pa') {
        target.pa = Math.min(10, target.pa + 3);
        log(`${player.name} usou ${card.name} em ${target.name} (+3 PA).`);
      } else {
        log(`${player.name} usou ${card.name} em ${target.name}.`);
      }
      events.push({ type: 'utility', sourceId: card.uid, targetId: target.uid });
      break;
    }
    case INTENTS.ATTACK:
    case INTENTS.USE_SKILL:
    case INTENTS.USE_ULT: {
      const { attackerId, targetId } = intent.payload || {};
      const attacker = Object.values(player.field).find(c => c.uid === attackerId);
      if (!attacker) return { error: 'Atacante inválido.' };
      const action = intent.type === INTENTS.ATTACK ? 'attack' : intent.type === INTENTS.USE_SKILL ? 'skill' : 'ult';
      const cost = action === 'attack' ? 2 : action === 'skill' ? 4 : 7;
      if (attacker.pa < cost) return { error: 'PA insuficiente.' };
      let target = null;
      let targetIsAvatar = false;
      if (targetId === 'opp_avatar') {
        targetIsAvatar = true;
      } else {
        target = Object.values(opponent.field).find(c => c.uid === targetId) ||
          Object.values(player.field).find(c => c.uid === targetId);
        if (!target) return { error: 'Alvo inválido.' };
      }

      attacker.pa -= cost;

      if (targetIsAvatar) {
        const damage = Math.max(0, attacker.currentAtk ?? attacker.atk);
        opponent.hp = Math.max(0, opponent.hp - damage);
        log(`${player.name} atacou o avatar de ${opponent.name} causando ${damage}.`);
      } else {
        const damage = calcDamage(attacker, target, action !== 'attack');
        target.currentHp = Math.max(0, target.currentHp - damage);
        log(`${player.name} usou ${action} em ${target.name} causando ${damage}.`);
        if (target.currentHp <= 0) {
          const owner = target.owner === playerId ? player : opponent;
          const key = `${target.r}-${target.c}`;
          delete owner.field[key];
          owner.gy.push(target);
        }
      }
      events.push({ type: action, sourceId: attacker.uid, targetId });
      break;
    }
    case INTENTS.MOVE_CARD:
    case INTENTS.CONTROL_MOVE: {
      const { sourceId, position } = intent.payload || {};
      const card = Object.values(player.field).find(c => c.uid === sourceId);
      if (!card) return { error: 'Carta inválida.' };
      if (player.pi < 1) return { error: 'PI insuficiente.' };
      if (!position) return { error: 'Posição inválida.' };
      if (!isPlayerRow(state.turnOrder.indexOf(playerId), position.r)) return { error: 'Linha inválida.' };
      const key = `${position.r}-${position.c}`;
      if (player.field[key] || opponent.field[key]) return { error: 'Slot ocupado.' };
      const oldKey = `${card.r}-${card.c}`;
      delete player.field[oldKey];
      card.r = position.r;
      card.c = position.c;
      player.field[key] = card;
      player.pi -= 1;
      log(`${player.name} moveu ${card.name}.`);
      events.push({ type: 'move', sourceId: card.uid, position });
      break;
    }
    case INTENTS.DRAW_CARD: {
      const drawn = drawCard(player);
      if (!drawn) return { error: 'Deck vazio.' };
      log(`${player.name} comprou uma carta.`);
      events.push({ type: 'draw', playerId });
      break;
    }
    case INTENTS.END_TURN: {
      const nextId = opponentId;
      state.activePlayerId = nextId;
      state.turn += 1;
      resetTurnResources(state.players[nextId]);
      for (let i = 0; i < DRAW_PER_TURN; i += 1) drawCard(state.players[nextId]);
      log(`Turno de ${state.players[nextId].name}.`);
      events.push({ type: 'end_turn', nextPlayerId: nextId });
      break;
    }
    default:
      return { error: 'Intent desconhecida.' };
  }

  return { newState: state, events, logLines };
};

const createMatchState = (players, seed = Date.now(), decks = {}) => {
  const rng = createRng(seed);
  const [p1, p2] = players;
  const p1Deck = buildDeck(decks[p1.id], p1.id, rng);
  const p2Deck = buildDeck(decks[p2.id], p2.id, rng);
  const state = {
    id: `match_${Date.now()}`,
    seed,
    turn: 1,
    activePlayerId: rng() > 0.5 ? p1.id : p2.id,
    turnOrder: [p1.id, p2.id],
    players: {
      [p1.id]: createPlayerState(p1, p1Deck, rng),
      [p2.id]: createPlayerState(p2, p2Deck, rng)
    },
    logs: []
  };

  for (let i = 0; i < STARTING_HAND; i += 1) {
    drawCard(state.players[p1.id]);
    drawCard(state.players[p2.id]);
  }

  resetTurnResources(state.players[state.activePlayerId]);
  return state;
};

const serializeState = (state, viewerId) => {
  const opponentId = state.turnOrder.find(id => id !== viewerId);
  const packPlayer = (player, revealHand) => ({
    id: player.id,
    name: player.name,
    hp: player.hp,
    maxHp: player.maxHp,
    def: player.def,
    pi: player.pi,
    hand: revealHand ? player.hand : player.hand.map(() => ({ hidden: true })),
    handCount: player.hand.length,
    deckCount: player.deck.length,
    gy: player.gy,
    field: player.field,
    flags: player.flags
  });

  return {
    id: state.id,
    turn: state.turn,
    activePlayerId: state.activePlayerId,
    players: {
      [viewerId]: packPlayer(state.players[viewerId], true),
      [opponentId]: packPlayer(state.players[opponentId], false)
    },
    logs: state.logs
  };
};

module.exports = {
  createMatchState,
  validateIntent,
  applyIntent,
  serializeState
};
