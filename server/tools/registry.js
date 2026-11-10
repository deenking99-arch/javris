// Tool-Registry: einheitliche Definition, Validierung, Ausführung und Live-Reporting aller Tools.
import { bus, uid } from '../core/bus.js';

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} input_schema JSON-Schema
 * @property {(input:any, ctx:ToolContext)=>Promise<any>} run
 * @property {string} [label] Anzeigename in der UI
 * @property {string} [group] UI-Gruppe (files, web, browser, mcp, system, memory, tasks …)
 * @property {boolean} [mainOnly] nur im Gesprächsagenten
 * @property {boolean} [taskOnly] nur in Hintergrundagenten
 */

/** @type {Map<string, ToolDef>} */
const tools = new Map();

export function registerTool(def) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) throw new Error(`Ungültiger Tool-Name: ${def.name}`);
  tools.set(def.name, def);
}
export function unregisterTool(name) {
  tools.delete(name);
}
export function unregisterWhere(pred) {
  for (const [n, t] of tools) if (pred(t)) tools.delete(n);
}
export function getTool(name) {
  return tools.get(name);
}
export function listTools() {
  return [...tools.values()];
}

/** Liefert API-Tooldefinitionen für einen Agententyp ('main' | 'task'). */
export function apiTools(kind) {
  const defs = listTools()
    .filter((t) => (kind === 'main' ? !t.taskOnly : !t.mainOnly))
    .sort((a, b) => a.name.localeCompare(b.name)) // deterministische Reihenfolge = stabiler Prompt-Cache
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      eager_input_streaming: true,
    }));
  return defs;
}

/** Minimalvalidierung gegen das JSON-Schema (Pflichtfelder + Grundtypen). */
export function validateInput(schema, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'Eingabe muss ein Objekt sein';
  for (const key of schema.required || []) {
    if (input[key] === undefined || input[key] === null) return `Pflichtfeld fehlt: ${key}`;
  }
  for (const [key, val] of Object.entries(input)) {
    const prop = schema.properties?.[key];
    if (!prop || !prop.type) continue;
    const t = Array.isArray(val) ? 'array' : typeof val;
    const ok =
      prop.type === t ||
      (prop.type === 'integer' && Number.isInteger(val)) ||
      (prop.type === 'number' && t === 'number') ||
      (Array.isArray(prop.type) && prop.type.includes(t));
    if (!ok) return `Feld ${key} hat falschen Typ (erwartet ${prop.type}, erhalten ${t})`;
    if (prop.enum && !prop.enum.includes(val)) return `Feld ${key} muss einer von ${prop.enum.join(', ')} sein`;
  }
  return null;
}

const short = (v, n = 140) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Führt einen Tool-Aufruf aus und meldet Start/Ende an die UI.
 * @returns {Promise<{content:any, is_error:boolean}>}
 */
export async function executeTool(name, input, ctx) {
  const tool = tools.get(name);
  const callId = uid('call');
  const base = { callId, name, label: tool?.label || name, group: tool?.group || 'other', source: ctx.source, taskId: ctx.taskId };
  if (!tool) return { content: `Unbekanntes Tool: ${name}`, is_error: true };
  const err = validateInput(tool.input_schema, input);
  if (err) {
    bus.broadcast('tool', { ...base, status: 'error', summary: err });
    return { content: `Ungültige Eingabe: ${err}`, is_error: true };
  }
  bus.broadcast('tool', { ...base, status: 'running', summary: short(input) });
  const started = Date.now();
  try {
    const result = await tool.run(input, { ...ctx, callId });
    const content = typeof result === 'string' ? result : Array.isArray(result) ? result : JSON.stringify(result, null, 1);
    bus.broadcast('tool', { ...base, status: 'done', ms: Date.now() - started, summary: Array.isArray(result) ? short(result.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' '), 200) : short(content, 200) });
    return { content, is_error: false };
  } catch (e) {
    const msg = ctx.signal?.aborted ? 'Abgebrochen' : e?.message || String(e);
    bus.broadcast('tool', { ...base, status: 'error', ms: Date.now() - started, summary: msg });
    return { content: `Fehler: ${msg}`, is_error: true };
  }
}
