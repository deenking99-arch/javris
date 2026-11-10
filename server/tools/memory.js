// Langzeitgedächtnis: Fakten, Vorlieben, Projekte – persistent in data/memory.json.
import { JsonStore } from '../core/store.js';
import { bus, uid } from '../core/bus.js';
import { registerTool } from './registry.js';

const store = new JsonStore('memory', { items: [] });

export function memoryItems() {
  return store.data.items;
}

/** Kompakter Gedächtnisauszug für den Kontext eines Turns. */
export function memoryContext(limit = 60) {
  const items = store.data.items.slice(-limit);
  if (!items.length) return '';
  return items.map((m) => `- (${m.id}) ${m.text}${m.tags?.length ? ` [${m.tags.join(', ')}]` : ''}`).join('\n');
}

function emit() {
  bus.broadcast('memory', { count: store.data.items.length });
}

registerTool({
  name: 'memory_save',
  label: 'Gedächtnis speichern',
  group: 'memory',
  description:
    'Speichert eine dauerhafte Information über den Nutzer, seine Vorlieben, Projekte, Personen oder Vereinbarungen. Nutze dies proaktiv, wenn der Nutzer etwas Merkenswertes sagt oder dich explizit bittet, dir etwas zu merken.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Die zu merkende Information als vollständiger Satz.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Schlagworte.' },
    },
    required: ['text'],
  },
  async run({ text, tags = [] }) {
    const item = { id: uid('mem'), text: text.trim(), tags, created: new Date().toISOString() };
    store.data.items.push(item);
    store.save();
    emit();
    return `Gespeichert (${item.id}).`;
  },
});

registerTool({
  name: 'memory_search',
  label: 'Gedächtnis durchsuchen',
  group: 'memory',
  description: 'Durchsucht das Langzeitgedächtnis nach Stichworten. Leere Suche liefert die neuesten Einträge.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    required: ['query'],
  },
  async run({ query, limit = 20 }) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = store.data.items
      .map((m) => {
        const hay = `${m.text} ${(m.tags || []).join(' ')}`.toLowerCase();
        return { m, score: words.length ? words.filter((w) => hay.includes(w)).length : 1 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.created.localeCompare(a.m.created))
      .slice(0, limit)
      .map((x) => x.m);
    return scored.length ? scored : 'Keine passenden Einträge.';
  },
});

registerTool({
  name: 'memory_forget',
  label: 'Gedächtnis löschen',
  group: 'memory',
  description: 'Löscht einen Gedächtniseintrag anhand seiner ID (z.B. wenn eine Information veraltet ist).',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async run({ id }) {
    const before = store.data.items.length;
    store.data.items = store.data.items.filter((m) => m.id !== id);
    store.save();
    emit();
    return before === store.data.items.length ? `Kein Eintrag mit ID ${id}.` : 'Gelöscht.';
  },
});
