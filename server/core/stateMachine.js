// Conversation-State-Machine: die einzige Quelle der Wahrheit für den Gesprächszustand.
import { bus } from './bus.js';

export const S = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
  INTERRUPTED: 'interrupted',
  EXECUTING: 'executing',
  ERROR: 'error',
});

// Erlaubte Übergänge. Alles andere wird abgelehnt und protokolliert.
const TRANSITIONS = {
  [S.IDLE]: [S.LISTENING, S.PROCESSING, S.SPEAKING, S.EXECUTING, S.ERROR],
  [S.LISTENING]: [S.IDLE, S.PROCESSING, S.SPEAKING, S.EXECUTING, S.INTERRUPTED, S.ERROR],
  [S.PROCESSING]: [S.SPEAKING, S.EXECUTING, S.INTERRUPTED, S.IDLE, S.LISTENING, S.ERROR],
  [S.EXECUTING]: [S.PROCESSING, S.SPEAKING, S.INTERRUPTED, S.IDLE, S.LISTENING, S.ERROR],
  [S.SPEAKING]: [S.LISTENING, S.IDLE, S.INTERRUPTED, S.EXECUTING, S.PROCESSING, S.ERROR],
  [S.INTERRUPTED]: [S.LISTENING, S.IDLE, S.PROCESSING, S.SPEAKING, S.EXECUTING, S.ERROR],
  [S.ERROR]: [S.IDLE, S.LISTENING, S.PROCESSING],
};

export class ConversationStateMachine {
  constructor() {
    this.state = S.IDLE;
    this.since = Date.now();
    this.detail = '';
    this.history = [];
  }

  can(to) {
    return to === this.state || (TRANSITIONS[this.state] || []).includes(to);
  }

  /**
   * @param {string} to Zielzustand
   * @param {string} [detail] Klartext-Beschreibung für die UI
   * @returns {boolean} ob der Übergang durchgeführt wurde
   */
  transition(to, detail = '') {
    if (!this.can(to)) {
      console.warn(`[state] Ungültiger Übergang ${this.state} → ${to} (ignoriert)`);
      return false;
    }
    if (to === this.state && detail === this.detail) return true;
    const from = this.state;
    this.state = to;
    this.detail = detail;
    this.since = Date.now();
    this.history.push({ from, to, at: this.since });
    if (this.history.length > 50) this.history.shift();
    bus.broadcast('state', { state: to, from, detail });
    return true;
  }

  is(...states) {
    return states.includes(this.state);
  }

  snapshot() {
    return { state: this.state, detail: this.detail, since: this.since };
  }
}
