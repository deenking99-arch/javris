// Event-Bus: alle realen Systemereignisse laufen hier durch und werden an die UI gestreamt.
import { EventEmitter } from 'node:events';

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
  /** Sendet ein Ereignis an alle UI-Clients. */
  broadcast(type, payload = {}) {
    this.emit('broadcast', { type, ...payload, ts: Date.now() });
  }
}

export const bus = new Bus();

let counter = 0;
export const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
