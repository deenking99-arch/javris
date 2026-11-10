// JARVIS 2.0 – Server: HTTP + WebSocket, verbindet Sprach-Pipeline, Agenten, Tools und Interface.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, publicConfig, ROOT } from './config.js';
import { bus } from './core/bus.js';
import { resolveConfirmation, listPending } from './core/confirm.js';

// Tools registrieren (Reihenfolge egal – Registry sortiert deterministisch)
import './tools/memory.js';
import './tools/todos.js';
import './tools/calendar.js';
import './tools/files.js';
import './tools/system.js';
import './tools/browser.js';
import { startAutomations, setAutomationHandlers, automationsSnapshot } from './tools/automations.js';
import { startMcp, stopMcp, mcpSnapshot } from './mcp/manager.js';
import { startTask, setTaskFinishedHandler, tasksSnapshot, cancelTask, cancelAllTasks } from './agent/tasks.js';
import { Conversation } from './agent/conversation.js';
import { startMetrics, metricsSnapshot } from './system/metrics.js';
import { todosSnapshot } from './tools/todos.js';
import { todayEventsSafe } from './tools/calendar.js';
import { listTools } from './tools/registry.js';
import { DeepgramStream } from './voice/deepgram.js';
import { ttsSettings, setTtsSettings } from './voice/tts.js';
import { closeBrowser } from './tools/browser.js';

const DEV = process.argv.includes('--dev');
const conversation = new Conversation();
const notifications = [];

// ---------- Ereignisse zwischen Modulen ----------
setTaskFinishedHandler((t) => {
  if (t.silent) return;
  if (t.status === 'done') {
    conversation.queueEvent(
      `Die Hintergrundaufgabe "${t.title}" (${t.id}) ist abgeschlossen. Kurzfassung: ${t.summary}. Der vollständige Bericht liegt unter ${t.resultFile}. Teile dem Nutzer das Ergebnis in ein bis zwei gesprochenen Sätzen mit.`,
    );
  } else if (t.status === 'error') {
    conversation.queueEvent(`Die Hintergrundaufgabe "${t.title}" ist fehlgeschlagen: ${t.error}. Informiere den Nutzer kurz.`);
  }
});
setAutomationHandlers({
  reminder: (a) => conversation.announce(`Erinnerung: ${a.text}`),
  task: (a) => {
    const t = startTask({ title: a.name, instructions: a.prompt, origin: 'automation' });
    if (!a.speak) t.silent = true;
  },
});
bus.on('broadcast', (ev) => {
  if (ev.type === 'notification') {
    notifications.push(ev);
    if (notifications.length > 30) notifications.shift();
  }
});

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Nur lokale Aufrufe aus dem eigenen Interface zulassen (Schutz vor fremden Webseiten)
function allowedOrigin(origin, host) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch {
    return false;
  }
}
app.use('/api', (req, res, next) => {
  if (!allowedOrigin(req.headers.origin, req.headers.host)) return res.status(403).json({ error: 'Origin nicht erlaubt' });
  next();
});

app.get('/api/config', (_req, res) => res.json({ ...publicConfig(), tts: { ...publicConfig().tts, ...ttsSettings } }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

function snapshot() {
  return {
    config: { ...publicConfig(), tts: { ...publicConfig().tts, ...ttsSettings } },
    conversation: conversation.snapshot(),
    metrics: metricsSnapshot(),
    mcp: mcpSnapshot(),
    tasks: tasksSnapshot(),
    todos: todosSnapshot(),
    automations: automationsSnapshot(),
    notifications,
    confirmations: listPending(),
    tools: listTools().map((t) => ({ name: t.name, label: t.label, group: t.group })),
  };
}

const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const clients = new Set();
let primary = null; // Client, der Audio abspielt und das Mikrofon liefert

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return; // Vite-HMR o.ä.
  if (!allowedOrigin(req.headers.origin, req.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
bus.on('broadcast', (msg) => {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
});

conversation.sendSpeech = (msg) => {
  if (!primary || primary.readyState !== 1) return false;
  send(primary, { type: 'speech', ...msg });
  // Untertitel für alle anderen Fenster
  for (const ws of clients) if (ws !== primary) send(ws, { type: 'subtitle', text: msg.text });
  return true;
};

function sttHandlers() {
  return {
    onTranscript: (t) => conversation.transcript(t),
    onUtteranceEnd: () => conversation.utteranceEnd(),
    onSpeechStarted: () => conversation.vad(true),
    onError: (e) => {
      console.warn('[stt]', e.message);
      bus.broadcast('notification', { level: 'error', title: 'Spracherkennung gestört', body: e.message });
      bus.broadcast('stt_status', { status: 'error', error: e.message });
    },
    onStatus: (s) => bus.broadcast('stt_status', { status: s }),
  };
}
const deepgram = new DeepgramStream(sttHandlers());

wss.on('connection', (ws) => {
  clients.add(ws);
  if (!primary) primary = ws;
  send(ws, { type: 'snapshot', ...snapshot(), primary: primary === ws });
  todayEventsSafe().then((events) => send(ws, { type: 'calendar', events }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ws === primary && config.stt.provider === 'deepgram') deepgram.send(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const claimPrimary = () => {
      if (primary !== ws) {
        primary = ws;
        for (const c of clients) send(c, { type: 'primary', primary: c === ws });
      }
    };
    switch (msg.type) {
      case 'claim_primary':
        claimPrimary();
        break;
      case 'text':
        claimPrimary();
        if (msg.text?.trim()) conversation.handleUtterance(msg.text.trim(), { source: 'text' });
        break;
      case 'wake':
        claimPrimary();
        conversation.wake(msg.source || 'wakeword');
        break;
      case 'interrupt':
        conversation.interrupt(msg.source || 'button');
        conversation.refresh();
        break;
      case 'vad':
        conversation.vad(Boolean(msg.speaking));
        break;
      case 'stt': // Browser-Spracherkennung
        if (ws === primary) conversation.transcript({ text: msg.text, isFinal: !!msg.final, speechFinal: !!msg.speechFinal });
        break;
      case 'stt_end':
        if (ws === primary) conversation.utteranceEnd();
        break;
      case 'playback':
        conversation.playbackAny(msg);
        break;
      case 'audio_state':
        if (ws === primary) conversation.audioState(Boolean(msg.playing));
        break;
      case 'mic':
        if (ws === primary && !msg.enabled) deepgram.close();
        bus.broadcast('mic', { enabled: Boolean(msg.enabled), error: msg.error || null });
        break;
      case 'confirm':
        resolveConfirmation(msg.id, msg.approved);
        break;
      case 'task_cancel':
        cancelTask(msg.id);
        break;
      case 'tts_settings':
        try {
          setTtsSettings(msg);
          bus.broadcast('tts_settings', { ...ttsSettings });
        } catch (e) {
          send(ws, { type: 'notification', level: 'error', title: 'Stimme', body: e.message, ts: Date.now() });
        }
        break;
      case 'clear_history':
        conversation.clearHistory();
        break;
      case 'calendar':
        todayEventsSafe().then((events) => send(ws, { type: 'calendar', events }));
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (primary === ws) {
      primary = [...clients].pop() || null;
      deepgram.close();
      conversation.audioState(false);
      if (primary) send(primary, { type: 'primary', primary: true });
    }
  });
});

// ---------- Frontend ausliefern ----------
async function mountFrontend() {
  if (process.env.JARVIS_NO_UI) return; // z.B. für Tests
  if (DEV) {
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: path.join(ROOT, 'vite.config.js'), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'client', 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      console.error('\n  Kein Build gefunden. Bitte zuerst "npm run build" ausführen oder "npm run dev" verwenden.\n');
      process.exit(1);
    }
    app.use(express.static(dist, { index: 'index.html' }));
    app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
}

async function main() {
  await mountFrontend();
  startMetrics();
  startAutomations();
  startMcp().catch((e) => console.warn('[mcp]', e.message));
  server.listen(config.port, config.host, () => {
    const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
    console.log(`\n  ◉ JARVIS 2.0 online → ${url}`);
    console.log(`    Modell: ${config.claude.model} | STT: ${config.stt.provider} | TTS: ${ttsSettings.provider} | Wake-Word: ${config.wake.picovoiceKey ? 'Porcupine (lokal)' : 'Transkript'}`);
    if (!config.claude.configured) console.log('    ⚠  ANTHROPIC_API_KEY fehlt – bitte in .env eintragen.');
    console.log('');
  });
}

async function shutdown() {
  console.log('\n  JARVIS fährt herunter …');
  cancelAllTasks();
  deepgram.close();
  await Promise.race([Promise.all([stopMcp(), closeBrowser()]), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
