// Automationen & Erinnerungen: zeitgesteuerte Hintergrundaufgaben (Cron) und einmalige Erinnerungen.
import cron from 'node-cron';
import { config } from '../config.js';
import { bus, uid } from '../core/bus.js';
import { JsonStore } from '../core/store.js';
import { registerTool } from './registry.js';

const store = new JsonStore('automations', { items: [] });
const running = new Map(); // id -> {stop()}
let handlers = { reminder: () => {}, task: () => {} };

export function setAutomationHandlers(h) {
  handlers = h;
}

export function automationsSnapshot() {
  return store.data.items.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    schedule: a.cron || a.at,
    next: nextRun(a),
    lastRun: a.lastRun || null,
  }));
}
function emit() {
  bus.broadcast('automations', { items: automationsSnapshot() });
}
function nextRun(a) {
  const job = running.get(a.id);
  if (a.at) return a.at;
  try {
    return job?.getNextRun?.()?.toISOString?.() || null;
  } catch {
    return null;
  }
}

function fire(a) {
  a.lastRun = new Date().toISOString();
  store.save();
  bus.broadcast('notification', { level: 'info', title: a.kind === 'reminder' ? 'Erinnerung' : `Automation: ${a.name}`, body: a.text || a.prompt });
  if (a.kind === 'reminder') handlers.reminder(a);
  else handlers.task(a);
  if (a.at) remove(a.id);
  emit();
}

function schedule(a) {
  if (a.cron) {
    const job = cron.schedule(a.cron, () => fire(a), { timezone: config.timezone, name: a.id });
    running.set(a.id, job);
  } else if (a.at) {
    const ms = new Date(a.at).getTime() - Date.now();
    if (ms < -60_000) {
      // Während Jarvis aus war fällig geworden → einmalig nachholen
      setTimeout(() => fire(a), 3000);
      return;
    }
    // setTimeout ist auf ~24,8 Tage begrenzt – in Etappen warten
    const arm = () => {
      const left = new Date(a.at).getTime() - Date.now();
      const t = setTimeout(left > 2 ** 31 - 1 ? arm : () => fire(a), Math.max(0, Math.min(left, 2 ** 31 - 1)));
      running.set(a.id, { stop: () => clearTimeout(t) });
    };
    arm();
  }
}

function remove(id) {
  running.get(id)?.stop();
  running.delete(id);
  store.data.items = store.data.items.filter((a) => a.id !== id);
  store.save();
}

export function startAutomations() {
  for (const a of store.data.items) schedule(a);
  emit();
}

registerTool({
  name: 'reminder_create',
  label: 'Erinnerung',
  group: 'automation',
  description: 'Erstellt eine einmalige Erinnerung, die Jarvis zum Zeitpunkt laut ausspricht. Entweder in_minutes oder at (ISO-Zeitpunkt in Nutzerzeit).',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' }, in_minutes: { type: 'number' }, at: { type: 'string' } },
    required: ['text'],
  },
  async run({ text, in_minutes, at }) {
    const when = in_minutes !== undefined ? new Date(Date.now() + in_minutes * 60_000) : at ? new Date(at) : null;
    if (!when || Number.isNaN(when.getTime())) throw new Error('Zeitpunkt fehlt oder ungültig');
    const a = { id: uid('rem'), kind: 'reminder', name: text.slice(0, 40), text, at: when.toISOString() };
    store.data.items.push(a);
    store.save();
    schedule(a);
    emit();
    return { id: a.id, at: when.toLocaleString('de-DE', { timeZone: config.timezone }) };
  },
});

registerTool({
  name: 'automation_create',
  label: 'Automation anlegen',
  group: 'automation',
  description:
    'Legt eine wiederkehrende Automation an: Zu den Cron-Zeiten startet Jarvis einen Hintergrund-Agenten mit dem angegebenen Auftrag (z.B. tägliches Briefing um 7:30 = "30 7 * * *"). Zeitzone: ' +
    config.timezone,
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      cron: { type: 'string', description: 'Cron-Ausdruck (Minute Stunde Tag Monat Wochentag)' },
      prompt: { type: 'string', description: 'Vollständiger Auftrag für den Hintergrund-Agenten' },
      speak: { type: 'boolean', description: 'Ergebnis-Kurzfassung laut ansagen' },
    },
    required: ['name', 'cron', 'prompt'],
  },
  async run({ name, cron: expr, prompt, speak = true }) {
    if (!cron.validate(expr)) throw new Error(`Ungültiger Cron-Ausdruck: ${expr}`);
    const a = { id: uid('auto'), kind: 'task', name, cron: expr, prompt, speak };
    store.data.items.push(a);
    store.save();
    schedule(a);
    emit();
    return { id: a.id, next: nextRun(a) };
  },
});

registerTool({
  name: 'automation_list',
  label: 'Automationen',
  group: 'automation',
  description: 'Listet alle Automationen und Erinnerungen.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    return automationsSnapshot();
  },
});

registerTool({
  name: 'automation_delete',
  label: 'Automation löschen',
  group: 'automation',
  description: 'Löscht eine Automation oder Erinnerung.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async run({ id }) {
    remove(id);
    emit();
    return 'Gelöscht.';
  },
});
