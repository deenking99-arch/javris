// Ende-zu-Ende-Test: echter JARVIS-Server + Mock-Claude-API + simulierter Browser-Client (Sprache als Transkript).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startMockAnthropic } from './mock-anthropic.js';

let mock;
let proc;
let port;
let dataDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mock = await startMockAnthropic();
  port = 17000 + Math.floor(Math.random() * 1000);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
  fs.writeFileSync(
    path.join(dataDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.resolve('test/fixtures/echo-mcp.js')] } } }),
  );
  proc = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
      ANTHROPIC_AUTH_TOKEN: '',
      JARVIS_PORT: String(port),
      JARVIS_DATA_DIR: dataDir,
      JARVIS_OUTPUT_DIR: path.join(dataDir, 'out'),
      JARVIS_FILE_ROOTS: dataDir,
      JARVIS_STT: 'browser',
      JARVIS_TTS: 'browser',
      JARVIS_FOLLOWUP_MS: '3000',
      JARVIS_NO_UI: '1',
      DEEPGRAM_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      OPENAI_API_KEY: '',
      PICOVOICE_ACCESS_KEY: '',
      JARVIS_BROWSER_HEADLESS: 'true',
      // Optional: vorhandenen Chromium nutzen, falls Playwrights eigener Browser nicht installiert ist
      JARVIS_BROWSER_EXECUTABLE: process.env.JARVIS_BROWSER_EXECUTABLE || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  if (process.env.DBG) proc.stdout.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60 && !out.includes('online'); i++) await sleep(100);
  assert.ok(out.includes('online'), `Server startet nicht:\n${out}`);
});

after(() => {
  proc?.kill('SIGKILL');
  mock?.server.close();
});

/** Simulierter Browser: spielt Sprachausgabe sofort "ab" und protokolliert alles. */
class FakeClient {
  constructor({ playMs = 30 } = {}) {
    this.msgs = [];
    this.states = [];
    this.playMs = playMs;
    this.queue = [];
    this.playing = false;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      if (m.type === 'state') this.states.push(m.state);
      if (m.type === 'speech') this.#enqueue(m);
      if (m.type === 'audio_stop') {
        this.queue = [];
      }
    });
  }
  ready() {
    return new Promise((r) => this.ws.once('open', r));
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  #enqueue(m) {
    this.queue.push(m);
    if (!this.playing) this.#next();
  }
  async #next() {
    const m = this.queue.shift();
    if (!m) {
      this.playing = false;
      this.send({ type: 'audio_state', playing: false });
      return;
    }
    if (!this.playing) this.send({ type: 'audio_state', playing: true });
    this.playing = true;
    this.send({ type: 'playback', turnId: m.turnId, seq: m.seq, status: 'start' });
    await sleep(this.playMs);
    this.send({ type: 'playback', turnId: m.turnId, seq: m.seq, status: 'end' });
    this.#next();
  }
  async waitFor(pred, ms = 5000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error('Timeout beim Warten auf Nachricht');
  }
  async waitState(state, ms = 6000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.states.at(-1) === state) return;
      await sleep(20);
    }
    throw new Error(`Zustand ${state} nicht erreicht (zuletzt ${this.states.at(-1)}; Verlauf: ${this.states.join('→')})`);
  }
  close() {
    this.ws.close();
  }
}

function lastMainRequest() {
  return [...mock.requests].reverse().find((r) => !r.body.system?.[0]?.text?.startsWith('Du bist ein Hintergrund-Agent'));
}

test('Origin fremder Webseiten wird abgewiesen', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'https://evil.example' } });
  const err = await new Promise((r) => ws.on('error', r));
  assert.match(String(err.message), /403/);
});

test('Texteingabe → Tool-Aufruf → gestreamte Sprachausgabe → Folgefrage-Fenster', async () => {
  const c = new FakeClient();
  await c.ready();
  await c.waitFor((m) => m.type === 'snapshot');
  c.send({ type: 'claim_primary' });
  c.send({ type: 'text', text: 'Was steht heute an?' });
  await c.waitFor((m) => m.type === 'tool' && m.name === 'todo_list' && m.status === 'done');
  await c.waitFor((m) => m.type === 'assistant_done');
  await c.waitState('listening');
  const spoken = c.msgs.filter((m) => m.type === 'speech').map((m) => m.text);
  assert.ok(spoken[0].startsWith('Einen Moment'), 'Erster Satz wird vor dem Tool gesprochen');
  assert.ok(spoken.some((s) => s.includes('keine offenen Aufgaben')));
  for (const s of ['processing', 'speaking', 'listening']) assert.ok(c.states.includes(s), `Zustand ${s} fehlt: ${c.states}`);

  const req = lastMainRequest();
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.thinking.type, 'adaptive');
  assert.equal(req.body.output_config.effort, 'low');
  assert.ok(req.body.tools.some((t) => t.type === 'web_search_20260209'));
  assert.ok(req.body.tools.some((t) => t.name === 'task_start'));
  assert.match(req.headers['anthropic-beta'], /thinking-binding-controls/);
  // Nach Ablauf des Folgefragen-Fensters zurück in den Ruhezustand
  await c.waitState('idle', 5000);
  c.close();
});

test('Sprache: Wake-Word im Transkript, Folgefrage ohne Wake-Word, Kontext bleibt erhalten', async () => {
  const c = new FakeClient();
  await c.ready();
  await c.waitFor((m) => m.type === 'snapshot');
  c.send({ type: 'claim_primary' });
  // Ohne Wake-Word passiert nichts
  c.send({ type: 'stt', text: 'was steht heute an', final: true, speechFinal: true });
  await sleep(400);
  assert.ok(!c.msgs.some((m) => m.type === 'user_message'), 'Ohne "Jarvis" darf nichts verarbeitet werden');
  // Mit Wake-Word
  c.send({ type: 'stt', text: 'Jarvis, was steht', final: false });
  c.send({ type: 'stt', text: 'Jarvis, was steht heute an?', final: true, speechFinal: true });
  const um = await c.waitFor((m) => m.type === 'user_message');
  assert.equal(um.text, 'was steht heute an?');
  await c.waitState('listening', 8000);
  // Folgefrage ohne Wake-Word
  c.send({ type: 'stt', text: 'Und was davon ist am wichtigsten?', final: true, speechFinal: true });
  await c.waitFor((m) => m.type === 'user_message' && m.text.includes('wichtigsten'));
  await c.waitFor((m) => m.type === 'assistant_done' && m.text.includes('wichtigsten'));
  const req = lastMainRequest();
  const texts = JSON.stringify(req.body.messages);
  assert.ok(texts.includes('was steht heute an?') && texts.includes('wichtigsten'), 'Verlauf enthält beide Fragen');
  c.close();
});

test('Barge-in: Nutzer unterbricht die Sprachausgabe, Verlauf bleibt gültig', async () => {
  const c = new FakeClient({ playMs: 400 });
  await c.ready();
  await c.waitFor((m) => m.type === 'snapshot');
  c.send({ type: 'claim_primary' });
  c.send({ type: 'text', text: 'Erzähl mir eine Geschichte' });
  await c.waitState('speaking', 8000);
  // Echo von Jarvis' eigener Stimme darf NICHT unterbrechen
  const first = c.msgs.find((m) => m.type === 'speech');
  const stopsBefore = c.msgs.length;
  c.send({ type: 'stt', text: first.text, final: true, speechFinal: true });
  await sleep(200);
  assert.ok(!c.msgs.slice(stopsBefore).some((m) => m.type === 'audio_stop'), 'Echo hat fälschlich unterbrochen');
  const afterEcho = c.msgs.length;
  // Echte Unterbrechung
  c.send({ type: 'stt', text: 'Stopp, warte mal', final: true, speechFinal: true });
  await c.waitFor((m) => m.type === 'audio_stop' && c.msgs.indexOf(m) >= afterEcho);
  assert.ok(c.states.includes('interrupted'));
  await c.waitFor((m) => m.type === 'assistant_done' && m.interrupted);
  // Neue Anweisung direkt danach
  c.send({ type: 'stt', text: 'Was steht heute an?', final: true, speechFinal: true });
  await c.waitFor((m) => m.type === 'tool' && m.name === 'todo_list' && m.status === 'done', 8000);
  const req = lastMainRequest();
  const msgs = req.body.messages;
  // Gültige Abfolge: keine zwei Assistant-Nachrichten hintereinander, Teilantwort markiert
  for (let i = 1; i < msgs.length; i++) assert.ok(!(msgs[i].role === 'assistant' && msgs[i - 1].role === 'assistant'), 'Zwei Assistant-Nachrichten in Folge');
  assert.ok(JSON.stringify(msgs).includes('[vom Nutzer unterbrochen]'));
  await c.waitFor((m) => m.type === 'assistant_done' && /keine offenen/.test(m.text), 8000);
  c.close();
});

test('Hintergrund-Agent: Aufgabe läuft parallel, Ergebnis wird gespeichert und gemeldet', async () => {
  const c = new FakeClient();
  await c.ready();
  await c.waitFor((m) => m.type === 'snapshot');
  c.send({ type: 'claim_primary' });
  c.send({ type: 'text', text: 'Jarvis, recherchiere mir Robotik-Investments' });
  const done = await c.waitFor((m) => m.type === 'task' && m.task.status === 'done', 10_000);
  assert.ok(fs.existsSync(done.task.resultFile), 'Ergebnisdatei existiert');
  assert.match(fs.readFileSync(done.task.resultFile, 'utf8'), /Bericht/);
  assert.equal(done.task.summary, 'Die Robotik-Recherche ist fertig.');
  const taskReq = mock.requests.find((r) => r.body.system?.[0]?.text?.startsWith('Du bist ein Hintergrund-Agent'));
  assert.equal(taskReq.body.output_config.effort, 'high');
  assert.ok(!taskReq.body.tools.some((t) => t.name === 'task_start'), 'Subagenten starten keine Subagenten');
  // Ergebnis wird proaktiv angesagt
  await c.waitFor((m) => m.type === 'speech' && m.text.includes('Recherche ist abgeschlossen'), 10_000);
  c.close();
});

test('Bestätigung per Sprache für riskante Aktionen (Shell)', async () => {
  const c = new FakeClient();
  await c.ready();
  await c.waitFor((m) => m.type === 'snapshot');
  c.send({ type: 'claim_primary' });
  c.send({ type: 'text', text: 'Führe einen Befehl aus' });
  const req = await c.waitFor((m) => m.type === 'confirm_request', 8000);
  assert.match(req.detail, /echo hallo/);
  await c.waitFor((m) => m.type === 'speech' && /Darf ich/.test(m.text));
  c.send({ type: 'stt', text: 'Ja', final: true, speechFinal: true });
  const res = await c.waitFor((m) => m.type === 'confirm_resolved');
  assert.equal(res.approved, true);
  await c.waitFor((m) => m.type === 'assistant_done' && /ausgeführt/.test(m.text), 8000);
  c.close();
});

test('MCP: lokaler Server wird verbunden, Tool aufgerufen, Status live gemeldet', async () => {
  const c = new FakeClient();
  await c.ready();
  const snap = await c.waitFor((m) => m.type === 'snapshot');
  let echo = snap.mcp.find((s) => s.name === 'echo');
  if (echo?.status !== 'connected') echo = (await c.waitFor((m) => m.type === 'mcp' && m.servers.some((s) => s.name === 'echo' && s.status === 'connected'))).servers[0];
  assert.deepEqual(echo.tools, ['echo']);
  c.send({ type: 'claim_primary' });
  c.send({ type: 'text', text: 'mcp echo bitte' });
  const active = await c.waitFor((m) => m.type === 'mcp' && m.servers.some((s) => s.active.length), 8000);
  assert.deepEqual(active.servers.find((s) => s.name === 'echo').active, ['echo']);
  await c.waitFor((m) => m.type === 'tool' && m.name === 'mcp__echo__echo' && m.status === 'done', 8000);
  await c.waitFor((m) => m.type === 'assistant_done' && /ECHO: hallo jarvis/.test(m.text), 8000);
  c.close();
});

test('Browsersteuerung: Seite öffnen und auslesen (headless)', async () => {
  const c = new FakeClient();
  await c.ready();
  await c.waitFor((m) => m.type === 'snapshot');
  c.send({ type: 'claim_primary' });
  c.send({ type: 'text', text: 'browser test' });
  const t = await c.waitFor((m) => m.type === 'tool' && m.name === 'browser_open' && m.status !== 'running', 30_000);
  assert.equal(t.status, 'done', t.summary);
  await c.waitFor((m) => m.type === 'assistant_done' && /Jarvis Testseite/.test(m.text), 10_000);
  c.close();
});

test('Kompatibilität: lehnt die API einen optionalen Parameter ab, wird ohne ihn wiederholt', async () => {
  mock.opts.rejectFallback = true;
  const c = new FakeClient();
  await c.ready();
  await c.waitFor((m) => m.type === 'snapshot');
  c.send({ type: 'claim_primary' });
  c.send({ type: 'text', text: 'Hallo Jarvis' });
  await c.waitFor((m) => m.type === 'assistant_done' && /Verstanden/.test(m.text), 8000);
  assert.ok(!lastMainRequest().body.fallbacks, 'Wiederholung ohne fallbacks');
  mock.opts.rejectFallback = false;
  c.close();
});
