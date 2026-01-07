const BOARD_ROWS = 4;
const BOARD_COLS = 5;
const PLAYER_FRONT_ROW = 2;
const PLAYER_BACK_ROW = 3;
const OPP_FRONT_ROW = 1;
const OPP_BACK_ROW = 0;
const STARTING_HP = 1000;
const STARTING_DEF = 20;
const STARTING_PI = 7;
const STARTING_HAND = 5;
const DRAW_PER_TURN = 2;

const INTENTS = {
  PLAY_CARD: 'PLAY_CARD',
  ATTACK: 'ATTACK',
  USE_SKILL: 'USE_SKILL',
  USE_ULT: 'USE_ULT',
  USE_UTILITY: 'USE_UTILITY',
  MOVE_CARD: 'MOVE_CARD',
  CONTROL_MOVE: 'CONTROL_MOVE',
  END_TURN: 'END_TURN',
  DRAW_CARD: 'DRAW_CARD',
  SELECT_TARGET: 'SELECT_TARGET'
};

const SERVER_EVENTS = {
  STATE: 'match:state',
  EVENTS: 'match:events',
  ERROR: 'match:error',
  ACK: 'match:ack'
};

if (typeof module !== 'undefined') {
  module.exports = {
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
    INTENTS,
    SERVER_EVENTS
  };
}

if (typeof window !== 'undefined') {
  window.SHARED_CONSTANTS = {
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
    INTENTS,
    SERVER_EVENTS
  };
}
