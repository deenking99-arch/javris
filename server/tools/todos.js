// Persönliche Aufgabenliste (To-dos) mit Prioritäten – persistent in data/todos.json.
import { JsonStore } from '../core/store.js';
import { bus, uid } from '../core/bus.js';
import { registerTool } from './registry.js';

const store = new JsonStore('todos', { items: [] });
const PRIO = { hoch: 3, mittel: 2, niedrig: 1 };

export function openTodos() {
  return store.data.items
    .filter((t) => !t.done)
    .sort((a, b) => (PRIO[b.priority] || 0) - (PRIO[a.priority] || 0) || (a.due || '9').localeCompare(b.due || '9'));
}
function emit() {
  bus.broadcast('todos', { open: openTodos().length, items: openTodos().slice(0, 8) });
}

registerTool({
  name: 'todo_add',
  label: 'Aufgabe anlegen',
  group: 'todos',
  description: 'Legt eine persönliche Aufgabe (To-do) des Nutzers an.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      priority: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
      due: { type: 'string', description: 'Fälligkeit als ISO-Datum (YYYY-MM-DD) oder Datum+Uhrzeit.' },
      notes: { type: 'string' },
    },
    required: ['title'],
  },
  async run({ title, priority = 'mittel', due, notes }) {
    const item = { id: uid('todo'), title, priority, due: due || null, notes: notes || '', done: false, created: new Date().toISOString() };
    store.data.items.push(item);
    store.save();
    emit();
    return item;
  },
});

registerTool({
  name: 'todo_list',
  label: 'Aufgaben abrufen',
  group: 'todos',
  description: 'Listet die Aufgaben des Nutzers, sortiert nach Priorität und Fälligkeit.',
  input_schema: { type: 'object', properties: { include_done: { type: 'boolean' } } },
  async run({ include_done = false }) {
    const items = include_done ? store.data.items : openTodos();
    return items.length ? items : 'Keine offenen Aufgaben.';
  },
});

registerTool({
  name: 'todo_update',
  label: 'Aufgabe ändern',
  group: 'todos',
  description: 'Ändert eine Aufgabe: erledigt markieren, Priorität, Titel, Fälligkeit oder Notizen.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      done: { type: 'boolean' },
      priority: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
      title: { type: 'string' },
      due: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['id'],
  },
  async run({ id, ...patch }) {
    const item = store.data.items.find((t) => t.id === id);
    if (!item) throw new Error(`Keine Aufgabe mit ID ${id}`);
    Object.assign(item, patch, patch.done ? { completed: new Date().toISOString() } : {});
    store.save();
    emit();
    return item;
  },
});

registerTool({
  name: 'todo_delete',
  label: 'Aufgabe löschen',
  group: 'todos',
  description: 'Löscht eine Aufgabe dauerhaft.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async run({ id }) {
    store.data.items = store.data.items.filter((t) => t.id !== id);
    store.save();
    emit();
    return 'Gelöscht.';
  },
});

export function todosSnapshot() {
  return { open: openTodos().length, items: openTodos().slice(0, 8) };
}
