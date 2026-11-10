// MCP-Manager: verbindet konfigurierte MCP-Server (stdio oder HTTP), registriert deren Tools
// und meldet Verbindungsstatus + laufende Aktionen live an die UI.
// Konfiguration: data/mcp.json im Claude-Desktop-Format { "mcpServers": { name: {command,args,env} | {url,headers} } }
// Werte der Form "${ENV:NAME}" werden aus der .env aufgelöst – Secrets stehen nie in mcp.json.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { JsonStore } from '../core/store.js';
import { bus } from '../core/bus.js';
import { requestConfirmation } from '../core/confirm.js';
import { registerTool, unregisterWhere } from '../tools/registry.js';

const store = new JsonStore('mcp', { mcpServers: {} });
/** @type {Map<string, {name:string,status:string,error?:string,tools:string[],client?:Client,transport?:any,active:Map<string,string>,kind:string}>} */
const servers = new Map();

const resolveEnv = (v) =>
  typeof v === 'string' ? v.replace(/\$\{ENV:([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? '') : v;
const resolveObj = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolveEnv(v)]));
const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

function snapshotOne(s) {
  return { name: s.name, status: s.status, error: s.error, kind: s.kind, tools: s.tools, active: [...s.active.values()] };
}
export function mcpSnapshot() {
  return [...servers.values()].map(snapshotOne);
}
function emit() {
  bus.broadcast('mcp', { servers: mcpSnapshot() });
}

async function connect(name, cfg) {
  await disconnect(name);
  const entry = { name, status: 'connecting', tools: [], active: new Map(), kind: cfg.url ? 'http' : 'stdio' };
  servers.set(name, entry);
  emit();
  if (cfg.disabled) {
    entry.status = 'disabled';
    return emit();
  }
  try {
    const client = new Client({ name: 'jarvis', version: '2.0.0' });
    let transport;
    if (cfg.url) {
      const opts = { requestInit: { headers: resolveObj(cfg.headers) } };
      transport = cfg.transport === 'sse' ? new SSEClientTransport(new URL(cfg.url), opts) : new StreamableHTTPClientTransport(new URL(cfg.url), opts);
    } else {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: (cfg.args || []).map(resolveEnv),
        env: { ...process.env, ...resolveObj(cfg.env) },
        stderr: 'pipe',
      });
    }
    transport.onclose = () => {
      if (servers.get(name) === entry && entry.status === 'connected') {
        entry.status = 'disconnected';
        unregisterWhere((t) => t.mcpServer === name);
        emit();
      }
    };
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung beim Verbinden (45 s)')), 45_000)),
    ]);
    entry.client = client;
    entry.transport = transport;
    const { tools } = await client.listTools();
    for (const t of tools) {
      const toolName = `mcp__${sanitize(name)}__${sanitize(t.name)}`.slice(0, 64);
      entry.tools.push(t.name);
      registerTool({
        name: toolName,
        label: `${name}: ${t.title || t.name}`,
        group: 'mcp',
        mcpServer: name,
        description: `[MCP-Server "${name}"] ${t.description || t.name}`.slice(0, 1024),
        input_schema: t.inputSchema?.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        async run(input, ctx) {
          entry.active.set(ctx.callId, t.name);
          emit();
          try {
            const res = await client.callTool({ name: t.name, arguments: input }, undefined, { signal: ctx.signal, timeout: 300_000 });
            const parts = (res.content || []).map((c) => {
              if (c.type === 'text') return { type: 'text', text: c.text };
              if (c.type === 'image') return { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } };
              if (c.type === 'resource') return { type: 'text', text: c.resource?.text ?? JSON.stringify(c.resource) };
              return { type: 'text', text: JSON.stringify(c) };
            });
            if (res.isError) throw new Error(parts.map((p) => p.text).join('\n') || 'MCP-Fehler');
            if (!parts.length && res.structuredContent) return JSON.stringify(res.structuredContent);
            return parts.length ? parts : 'OK (keine Ausgabe)';
          } finally {
            entry.active.delete(ctx.callId);
            emit();
          }
        },
      });
    }
    entry.status = 'connected';
  } catch (e) {
    entry.status = 'error';
    entry.error = e.message;
    console.warn(`[mcp] ${name}:`, e.message);
  }
  emit();
}

async function disconnect(name) {
  const s = servers.get(name);
  unregisterWhere((t) => t.mcpServer === name);
  if (s?.client) await s.client.close().catch(() => {});
  servers.delete(name);
}

export async function startMcp() {
  const cfgs = store.data.mcpServers || {};
  await Promise.all(Object.entries(cfgs).map(([n, c]) => connect(n, c)));
  emit();
}

export async function stopMcp() {
  await Promise.all([...servers.keys()].map(disconnect));
}

// ---------- Tools zur Verwaltung (für "Richte eine MCP-Integration ein") ----------

registerTool({
  name: 'mcp_list_servers',
  label: 'MCP: Übersicht',
  group: 'mcp',
  description: 'Listet alle konfigurierten MCP-Server mit Status und verfügbaren Tools.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const cfg = store.data.mcpServers;
    return mcpSnapshot().map((s) => ({ ...s, config: { ...cfg[s.name], env: Object.keys(cfg[s.name]?.env || {}) } }));
  },
});

registerTool({
  name: 'mcp_add_server',
  label: 'MCP: Server hinzufügen',
  group: 'mcp',
  description:
    'Richtet eine neue MCP-Integration ein und verbindet sie sofort. Entweder lokaler Prozess (command + args, z.B. "npx" ["-y", "paket-name"]) oder Remote-Server (url). ' +
    'API-Keys/Tokens NIEMALS direkt eintragen: verwende Platzhalter "${ENV:VARIABLENNAME}" und sage dem Nutzer, welche Variable er in seiner .env setzen muss. ' +
    'Recherchiere vorher (web_search) das korrekte, offizielle Paket. Der Nutzer muss bestätigen.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Kurzname, z.B. "kalender"' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object', description: 'Umgebungsvariablen, Werte als ${ENV:NAME}-Platzhalter' },
      url: { type: 'string' },
      headers: { type: 'object' },
      transport: { type: 'string', enum: ['http', 'sse'] },
    },
    required: ['name'],
  },
  async run({ name, command, args = [], env = {}, url, headers, transport }, ctx) {
    if (!command && !url) throw new Error('command oder url erforderlich');
    const key = sanitize(name);
    const desc = url ? `Remote-Server ${url}` : `Befehl: ${command} ${args.join(' ')}`;
    const ok = await requestConfirmation({
      title: `MCP-Integration "${key}" einrichten`,
      detail: desc,
      speak: `Ich möchte die MCP-Integration ${key} einrichten. Dafür wird ${url ? 'ein Remote-Server verbunden' : 'ein lokales Programm gestartet'}. Einverstanden?`,
      signal: ctx.signal,
    });
    if (!ok) return 'Vom Nutzer abgelehnt.';
    const cfg = url ? { url, headers, transport } : { command, args, env };
    store.data.mcpServers[key] = cfg;
    store.flush();
    await connect(key, cfg);
    const s = servers.get(key);
    const missing = Object.values({ ...env, ...(headers || {}) })
      .flatMap((v) => [...String(v).matchAll(/\$\{ENV:([A-Z0-9_]+)\}/g)].map((m) => m[1]))
      .filter((k) => !process.env[k]);
    return { status: s.status, error: s.error, tools: s.tools, missing_env_variables: missing };
  },
});

registerTool({
  name: 'mcp_remove_server',
  label: 'MCP: Server entfernen',
  group: 'mcp',
  description: 'Entfernt eine MCP-Integration dauerhaft.',
  input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async run({ name }, ctx) {
    if (!store.data.mcpServers[name]) return `Kein Server "${name}" konfiguriert.`;
    const ok = await requestConfirmation({ title: `MCP-Integration "${name}" entfernen`, signal: ctx.signal });
    if (!ok) return 'Vom Nutzer abgelehnt.';
    delete store.data.mcpServers[name];
    store.flush();
    await disconnect(name);
    emit();
    return 'Entfernt.';
  },
});

registerTool({
  name: 'mcp_reconnect',
  label: 'MCP: neu verbinden',
  group: 'mcp',
  description: 'Verbindet einen MCP-Server neu (z.B. nachdem der Nutzer fehlende Zugangsdaten in der .env ergänzt hat).',
  input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async run({ name }) {
    const cfg = store.data.mcpServers[name];
    if (!cfg) return `Kein Server "${name}" konfiguriert.`;
    await connect(name, cfg);
    return snapshotOne(servers.get(name));
  },
});

export async function reconnectServer(name) {
  const cfg = store.data.mcpServers[name];
  if (cfg) await connect(name, cfg);
}
