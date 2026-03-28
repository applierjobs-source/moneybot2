const { EventEmitter } = require("events");

class EventBus extends EventEmitter {}

// Single shared instance so SSE and the runner see the same events.
const bus = new EventBus();

module.exports = { bus };

