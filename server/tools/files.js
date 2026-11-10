// Dateizugriff – beschränkt auf freigegebene Wurzelverzeichnisse (JARVIS_FILE_ROOTS).
// Schreiben außerhalb des Jarvis-Ausgabeordners und Löschen erfordern eine Bestätigung.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import { requestConfirmation } from '../core/confirm.js';
import { registerTool } from './registry.js';

const SKIP = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', 'Library', 'AppData', '.Trash', 'dist', 'build']);
const MAX_READ = 200_000;

function within(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Löst einen Pfad auf und prüft, dass er (auch nach Symlinks) in einer freigegebenen Wurzel liegt. */
export async function safePath(p, { mustExist = true } = {}) {
  const expanded = p.replace(/^~(?=$|[\\/])/, os.homedir());
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(config.files.outputDir, expanded);
  let real = abs;
  try {
    real = await fs.realpath(abs);
  } catch (e) {
    if (mustExist) throw new Error(`Pfad nicht gefunden: ${abs}`);
    const parent = await fs.realpath(path.dirname(abs)).catch(() => path.dirname(abs));
    real = path.join(parent, path.basename(abs));
  }
  const roots = [...config.files.roots, config.files.outputDir];
  if (!roots.some((r) => within(real, r))) {
    throw new Error(`Zugriff verweigert: ${real} liegt außerhalb der freigegebenen Ordner (${roots.join(', ')}).`);
  }
  return real;
}

function isProbablyText(buf) {
  const len = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c < 7 || (c > 13 && c < 32)) bad++;
  }
  return bad / Math.max(len, 1) < 0.1;
}

async function walk(dir, depth, visit, budget = { n: 0 }) {
  if (depth < 0 || budget.n > 25_000) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n++ > 25_000) return;
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    await visit(full, e);
    if (e.isDirectory()) await walk(full, depth - 1, visit, budget);
  }
}

registerTool({
  name: 'fs_list',
  label: 'Ordner anzeigen',
  group: 'files',
  description: `Listet den Inhalt eines Ordners. Freigegebene Wurzeln: ${config.files.roots.join(', ')}. Jarvis-Ausgabeordner: ${config.files.outputDir}.`,
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async run({ path: p }) {
    const dir = await safePath(p);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries.slice(0, 300)) {
      const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
      out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st?.size, modified: st?.mtime?.toISOString() });
    }
    return { path: dir, entries: out, truncated: entries.length > 300 };
  },
});

registerTool({
  name: 'fs_read',
  label: 'Datei lesen',
  group: 'files',
  description: 'Liest eine Textdatei (Code, Markdown, TXT, CSV, JSON …). Große Dateien werden abschnittsweise über offset gelesen.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, offset: { type: 'integer', description: 'Startbyte' } },
    required: ['path'],
  },
  async run({ path: p, offset = 0 }) {
    const file = await safePath(p);
    const st = await fs.stat(file);
    if (st.isDirectory()) throw new Error('Das ist ein Ordner – nutze fs_list.');
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(MAX_READ, Math.max(0, st.size - offset)));
      await fh.read(buf, 0, buf.length, offset);
      if (!isProbablyText(buf)) return `Binärdatei (${st.size} Bytes) – kann nicht als Text gelesen werden.`;
      const more = offset + buf.length < st.size;
      return `${buf.toString('utf8')}${more ? `\n\n[… gekürzt. Weiterlesen mit offset=${offset + buf.length}, Gesamtgröße ${st.size} Bytes]` : ''}`;
    } finally {
      await fh.close();
    }
  },
});

registerTool({
  name: 'fs_search',
  label: 'Dateien suchen',
  group: 'files',
  description: 'Sucht Dateien/Ordner nach Namensbestandteil (Groß-/Kleinschreibung egal) unterhalb eines Ordners.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, path: { type: 'string' }, max_depth: { type: 'integer' } },
    required: ['query'],
  },
  async run({ query, path: p, max_depth = 6 }) {
    const base = await safePath(p || config.files.roots[0]);
    const q = query.toLowerCase();
    const hits = [];
    await walk(base, max_depth, async (full, e) => {
      if (hits.length < 100 && e.name.toLowerCase().includes(q)) hits.push({ path: full, type: e.isDirectory() ? 'dir' : 'file' });
    });
    return hits.length ? hits : 'Nichts gefunden.';
  },
});

registerTool({
  name: 'fs_recent',
  label: 'Zuletzt bearbeitet',
  group: 'files',
  description:
    'Findet die zuletzt geänderten Dateien und Projektordner (z.B. um "das letzte Projekt" zu identifizieren). Ignoriert node_modules, .git und versteckte Ordner.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' }, max_depth: { type: 'integer' } },
  },
  async run({ path: p, limit = 25, max_depth = 4 }) {
    const base = await safePath(p || config.files.roots[0]);
    const files = [];
    await walk(base, max_depth, async (full, e) => {
      if (!e.isFile()) return;
      const st = await fs.stat(full).catch(() => null);
      if (st) files.push({ path: full, modified: st.mtimeMs });
    });
    files.sort((a, b) => b.modified - a.modified);
    const top = files.slice(0, limit).map((f) => ({ path: f.path, modified: new Date(f.modified).toISOString() }));
    // Aggregiert nach Ordner der 2. Ebene → wahrscheinliche "Projekte"
    const projects = new Map();
    for (const f of files.slice(0, 400)) {
      const rel = path.relative(base, f.path).split(path.sep);
      const proj = path.join(base, ...rel.slice(0, Math.min(2, rel.length - 1)));
      if (!projects.has(proj)) projects.set(proj, new Date(f.modified).toISOString());
    }
    return { recent_files: top, recent_folders: [...projects.entries()].slice(0, 10).map(([folder, modified]) => ({ folder, modified })) };
  },
});

registerTool({
  name: 'fs_write',
  label: 'Datei schreiben',
  group: 'files',
  description: `Schreibt eine Textdatei. Relative Pfade landen im Jarvis-Ausgabeordner (${config.files.outputDir}) – dort ohne Rückfrage. Überall sonst fragt Jarvis den Nutzer.`,
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } },
    required: ['path', 'content'],
  },
  async run({ path: p, content, append = false }, ctx) {
    const file = await safePath(p, { mustExist: false });
    if (!within(file, config.files.outputDir)) {
      const exists = fss.existsSync(file);
      const ok = await requestConfirmation({
        title: `${exists ? 'Datei überschreiben' : 'Datei anlegen'}: ${path.basename(file)}`,
        detail: file,
        signal: ctx.signal,
      });
      if (!ok) return 'Vom Nutzer abgelehnt.';
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await (append ? fs.appendFile(file, content) : fs.writeFile(file, content));
    return `Gespeichert: ${file}`;
  },
});

registerTool({
  name: 'fs_delete',
  label: 'Datei löschen',
  group: 'files',
  description: 'Löscht eine Datei (nicht rekursiv bei Ordnern). Erfordert immer eine Bestätigung des Nutzers.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async run({ path: p }, ctx) {
    const file = await safePath(p);
    const st = await fs.stat(file);
    if (st.isDirectory()) throw new Error('Ordner werden aus Sicherheitsgründen nicht gelöscht.');
    const ok = await requestConfirmation({ title: `Datei löschen: ${path.basename(file)}`, detail: file, signal: ctx.signal });
    if (!ok) return 'Vom Nutzer abgelehnt.';
    await fs.unlink(file);
    return `Gelöscht: ${file}`;
  },
});
