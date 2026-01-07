const { INTENTS, SERVER_EVENTS } = require('./shared_constants');

const CLIENT_EVENTS = {
  INTENT: 'match:intent',
  ACK: 'match:ack',
  ERROR: 'match:error'
};

module.exports = {
  INTENTS,
  SERVER_EVENTS,
  CLIENT_EVENTS
};
