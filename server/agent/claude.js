// Agentenschleife über die Claude Messages API (Streaming + Tool-Use + Server-Tools).
// Wird vom Gesprächsagenten (Sprache/Text) und von Hintergrund-Subagenten gemeinsam genutzt.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { bus } from '../core/bus.js';
import { apiTools, executeTool } from '../tools/registry.js';

let client = null;
export function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 2 });
  return client;
}

// Optionale API-Features. Lehnt die API eines davon ab (400), wird es abgeschaltet und der Aufruf wiederholt.
const compat = { fallback: config.claude.serverFallback, binding: true, updates: true };

function disableRejectedFeature(err) {
  const msg = `${err?.message || ''} ${JSON.stringify(err?.error || '')}`.toLowerCase();
  const order = [
    ['fallback', /fallback/],
    ['updates', /display|updates/],
    ['binding', /block_binding|binding|prefix_mismatch/],
  ];
  for (const [key, re] of order) {
    if (compat[key] && re.test(msg)) {
      compat[key] = false;
      console.warn(`[agent] API lehnt "${key}" ab – deaktiviert, wiederhole Anfrage.`);
      return true;
    }
  }
  // Unklarer Beta-Fehler: alle optionalen Features nacheinander abschalten
  if (/beta|unknown|unexpected|not supported|extra inputs/.test(msg)) {
    for (const key of ['fallback', 'updates', 'binding']) {
      if (compat[key]) {
        compat[key] = false;
        console.warn(`[agent] Optionales Feature "${key}" deaktiviert (${msg.slice(0, 120)})`);
        return true;
      }
    }
  }
  return false;
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

function serverTools(kind) {
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: kind === 'main' ? 4 : 20 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: kind === 'main' ? 4 : 25 },
  ];
}

/** Hängt Inhalt an die letzte User-Nachricht an bzw. legt eine neue an (Verlauf bleibt append-only). */
export function pushUser(messages, blocks) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    last.content = [...content, ...blocks];
  } else {
    messages.push({ role: 'user', content: blocks });
  }
}

const abortPromise = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(new AbortedError());
    signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
  });

/**
 * Führt eine vollständige Agentenschleife aus. `messages` wird fortlaufend und konsistent ergänzt.
 * @param {object} o
 * @param {string} o.system
 * @param {Array} o.messages
 * @param {'main'|'task'} o.kind
 * @param {AbortSignal} o.signal
 * @param {(t:string)=>void} [o.onText] Textdeltas (für Sprachausgabe/Anzeige)
 * @param {(note:string)=>void} [o.onProgress] Fortschrittsnotizen des Modells zwischen Tool-Aufrufen
 * @param {(active:boolean)=>void} [o.onToolsActive]
 * @param {()=>void} [o.onRequestStart]
 * @param {string} [o.taskId]
 * @returns {Promise<{text:string, stopReason:string, partial?:string}>}
 */
export async function runAgentLoop({ system, messages, kind, signal, onText, onProgress, onToolsActive, onRequestStart, taskId, maxIterations = 40 }) {
  const c = getClient();
  const effort = kind === 'main' ? config.claude.effortVoice : config.claude.effortTask;
  const source = kind === 'main' ? 'main' : 'task';
  let finalText = '';
  let jsonRetries = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (signal.aborted) throw new AbortedError();
    const betas = [];
    const thinking = { type: 'adaptive' };
    if (compat.binding) {
      betas.push('thinking-binding-controls-2026-08-01');
      thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
    }
    if (kind === 'task' && compat.updates) {
      betas.push('thinking-display-updates-2026-08-18');
      thinking.display = 'updates';
    }
    const params = {
      model: config.claude.model,
      max_tokens: kind === 'main' ? 16000 : 64000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: [...apiTools(kind), ...serverTools(kind)],
      thinking,
      output_config: { effort },
      betas,
    };
    if (compat.fallback) {
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }

    if (!betas.length) delete params.betas;
    onRequestStart?.();
    const stream = c.beta.messages.stream(params, { signal });
    let turnText = '';
    stream.on('text', (d) => {
      turnText += d;
      onText?.(d);
    });
    stream.on('thinking', (d) => {
      // Bei display:"updates" sind das kurze Fortschrittsnotizen, keine Rohgedanken.
      if (kind === 'task' && d?.trim()) onProgress?.(d.trim());
    });
    stream.on('contentBlock', (block) => {
      if (block.type === 'server_tool_use') {
        bus.broadcast('tool', {
          callId: block.id,
          name: block.name,
          label: block.name === 'web_search' ? 'Websuche' : 'Webseite abrufen',
          group: 'web',
          source,
          taskId,
          status: 'running',
          summary: block.input?.query || block.input?.url || '',
        });
      } else if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
        const ok = Array.isArray(block.content) || block.content?.type === 'web_fetch_result';
        const n = Array.isArray(block.content) ? `${block.content.length} Treffer` : ok ? 'Seite geladen' : block.content?.error_code || 'Fehler';
        bus.broadcast('tool', { callId: block.tool_use_id, name: block.type, group: 'web', source, taskId, status: ok ? 'done' : 'error', summary: n });
      }
    });

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (signal.aborted) {
        const e = new AbortedError();
        e.partial = turnText;
        throw e;
      }
      if (err instanceof Anthropic.BadRequestError && disableRejectedFeature(err)) {
        iter--;
        continue;
      }
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      console.warn('[agent] Tool-Eingabe nicht parsebar, Turn wird wiederholt');
      continue;
    }

    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) finalText = text;

    if (message.stop_reason === 'refusal') {
      messages.push({ role: 'assistant', content: message.content.length ? message.content : [{ type: 'text', text: '(abgelehnt)' }] });
      return { text: finalText || 'Dabei kann ich leider nicht helfen.', stopReason: 'refusal' };
    }
    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason === 'pause_turn') continue;
    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) return { text: finalText, stopReason: message.stop_reason };
    if (message.stop_reason === 'max_tokens') {
      pushUser(messages, toolUses.map((t) => ({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: 'Eingabe abgeschnitten (max_tokens). Bitte kürzer erneut versuchen.' })));
      continue;
    }

    // Tools parallel ausführen; bei Abbruch werden ausstehende Ergebnisse als Fehler eingetragen,
    // damit der Verlauf gültig bleibt.
    onToolsActive?.(true);
    const results = toolUses.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: 'Abgebrochen durch den Nutzer.', is_error: true }));
    try {
      await Promise.race([
        Promise.all(
          toolUses.map(async (t, i) => {
            const r = await executeTool(t.name, t.input, { signal, source, taskId });
            results[i] = { type: 'tool_result', tool_use_id: t.id, content: r.content, is_error: r.is_error };
          }),
        ),
        abortPromise(signal),
      ]);
    } catch (e) {
      pushUser(messages, results);
      onToolsActive?.(false);
      throw e instanceof AbortedError ? e : new AbortedError();
    }
    onToolsActive?.(false);
    pushUser(messages, results);
  }
  return { text: finalText || 'Ich habe das Schrittlimit erreicht.', stopReason: 'max_iterations' };
}
