// JARVIS 2.0 – Frontend-Einstieg: verbindet Reaktorkern, HUD, Sprachsteuerung und Server.
import { Reactor } from './reactor/reactor.js';
import { Net } from './net.js';
import { AudioOut, pickGermanVoice } from './voice/audioOut.js';
import { VoiceController } from './voice/controller.js';
import { renderSystem, renderMcp, renderAgenda, renderTasks, renderActivity, renderLog, toast, esc } from './ui/hud.js';

const $ = (id) => document.getElementById(id);
const store = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(`jarvis.${k}`);
    localStorage.setItem(`jarvis.${k}`, v);
  } catch {
    return null;
  }
};

const STATE_LABEL = {
  idle: 'BEREIT',
  listening: 'HÖRE ZU',
  processing: 'VERARBEITE',
  speaking: 'SPRECHE',
  interrupted: 'UNTERBROCHEN',
  executing: 'FÜHRE AUS',
  error: 'FEHLER',
};

const app = {
  cfg: null,
  state: 'idle',
  connected: false,
  primary: false,
  booted: false,
  tasks: new Map(),
  activity: [],
  log: [],
  events: undefined,
  todos: null,
  currentAssistant: null,
  confirmId: null,
};

// ---------- Reaktor ----------
const reactor = new Reactor($('reactor'));
reactor.anchorTo($('core-hitbox'));

// ---------- Audio ----------
let ctx = null;
let audioOut = null;
let voice = null;

function ensureAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  audioOut = new AudioOut(ctx, {
    onPlayback: (p) => net.send({ type: 'playback', ...p }),
    onState: (playing) => net.send({ type: 'audio_state', playing }),
    onSentence: (text) => showJarvisLine(text),
  });
  audioOut.setVolume(Number(store('volume') ?? 1));
  audioOut.muted = store('speak') === '0';
  audioOut.rate = app.cfg?.tts?.speed || 1;
  const setVoice = () => (audioOut.browserVoice = pickGermanVoice(store('browserVoice') || app.cfg?.tts?.browserVoice));
  if ('speechSynthesis' in window) {
    setVoice();
    speechSynthesis.onvoiceschanged = () => {
      setVoice();
      fillBrowserVoices();
    };
  }
}

function setupVoice() {
  if (voice || !app.cfg) return;
  voice = new VoiceController({
    ctx,
    net,
    cfg: app.cfg,
    audioOut,
    onMode: (mode, info) => setMicMode(mode, info),
    onNotice: (level, title, body) => toast(level, title, body),
  });
  voice.wakeEnabled = store('wake') !== '0';
  voice.setConvState(app.state);
}

// ---------- Netzwerk ----------
const net = new Net(onMessage, (ok) => {
  app.connected = ok;
  if (!ok) {
    setState('error', 'Verbindung zum JARVIS-Server unterbrochen – verbinde neu …');
    audioOut?.stop();
  }
});

function onMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      return applySnapshot(msg);
    case 'state':
      return setState(msg.state, msg.detail);
    case 'speech':
      ensureAudio();
      return audioOut.enqueue(msg);
    case 'subtitle':
      return showJarvisLine(msg.text);
    case 'audio_stop':
      return audioOut?.stop();
    case 'wake':
      reactor.wave(1.2);
      $('line-user').textContent = '';
      return;
    case 'transcript':
      $('line-user').textContent = msg.handled ? `${msg.text} (${msg.handled})` : msg.text;
      return;
    case 'user_message':
      $('line-user').textContent = msg.text;
      app.log.push({ role: 'user', text: msg.text });
      return renderLog(app.log);
    case 'assistant_delta':
      if (!app.currentAssistant || app.currentAssistant.turnId !== msg.turnId) {
        app.currentAssistant = { turnId: msg.turnId, role: 'assistant', text: '' };
        app.log.push(app.currentAssistant);
      }
      app.currentAssistant.text += msg.delta;
      return throttleLog();
    case 'assistant_done':
      if (app.currentAssistant?.turnId === msg.turnId) {
        if (msg.interrupted) app.currentAssistant.text += ' ⟂';
      } else if (msg.text) app.log.push({ role: 'assistant', text: msg.text });
      app.currentAssistant = null;
      return renderLog(app.log);
    case 'announcement':
      app.log.push({ role: 'system', text: msg.text });
      return renderLog(app.log);
    case 'tool': {
      const i = app.activity.findIndex((a) => a.callId === msg.callId);
      if (i >= 0) app.activity[i] = { ...app.activity[i], ...msg, label: msg.label || app.activity[i].label };
      else app.activity.unshift(msg);
      app.activity = app.activity.slice(0, 60);
      return renderActivity(app.activity);
    }
    case 'task':
      app.tasks.set(msg.task.id, msg.task);
      updateActivityLevel();
      return renderTasks(app.tasks, cancelTask);
    case 'mcp':
      return renderMcp(msg.servers);
    case 'metrics':
      return renderSystem(msg);
    case 'todos':
      app.todos = msg;
      return renderAgenda(app.events, app.todos);
    case 'calendar':
      app.events = msg.events;
      return renderAgenda(app.events, app.todos);
    case 'notification':
      return toast(msg.level, msg.title, msg.body);
    case 'confirm_request':
      return showConfirm(msg);
    case 'confirm_resolved':
      if (app.confirmId === msg.id) hideConfirm();
      return;
    case 'primary':
      app.primary = msg.primary;
      if (!msg.primary) toast('info', 'Anderes Fenster aktiv', 'Mikrofon und Sprachausgabe laufen in einem anderen JARVIS-Fenster.');
      return;
    case 'tts_settings':
      app.cfg.tts = { ...app.cfg.tts, ...msg };
      if (audioOut) audioOut.rate = msg.speed;
      return syncSettings();
    case 'history_cleared':
      app.log = [];
      return renderLog(app.log);
    case 'stt_status':
      if (msg.status === 'error') setMicMode('error', msg.error);
      return;
  }
}

let logTimer = null;
function throttleLog() {
  if (logTimer) return;
  logTimer = setTimeout(() => {
    logTimer = null;
    renderLog(app.log);
  }, 120);
}

function applySnapshot(s) {
  app.cfg = s.config;
  app.primary = s.primary;
  $('model-label').textContent = `${s.config.model} · ${s.config.stt.provider.toUpperCase()} · ${s.config.tts.provider.toUpperCase()}`;
  setState(s.conversation.state.state, s.conversation.state.detail);
  app.log = s.conversation.transcript.map((t) => ({ role: t.role, text: t.text.replace(/^\[SYSTEM-EREIGNIS\]\s*/, '') , ...(t.text.startsWith('[SYSTEM-EREIGNIS]') ? { role: 'system' } : {}) }));
  renderLog(app.log);
  if (s.metrics) renderSystem(s.metrics);
  renderMcp(s.mcp);
  app.todos = s.todos;
  renderAgenda(app.events, app.todos);
  app.tasks = new Map([...s.tasks.recent, ...s.tasks.running].map((t) => [t.id, t]));
  renderTasks(app.tasks, cancelTask);
  updateActivityLevel();
  for (const n of s.notifications.slice(-3)) toast(n.level, n.title, n.body);
  if (s.confirmations[0]) showConfirm(s.confirmations[0]);
  syncSettings();
  bootLog(s);
  if (app.booted) {
    // Nach Wiederverbindung: Sprachsteuerung wieder übernehmen
    net.send({ type: 'claim_primary' });
    if (voice?.micEnabled) net.send({ type: 'mic', enabled: true });
  }
}

function updateActivityLevel() {
  const n = [...app.tasks.values()].filter((t) => t.status === 'running').length;
  reactor.setActivity(n);
}

function cancelTask(id) {
  net.send({ type: 'task_cancel', id });
}

// ---------- Zustand ----------
function setState(state, detail = '') {
  app.state = state;
  document.body.dataset.state = state;
  $('state-label').textContent = app.connected || state === 'error' ? STATE_LABEL[state] || state.toUpperCase() : 'OFFLINE';
  $('state-detail').textContent = detail || '';
  reactor.setState(state);
  voice?.setConvState(state);
  if (state === 'idle') setTimeout(() => app.state === 'idle' && fadeLines(), 6000);
}

function fadeLines() {
  $('line-user').classList.add('fade');
  $('line-jarvis').classList.add('fade');
}

function showJarvisLine(text) {
  const el = $('line-jarvis');
  el.classList.remove('fade');
  $('line-user').classList.remove('fade');
  el.innerHTML = text
    .split(/(\s+)/)
    .map((w, i) => (w.trim() ? `<span class="w" style="animation-delay:${Math.min(i * 28, 1400)}ms">${esc(w)}</span>` : w))
    .join('');
}

function setMicMode(mode, info) {
  const el = $('mic-indicator');
  el.dataset.mode = mode;
  const text = { off: 'MIC AUS', local: voice?.wakeEnabled ? 'MIC LOKAL · WAKE' : 'MIC LOKAL', stream: 'AUDIO → STT', error: 'MIC FEHLER' }[mode];
  $('mic-text').textContent = text;
  el.title =
    mode === 'stream'
      ? 'Audio wird gerade an die Spracherkennung übertragen'
      : mode === 'local'
        ? 'Mikrofon aktiv – Audio bleibt lokal, bis „Jarvis“ erkannt wird'
        : info || 'Mikrofon aus';
  $('set-mic').checked = mode !== 'off' && mode !== 'error';
}

// ---------- Visualisierung mit echten Audiodaten ----------
function audioLoop() {
  if (audioOut && (app.state === 'speaking' || audioOut.playing)) {
    const a = audioOut.sample();
    reactor.setAudio(a.level, a.bins);
  } else if (voice?.micEnabled) {
    const a = voice.sample();
    reactor.setAudio(app.state === 'listening' ? a.level : a.level * 0.4, a.bins);
  } else reactor.setAudio(0);
  requestAnimationFrame(audioLoop);
}
requestAnimationFrame(audioLoop);

// ---------- Boot ----------
let bootLogged = false;
function bootLog(s) {
  if (bootLogged) return;
  bootLogged = true;
  const lines = [
    `> Kernverbindung ............ OK`,
    `> Sprachmodell .............. ${s.config.claudeConfigured ? s.config.model : 'FEHLT (ANTHROPIC_API_KEY)'}`,
    `> Spracherkennung ........... ${s.config.stt.provider === 'deepgram' ? 'Deepgram Streaming' : 'Browser (Web Speech)'}`,
    `> Sprachausgabe ............. ${{ elevenlabs: 'ElevenLabs', openai: 'OpenAI', browser: 'Browser-Stimme' }[s.config.tts.provider]}`,
    `> Wake-Word ................. ${s.config.wake.engine === 'porcupine' ? 'Porcupine (lokal)' : 'Transkript'}`,
    `> MCP-Integrationen ......... ${s.mcp.length}`,
    `> Werkzeuge ................. ${s.tools.length}`,
  ];
  const el = $('boot-log');
  lines.forEach((l, i) => setTimeout(() => (el.textContent += `${l}\n`), 120 * i));
}

async function boot() {
  if (app.booted) return;
  ensureAudio();
  await ctx.resume().catch(() => {});
  app.booted = true;
  $('boot').classList.add('hidden');
  net.send({ type: 'claim_primary' });
  const wait = () => new Promise((r) => (app.cfg ? r() : setTimeout(() => wait().then(r), 100)));
  await wait();
  setupVoice();
  if (store('mic') !== '0') await voice.enableMic();
  setMicMode(voice.micEnabled ? 'local' : 'off');
  syncSettings();
}
$('boot-btn').addEventListener('click', boot);

// Automatischer Start, wenn Browser Audio+Mikrofon bereits erlaubt (z.B. Kiosk-/Autostart-Modus)
(async () => {
  try {
    const perm = await navigator.permissions?.query({ name: 'microphone' });
    const probe = new (window.AudioContext || window.webkitAudioContext)();
    const autoplay = probe.state === 'running';
    probe.close();
    if (perm?.state === 'granted' && autoplay) boot();
  } catch {
    /* manueller Start */
  }
})();

// ---------- Interaktion ----------
function activateOrInterrupt() {
  if (!app.booted) return boot();
  if (['speaking', 'processing', 'executing'].includes(app.state)) {
    audioOut?.stop();
    net.send({ type: 'interrupt', source: 'manual' });
  } else if (voice?.micEnabled) {
    voice.trigger('manual');
  } else {
    $('command-input').focus();
  }
}
$('core-hitbox').addEventListener('click', activateOrInterrupt);
window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  if (e.code === 'Space' && !typing) {
    e.preventDefault();
    activateOrInterrupt();
  } else if (e.code === 'Escape') {
    audioOut?.stop();
    net.send({ type: 'interrupt', source: 'escape' });
    if (!$('confirm').hidden) answerConfirm(false);
  }
});

$('command-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('command-input');
  const text = input.value.trim();
  if (!text) return;
  if (!app.booted) boot();
  ensureAudio();
  net.send({ type: 'text', text });
  input.value = '';
});

$('mic-indicator').addEventListener('click', () => toggleMic());
async function toggleMic(force) {
  if (!app.booted) return boot();
  const on = force ?? !voice.micEnabled;
  store('mic', on ? '1' : '0');
  if (on) await voice.enableMic();
  else voice.disableMic();
}

// ---------- Bestätigungen ----------
function showConfirm({ id, title, detail }) {
  app.confirmId = id;
  $('confirm-title').textContent = title;
  $('confirm-detail').textContent = detail || '';
  $('confirm-detail').hidden = !detail;
  $('confirm').hidden = false;
}
function hideConfirm() {
  app.confirmId = null;
  $('confirm').hidden = true;
}
function answerConfirm(approved) {
  if (app.confirmId) net.send({ type: 'confirm', id: app.confirmId, approved });
  hideConfirm();
}
$('confirm-yes').addEventListener('click', () => answerConfirm(true));
$('confirm-no').addEventListener('click', () => answerConfirm(false));

// ---------- Einstellungen ----------
$('settings-btn').addEventListener('click', () => ($('settings').hidden = !$('settings').hidden));
$('settings-close').addEventListener('click', () => ($('settings').hidden = true));

function fillBrowserVoices() {
  if (!('speechSynthesis' in window)) return;
  const sel = $('set-browser-voice');
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('de'));
  sel.innerHTML = voices.length ? voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('') : '<option value="">Keine deutsche Stimme</option>';
  if (audioOut?.browserVoice) sel.value = audioOut.browserVoice.name;
}

function syncSettings() {
  const cfg = app.cfg;
  if (!cfg) return;
  const prov = $('set-provider');
  prov.querySelector('[value=elevenlabs]').disabled = !cfg.tts.elevenConfigured;
  prov.querySelector('[value=openai]').disabled = !cfg.tts.openaiConfigured;
  prov.value = cfg.tts.provider;
  $('row-browser-voice').style.display = cfg.tts.provider === 'browser' ? '' : 'none';
  $('set-speed').value = cfg.tts.speed;
  $('speed-val').textContent = `${Number(cfg.tts.speed).toFixed(2)}×`;
  $('set-volume').value = store('volume') ?? 1;
  $('set-speak').checked = store('speak') !== '0';
  $('set-wake').checked = store('wake') !== '0';
  $('set-mic').checked = Boolean(voice?.micEnabled);
  const engine = voice?.wakeEngine || cfg.wake.engine;
  $('wake-engine').textContent =
    engine === 'porcupine'
      ? 'Wake-Word-Engine: Porcupine – läuft lokal im Browser, kein Audio verlässt den Rechner bis „Jarvis“.'
      : 'Wake-Word-Engine: Transkript – Audio wird bei erkannter Sprache an die Spracherkennung gesendet. Für rein lokale Erkennung PICOVOICE_ACCESS_KEY setzen.';
  $('stt-info').textContent = `Spracherkennung: ${cfg.stt.provider === 'deepgram' ? 'Deepgram Streaming (DEEPGRAM_API_KEY)' : 'Browser / Web Speech API (Chrome, Edge)'}`;
  fillBrowserVoices();
}

$('set-mic').addEventListener('change', (e) => toggleMic(e.target.checked));
$('set-wake').addEventListener('change', async (e) => {
  store('wake', e.target.checked ? '1' : '0');
  if (voice) await voice.setWakeEnabled(e.target.checked);
  syncSettings();
});
$('set-speak').addEventListener('change', (e) => {
  store('speak', e.target.checked ? '1' : '0');
  ensureAudio();
  audioOut.muted = !e.target.checked;
});
$('set-provider').addEventListener('change', (e) => net.send({ type: 'tts_settings', provider: e.target.value }));
$('set-speed').addEventListener('input', (e) => ($('speed-val').textContent = `${Number(e.target.value).toFixed(2)}×`));
$('set-speed').addEventListener('change', (e) => net.send({ type: 'tts_settings', speed: Number(e.target.value) }));
$('set-volume').addEventListener('input', (e) => {
  store('volume', e.target.value);
  ensureAudio();
  audioOut.setVolume(Number(e.target.value));
});
$('set-browser-voice').addEventListener('change', (e) => {
  store('browserVoice', e.target.value);
  ensureAudio();
  audioOut.browserVoice = pickGermanVoice(e.target.value);
});
$('clear-history').addEventListener('click', () => {
  if (confirm('Gesprächsverlauf wirklich löschen? Das Langzeitgedächtnis bleibt erhalten.')) net.send({ type: 'clear_history' });
});
$('log-toggle').addEventListener('click', () => $('log-body').scrollTo({ top: 0, behavior: 'smooth' }));

// ---------- Uhr ----------
function tick() {
  const now = new Date();
  $('clock-time').textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  $('clock-date').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}
tick();
setInterval(tick, 1000);
// Kalender regelmäßig aktualisieren
setInterval(() => net.send({ type: 'calendar' }), 5 * 60_000);
