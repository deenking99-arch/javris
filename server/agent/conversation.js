// Gesprächssteuerung: Wake-Word, Turn-Erkennung, Unterbrechungen (Barge-in), Streaming-Antworten
// mit satzweiser Sprachausgabe und Ableitung des Gesprächszustands.
import { config } from '../config.js';
import { bus, uid } from '../core/bus.js';
import { JsonStore } from '../core/store.js';
import { ConversationStateMachine, S } from '../core/stateMachine.js';
import { answerPendingByVoice, hasPendingConfirmation } from '../core/confirm.js';
import { runAgentLoop, AbortedError, pushUser } from './claude.js';
import { MAIN_SYSTEM } from './prompts.js';
import { SentenceChunker } from '../voice/sentences.js';
import { synthesize } from '../voice/tts.js';
import { memoryContext, memoryItems } from '../tools/memory.js';
import { tasksSnapshot } from './tasks.js';

const WAKE_RE = /\b(jarvis|jarvi|javis|jervis|jarwis|tscharvis|dscharvis|tschawis|dschawis|scharwis|jawis|charvis|chavis)\b[\s,.!?:;-]*/i;
const STOP_ONLY_RE = /^(stopp?|halt|ruhe|sei still|still|warte|moment|abbrechen|schon gut|danke,? das reicht|das reicht)[\s.!]*$/i;
const BARGE_KEYWORDS_RE = /\b(stopp?|halt|warte|moment|ruhe|jarvis|nein|aufhören)\b/i;
const CONTINUE_RE = /(\b(und|oder|aber|weil|dass|also|dann|sowie|bzw|beziehungsweise|mit|für|von|zu|um|ähm|äh)|,)\s*$/i;

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

class SpeechOut {
  constructor(conv, turnId) {
    this.conv = conv;
    this.turnId = turnId;
    this.seq = 0;
    this.chain = Promise.resolve();
    this.outstanding = new Set();
    this.sentAll = false;
    this.abort = new AbortController();
    this.finished = false;
    this.onFinished = null;
  }
  say(sentence) {
    if (this.abort.signal.aborted) return;
    const seq = this.seq++;
    this.outstanding.add(seq);
    this.conv.pendingAudio = true;
    const audioP = synthesize(sentence, { signal: this.abort.signal }).catch((e) => {
      if (!this.abort.signal.aborted) this.conv.reportTtsError(e);
      return null; // Fallback: Browser spricht diesen Satz selbst
    });
    this.chain = this.chain.then(async () => {
      const audio = await audioP;
      if (this.abort.signal.aborted) return;
      this.conv.recentSpoken.push(sentence);
      if (this.conv.recentSpoken.length > 4) this.conv.recentSpoken.shift();
      const delivered = this.conv.sendSpeech({ turnId: this.turnId, seq, text: sentence, audio: audio ? audio.toString('base64') : null });
      if (!delivered) this.ack(seq, 'end');
      else {
        // Sicherheitsnetz, falls der Client kein Ende meldet
        const words = sentence.split(/\s+/).length;
        setTimeout(() => this.ack(seq, 'end'), 8000 + words * 600);
      }
    });
  }
  end() {
    this.chain = this.chain.then(() => {
      this.sentAll = true;
      this.#check();
    });
    return this.chain;
  }
  ack(seq, status) {
    if (status === 'end' && this.outstanding.delete(seq)) this.#check();
  }
  #check() {
    if (this.sentAll && this.outstanding.size === 0 && !this.finished) {
      this.finished = true;
      this.onFinished?.();
    }
  }
  stop() {
    this.abort.abort();
    this.outstanding.clear();
  }
}

export class Conversation {
  constructor() {
    this.sm = new ConversationStateMachine();
    this.history = new JsonStore('history', { messages: [], memoryVersion: -1 });
    this.messages = this.history.data.messages;
    this.turn = null;
    this.speech = null; // aktive Sprachausgabe (Turn oder Ansage)
    this.playing = false;
    this.pendingAudio = false;
    this.listening = false;
    this.utterance = '';
    this.interim = '';
    this.commitTimer = null;
    this.listenTimer = null;
    this.interruptedUntil = 0;
    this.errorUntil = 0;
    this.recentSpoken = [];
    this.eventQueue = [];
    this.announceQueue = [];
    this.sendSpeech = () => false; // wird vom Server (WebSocket) gesetzt
    this.lastTtsErrorAt = 0;
    bus.on('confirm_speak', (text) => this.announce(text, { priority: true, thenListen: true }));
  }

  // ---------- Zustand ----------
  refresh(detail) {
    const now = Date.now();
    if (now < this.errorUntil || now < this.interruptedUntil) return;
    let s;
    if (this.playing) s = S.SPEAKING;
    else if (this.turn?.toolsActive) s = S.EXECUTING;
    else if (this.turn || this.pendingAudio) s = S.PROCESSING;
    else if (this.listening) s = S.LISTENING;
    else s = S.IDLE;
    const d = detail ?? (s === S.EXECUTING ? this.turn?.toolLabel || 'Führe Aktion aus' : s === S.LISTENING ? 'Ich höre' : '');
    this.sm.transition(s, d);
    if (s === S.IDLE) this.#drainEvents();
  }

  #setListening(on, timeoutMs) {
    this.listening = on;
    clearTimeout(this.listenTimer);
    if (on && timeoutMs) {
      this.listenTimer = setTimeout(() => {
        if (!this.utterance && !this.interim) {
          this.listening = false;
          this.refresh();
        }
      }, timeoutMs);
    }
    if (!on) {
      this.utterance = '';
      this.interim = '';
    }
    this.refresh();
  }

  // ---------- Eingänge vom Client ----------
  /** Wake-Word lokal erkannt (Porcupine) oder manuell (Klick/Taste). */
  wake(source = 'wakeword') {
    if (this.turn || this.playing) {
      this.interrupt(source);
    }
    bus.broadcast('wake', { source });
    this.#setListening(true, 7000);
  }

  /** Lokale Sprachaktivität (VAD) */
  vad(speaking) {
    if (speaking && this.listening) clearTimeout(this.listenTimer);
  }

  /** Transkript (Deepgram oder Browser-Spracherkennung) */
  transcript({ text, isFinal, speechFinal }) {
    text = (text || '').trim();
    // 1) Offene Bestätigung per Sprache beantworten
    if (text && (isFinal || speechFinal) && hasPendingConfirmation()) {
      const answer = answerPendingByVoice(text);
      if (answer !== null) {
        bus.broadcast('transcript', { text, final: true, handled: answer ? 'bestätigt' : 'abgelehnt' });
        this.#setListening(false);
        return;
      }
    }

    // 2) Während Jarvis arbeitet/spricht: nur echte Unterbrechungen durchlassen
    if (this.turn || this.playing) {
      if (!text || !this.#isBargeIn(text)) return;
      this.interrupt('voice');
      this.listening = true;
    }

    // 3) Ruhezustand: auf Wake-Word warten
    if (!this.listening) {
      if (!text) return;
      const m = text.match(WAKE_RE);
      if (!m) return;
      bus.broadcast('wake', { source: 'transcript' });
      this.listening = true;
      clearTimeout(this.listenTimer);
      text = text.slice(m.index + m[0].length).trim() || (text.slice(0, m.index).trim().length > 2 ? text.replace(WAKE_RE, '').trim() : '');
      if (!text) {
        if (isFinal) this.#setListening(true, 7000);
        else this.refresh();
        return;
      }
    } else {
      // Führendes "Jarvis," entfernen
      const m = text.match(WAKE_RE);
      if (m && m.index === 0 && !this.utterance) text = text.slice(m[0].length).trim();
    }

    // 4) Zuhören: Äußerung zusammensetzen
    clearTimeout(this.listenTimer);
    clearTimeout(this.commitTimer);
    if (isFinal) {
      if (text) this.utterance = `${this.utterance} ${text}`.trim();
      this.interim = '';
    } else {
      this.interim = text;
    }
    bus.broadcast('transcript', { text: `${this.utterance} ${this.interim}`.trim(), final: false });
    this.refresh();

    if (speechFinal && this.utterance) {
      // Endpunkt erkannt: kurz warten, bei angefangenem Gedanken länger
      const delay = CONTINUE_RE.test(this.utterance) ? 1400 : 250;
      this.commitTimer = setTimeout(() => this.#commit(), delay);
    }
  }

  /** Deepgram-UtteranceEnd: Sprecher ist sicher fertig. */
  utteranceEnd() {
    if (this.listening && this.utterance) {
      clearTimeout(this.commitTimer);
      this.#commit();
    }
  }

  #commit() {
    const text = this.utterance.trim();
    this.utterance = '';
    this.interim = '';
    if (!text) return;
    bus.broadcast('transcript', { text, final: true });
    if (STOP_ONLY_RE.test(text)) {
      this.#setListening(false);
      return;
    }
    this.listening = false;
    clearTimeout(this.listenTimer);
    this.handleUtterance(text, { source: 'voice' });
  }

  #isBargeIn(text) {
    const words = norm(text);
    if (!words.length) return false;
    // Echo-Schutz: Stimmt das Gehörte mit dem gerade Gesprochenen überein, ist es Jarvis selbst.
    const spoken = new Set(norm(this.recentSpoken.join(' ')));
    const overlap = words.filter((w) => spoken.has(w)).length / words.length;
    if (BARGE_KEYWORDS_RE.test(text) && !(words.length > 2 && overlap > 0.7)) return true;
    if (words.length < 3) return false;
    return overlap < 0.5;
  }

  /** Unterbricht Sprachausgabe und laufende Antwortgenerierung (nicht die Hintergrund-Agenten). */
  interrupt(source = 'user') {
    const had = Boolean(this.turn || this.playing || this.speech);
    this.speech?.stop();
    this.speech = null;
    this.announceQueue = [];
    if (this.turn) {
      this.turn.interrupted = true;
      this.turn.abort.abort();
    }
    this.playing = false;
    this.pendingAudio = false;
    bus.broadcast('audio_stop', { source });
    if (had) {
      this.interruptedUntil = Date.now() + 450;
      this.sm.transition(S.INTERRUPTED, 'Unterbrochen');
      setTimeout(() => this.refresh(), 470);
    }
  }

  /** Wiedergabe-Status vom Client */
  playback({ turnId, seq, status }) {
    if (this.speech && this.speech.turnId === turnId) this.speech.ack(seq, status);
  }
  audioState(playing) {
    clearTimeout(this.audioTimer);
    if (playing) {
      this.playing = true;
      this.pendingAudio = false;
      this.refresh();
    } else {
      // kleine Hysterese gegen Flackern zwischen zwei Sätzen
      this.audioTimer = setTimeout(() => {
        this.playing = false;
        this.refresh();
      }, 220);
    }
  }

  reportTtsError(e) {
    console.warn('[tts]', e.message);
    if (Date.now() - this.lastTtsErrorAt > 60_000) {
      this.lastTtsErrorAt = Date.now();
      bus.broadcast('notification', { level: 'error', title: 'Sprachausgabe gestört', body: `${e.message} – nutze vorübergehend die Browser-Stimme.` });
    }
  }

  // ---------- Antworten ----------
  #contextLine(source) {
    const now = new Date();
    const time = now.toLocaleString('de-DE', { timeZone: config.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const hour = Number(now.toLocaleString('de-DE', { timeZone: config.timezone, hour: '2-digit', hour12: false }));
    const daypart = hour < 5 ? 'Nacht' : hour < 11 ? 'Morgen' : hour < 14 ? 'Mittag' : hour < 18 ? 'Nachmittag' : hour < 22 ? 'Abend' : 'Nacht';
    const running = tasksSnapshot().running.map((t) => `${t.title} (${t.status}, ${t.id})`);
    let ctx = `[Kontext (automatisch, nicht vom Nutzer): ${time}, ${daypart}. Eingabe per ${source === 'voice' ? 'Sprache' : source === 'event' ? 'Systemereignis' : 'Tastatur'}.`;
    if (running.length) ctx += ` Laufende Hintergrundaufgaben: ${running.join('; ')}.`;
    const memVersion = memoryItems().length;
    if (memVersion !== this.history.data.memoryVersion && memVersion > 0) {
      ctx += `\nGedächtnis (aktueller Stand):\n${memoryContext()}`;
      this.history.data.memoryVersion = memVersion;
    }
    return `${ctx}]`;
  }

  /**
   * Verarbeitet eine Nutzereingabe (Sprache oder Text) oder ein Systemereignis.
   * @param {string} text
   * @param {{source:'voice'|'text'|'event'}} opts
   */
  async handleUtterance(text, { source = 'text' } = {}) {
    const prev = this.turn;
    if (this.turn || this.playing) this.interrupt('new_input');
    // Erst warten, bis der unterbrochene Turn seinen Verlauf sauber abgeschlossen hat
    if (prev) await prev.done;
    clearTimeout(this.listenTimer);
    this.listening = false;
    if (source !== 'event') bus.broadcast('user_message', { text, source });

    if (!config.claude.configured) {
      this.#fail('ANTHROPIC_API_KEY fehlt. Bitte in der .env-Datei eintragen und Jarvis neu starten.');
      return;
    }

    const turnId = uid('turn');
    const abort = new AbortController();
    let resolveDone;
    const turn = { id: turnId, abort, toolsActive: false, toolLabel: '', text: '', interrupted: false, done: new Promise((r) => (resolveDone = r)) };
    this.turn = turn;
    const speech = new SpeechOut(this, turnId);
    this.speech = speech;
    const chunker = new SentenceChunker((s) => speech.say(s));

    pushUser(this.messages, [
      { type: 'text', text: this.#contextLine(source) },
      { type: 'text', text },
    ]);
    this.refresh('Denke nach');

    const toolListener = (ev) => {
      if (ev.type === 'tool' && ev.source === 'main' && ev.status === 'running' && this.turn === turn) {
        turn.toolLabel = ev.label || ev.name;
        this.refresh(turn.toolLabel);
      }
    };
    bus.on('broadcast', toolListener);

    try {
      const res = await runAgentLoop({
        system: MAIN_SYSTEM,
        messages: this.messages,
        kind: 'main',
        signal: abort.signal,
        onText: (d) => {
          turn.text += d;
          chunker.push(d);
          bus.broadcast('assistant_delta', { turnId, delta: d });
        },
        onToolsActive: (active) => {
          if (active) chunker.flush();
          turn.toolsActive = active;
          if (active) turn.text += '\n';
          this.refresh();
        },
      });
      chunker.flush();
      if (!turn.text.trim() && res.text) speech.say(res.text);
      bus.broadcast('assistant_done', { turnId, text: turn.text.trim() || res.text });
    } catch (e) {
      if (e instanceof AbortedError || abort.signal.aborted) {
        const partial = (e.partial ?? '').trim();
        if (partial) this.messages.push({ role: 'assistant', content: [{ type: 'text', text: `${partial} [vom Nutzer unterbrochen]` }] });
        bus.broadcast('assistant_done', { turnId, text: turn.text.trim(), interrupted: true });
      } else {
        console.error('[conversation]', e);
        bus.broadcast('assistant_done', { turnId, text: turn.text.trim(), error: true });
        this.#saveHistory();
        bus.off('broadcast', toolListener);
        if (this.turn === turn) this.turn = null;
        this.#fail(this.#explainError(e));
        return;
      }
    } finally {
      bus.off('broadcast', toolListener);
      resolveDone();
    }
    this.#saveHistory();
    if (this.turn !== turn) return; // bereits durch neuen Turn ersetzt
    this.turn = null;
    if (turn.interrupted) return this.refresh();

    speech.onFinished = () => {
      if (this.speech === speech) this.speech = null;
      this.pendingAudio = false;
      // Folgefragen ohne Wake-Word ermöglichen
      if (source !== 'event' || this.eventQueue.length === 0) this.#setListening(true, config.wake.followUpWindowMs);
      else this.refresh();
    };
    speech.end();
    this.refresh();
  }

  #explainError(e) {
    const status = e?.status;
    if (status === 401) return 'Der Anthropic-API-Schlüssel ist ungültig. Bitte prüfe ANTHROPIC_API_KEY in der .env.';
    if (status === 429) return 'Das Anfragelimit der Claude-API ist erreicht. Bitte versuche es gleich noch einmal.';
    if (status === 529 || status >= 500) return 'Die Claude-API ist gerade überlastet. Bitte versuche es gleich noch einmal.';
    if (e?.code === 'ENOTFOUND' || /Connection error/i.test(e?.message || '')) return 'Ich erreiche die Claude-API nicht. Bitte prüfe die Internetverbindung.';
    return `Es ist ein Fehler aufgetreten: ${e?.message || e}`;
  }

  #fail(message) {
    this.turn = null;
    this.errorUntil = Date.now() + 4000;
    this.sm.transition(S.ERROR, message);
    bus.broadcast('notification', { level: 'error', title: 'Fehler', body: message });
    setTimeout(() => {
      this.errorUntil = 0;
      this.refresh();
    }, 4050);
    this.announce(message.split('.')[0] + '.', { priority: true });
  }

  #saveHistory() {
    // Verlauf begrenzen: nur am Anfang kürzen, an einer sauberen Nutzer-Nachricht ansetzen.
    const MAX = 80;
    if (this.messages.length > MAX) {
      let i = this.messages.length - 60;
      while (i < this.messages.length) {
        const m = this.messages[i];
        const hasToolResult = Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
        if (m.role === 'user' && !hasToolResult) break;
        i++;
      }
      if (i < this.messages.length) {
        this.messages.splice(0, i);
        this.history.data.memoryVersion = -1; // Gedächtnis beim nächsten Turn erneut einblenden
      }
    }
    this.history.data.messages = this.messages;
    this.history.save();
  }

  clearHistory() {
    this.interrupt('reset');
    this.messages.length = 0;
    this.history.data.memoryVersion = -1;
    this.#saveHistory();
    bus.broadcast('history_cleared', {});
  }

  /** Spricht einen Text direkt (ohne Claude), z.B. Erinnerungen oder Bestätigungsfragen. */
  announce(text, { priority = false, thenListen = false } = {}) {
    const run = () => {
      const speech = new SpeechOut(this, uid('ann'));
      if (!priority || !this.speech) this.speech = speech;
      else {
        // Bestätigungsfrage während ein Turn wartet: eigene Ausgabe parallel verwalten
        this.announceSpeech = speech;
      }
      bus.broadcast('announcement', { text });
      speech.onFinished = () => {
        if (this.speech === speech) this.speech = null;
        this.pendingAudio = false;
        if (thenListen) this.#setListening(true, 15000);
        else this.refresh();
        const next = this.announceQueue.shift();
        if (next) next();
      };
      speech.say(text);
      speech.end();
      this.refresh();
    };
    if (priority || (!this.turn && !this.playing && !this.speech)) run();
    else this.announceQueue.push(run);
  }

  playbackAny(msg) {
    this.playback(msg);
    if (this.announceSpeech?.turnId === msg.turnId) this.announceSpeech.ack(msg.seq, msg.status);
  }

  /** Systemereignis (z.B. Aufgabe fertig) – wird gesprochen, sobald Jarvis frei ist. */
  queueEvent(text) {
    this.eventQueue.push(text);
    if (this.sm.is(S.IDLE)) this.#drainEvents();
  }

  #drainEvents() {
    if (!this.eventQueue.length || this.turn || this.playing || this.speech || this.listening) return;
    const next = this.eventQueue.shift();
    setTimeout(() => this.handleUtterance(`[SYSTEM-EREIGNIS] ${next}`, { source: 'event' }), 50);
  }

  snapshot() {
    // Sichtbarer Verlauf für die UI (nur Text, ohne Tool-Interna)
    const items = [];
    for (const m of this.messages.slice(-30)) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      const texts = blocks.filter((b) => b.type === 'text' && !b.text.startsWith('[Kontext')).map((b) => b.text);
      if (texts.length) items.push({ role: m.role, text: texts.join('\n') });
    }
    return { state: this.sm.snapshot(), transcript: items };
  }
}
