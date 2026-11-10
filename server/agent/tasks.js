// Hintergrund-Agenten (Subagenten): führen längere Aufträge parallel zum Gespräch aus.
// Fortschritt, verwendete Tools und Ergebnisse werden live an die UI gemeldet.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { bus, uid } from '../core/bus.js';
import { JsonStore } from '../core/store.js';
import { registerTool } from '../tools/registry.js';
import { runAgentLoop, AbortedError } from './claude.js';
import { TASK_SYSTEM } from './prompts.js';

const MAX_PARALLEL = 3;
const archive = new JsonStore('tasks', { items: [] });
/** @type {Map<string, any>} */
const live = new Map();
const queue = [];
let onFinished = () => {};

export function setTaskFinishedHandler(fn) {
  onFinished = fn;
}

const view = (t) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  origin: t.origin,
  started: t.started,
  finished: t.finished,
  steps: t.steps.slice(-12),
  tools: t.tools,
  summary: t.summary,
  resultFile: t.resultFile,
  error: t.error,
});

export function tasksSnapshot() {
  const recent = archive.data.items.slice(-8).reverse();
  return { running: [...live.values()].map(view), recent };
}
function emit(t) {
  bus.broadcast('task', { task: view(t) });
}

// Tool-Ereignisse der Subagenten in den Task-Zustand übernehmen
bus.on('broadcast', (ev) => {
  if (ev.type !== 'tool' || !ev.taskId) return;
  const t = live.get(ev.taskId);
  if (!t) return;
  if (ev.status === 'running') {
    t.tools[ev.label || ev.name] = (t.tools[ev.label || ev.name] || 0) + 1;
    t.steps.push({ at: Date.now(), kind: 'tool', text: `${ev.label || ev.name}${ev.summary ? `: ${ev.summary}` : ''}` });
    emit(t);
  }
});

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

async function run(t) {
  t.status = 'running';
  t.started = Date.now();
  emit(t);
  const now = new Date().toLocaleString('de-DE', { timeZone: config.timezone, dateStyle: 'full', timeStyle: 'short' });
  const messages = [{ role: 'user', content: `Heute: ${now}\n\nAUFTRAG: ${t.title}\n\n${t.instructions}` }];
  try {
    const res = await runAgentLoop({
      system: TASK_SYSTEM,
      messages,
      kind: 'task',
      signal: t.abort.signal,
      taskId: t.id,
      onProgress: (note) => {
        t.steps.push({ at: Date.now(), kind: 'note', text: note.slice(0, 300) });
        emit(t);
      },
    });
    const text = res.text || '';
    const m = text.match(/^\s*KURZFASSUNG:\s*(.+?)(\n|$)/i);
    t.summary = (m ? m[1] : text.slice(0, 300)).trim();
    const dir = path.join(config.files.outputDir, 'Ergebnisse');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${slug(t.title) || t.id}.md`);
    await fs.writeFile(file, `# ${t.title}\n\n_Erstellt von JARVIS am ${now}_\n\n${text.replace(/^\s*KURZFASSUNG:.*\n?/i, '')}`);
    t.resultFile = file;
    t.result = text;
    t.status = 'done';
  } catch (e) {
    if (e instanceof AbortedError || t.abort.signal.aborted) t.status = 'cancelled';
    else {
      t.status = 'error';
      t.error = e.message;
    }
  }
  t.finished = Date.now();
  emit(t);
  live.delete(t.id);
  archive.data.items.push({ ...view(t), result: t.result?.slice(0, 20_000) });
  archive.data.items = archive.data.items.slice(-50);
  archive.save();
  bus.broadcast('notification', {
    level: t.status === 'done' ? 'success' : t.status === 'cancelled' ? 'info' : 'error',
    title: `Aufgabe ${t.status === 'done' ? 'abgeschlossen' : t.status === 'cancelled' ? 'abgebrochen' : 'fehlgeschlagen'}`,
    body: t.title,
  });
  if (t.status !== 'cancelled') onFinished(t);
  pump();
}

function pump() {
  while ([...live.values()].filter((t) => t.status === 'running').length < MAX_PARALLEL && queue.length) {
    run(queue.shift());
  }
}

export function startTask({ title, instructions, origin = 'gespräch' }) {
  const t = { id: uid('task'), title, instructions, origin, status: 'queued', steps: [], tools: {}, abort: new AbortController() };
  live.set(t.id, t);
  queue.push(t);
  emit(t);
  pump();
  return t;
}

export function cancelTask(id) {
  const t = live.get(id);
  if (!t) return false;
  t.abort.abort();
  const qi = queue.indexOf(t);
  if (qi >= 0) {
    queue.splice(qi, 1);
    t.status = 'cancelled';
    live.delete(id);
    emit(t);
  }
  return true;
}

export function cancelAllTasks() {
  for (const id of [...live.keys()]) cancelTask(id);
}

registerTool({
  name: 'task_start',
  label: 'Hintergrund-Agent starten',
  group: 'tasks',
  mainOnly: true,
  description:
    'Startet einen eigenständigen Hintergrund-Agenten für eine längere Aufgabe (Recherche, Projektzusammenfassung, Einrichtung, Analyse). Liefert sofort eine Task-ID zurück; das Ergebnis wird als Datei gespeichert und dir gemeldet. Die Anweisungen müssen vollständig und eigenständig verständlich sein.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Kurzer Titel, z.B. "Recherche: Robotik-Investments"' },
      instructions: { type: 'string', description: 'Vollständiger Auftrag inkl. aller Details, Ziele und gewünschtem Ergebnisformat.' },
    },
    required: ['title', 'instructions'],
  },
  async run({ title, instructions }) {
    const t = startTask({ title, instructions });
    return { task_id: t.id, status: t.status };
  },
});

registerTool({
  name: 'task_status',
  label: 'Aufgabenstatus',
  group: 'tasks',
  mainOnly: true,
  description: 'Zeigt Status, letzte Schritte und ggf. Ergebnis einer Hintergrundaufgabe (oder aller, wenn keine ID angegeben).',
  input_schema: { type: 'object', properties: { task_id: { type: 'string' } } },
  async run({ task_id }) {
    if (!task_id) return tasksSnapshot();
    const t = live.get(task_id);
    if (t) return view(t);
    const a = archive.data.items.find((x) => x.id === task_id);
    return a || `Keine Aufgabe ${task_id}.`;
  },
});

registerTool({
  name: 'task_cancel',
  label: 'Aufgabe abbrechen',
  group: 'tasks',
  mainOnly: true,
  description: 'Bricht eine laufende Hintergrundaufgabe ab.',
  input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  async run({ task_id }) {
    return cancelTask(task_id) ? 'Abgebrochen.' : 'Keine laufende Aufgabe mit dieser ID.';
  },
});
