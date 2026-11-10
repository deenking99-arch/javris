// Bestätigungen für risikoreiche Aktionen (Shell, Löschen, neue MCP-Server …).
// Beantwortbar per Sprache ("Ja"/"Nein") oder per Button im Interface.
import { bus, uid } from './bus.js';

const pending = new Map();
const TIMEOUT_MS = 120_000;

/**
 * Fragt den Nutzer. Resolves true (bestätigt) / false (abgelehnt, Timeout, abgebrochen).
 * @param {{title:string, detail?:string, speak?:string, signal?:AbortSignal}} req
 */
export function requestConfirmation({ title, detail = '', speak, signal }) {
  const id = uid('confirm');
  return new Promise((resolve) => {
    const finish = (ok, reason) => {
      if (!pending.has(id)) return;
      clearTimeout(entry.timer);
      pending.delete(id);
      bus.broadcast('confirm_resolved', { id, approved: ok, reason });
      resolve(ok);
    };
    const entry = { id, title, detail, finish, timer: setTimeout(() => finish(false, 'timeout'), TIMEOUT_MS) };
    pending.set(id, entry);
    signal?.addEventListener('abort', () => finish(false, 'aborted'), { once: true });
    bus.broadcast('confirm_request', { id, title, detail });
    bus.emit('confirm_speak', speak || `Bestätigung erforderlich: ${title}. Soll ich fortfahren?`);
  });
}

export function resolveConfirmation(id, approved) {
  const e = pending.get(id);
  if (!e) return false;
  e.finish(Boolean(approved), approved ? 'user' : 'denied');
  return true;
}

export function hasPendingConfirmation() {
  return pending.size > 0;
}

/** Wertet eine gesprochene Antwort auf die älteste offene Bestätigung aus. */
export function answerPendingByVoice(text) {
  const first = pending.values().next().value;
  if (!first) return null;
  const t = text.toLowerCase().trim();
  if (/^(ja|jawohl|jep|genau|bestätig|mach (das|es)|mach weiter|ok|okay|los|fortfahren|ausführen|einverstanden|yes)/.test(t)) {
    first.finish(true, 'voice');
    return true;
  }
  if (/^(nein|nee|stopp?|abbrechen|nicht|lieber nicht|halt|no)\b/.test(t)) {
    first.finish(false, 'voice');
    return false;
  }
  return null; // keine eindeutige Antwort
}

export function listPending() {
  return [...pending.values()].map(({ id, title, detail }) => ({ id, title, detail }));
}
