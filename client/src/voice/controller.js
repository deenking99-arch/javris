// Sprachsteuerung im Browser: Mikrofon, Wake-Word, Weiterleitung an die Spracherkennung und
// transparente Anzeige, wann Audio den Rechner verlässt.
import { Mic } from './mic.js';
import { BrowserSTT } from './browserStt.js';

export class VoiceController {
  /**
   * @param {{ctx:AudioContext, net:any, cfg:any, audioOut:any, onMode:(mode:string, info?:string)=>void, onNotice:(level:string,title:string,body:string)=>void}} o
   */
  constructor({ ctx, net, cfg, audioOut, onMode, onNotice }) {
    this.ctx = ctx;
    this.net = net;
    this.cfg = cfg;
    this.audioOut = audioOut;
    this.onMode = onMode;
    this.onNotice = onNotice;
    this.mic = new Mic(ctx);
    this.convState = 'idle';
    this.micEnabled = false;
    this.wakeEnabled = true;
    this.wakeEngine = cfg.wake.engine; // 'porcupine' | 'transcript'
    this.wake = null;
    this.localListenUntil = 0;
    this.hangoverUntil = 0;
    this.streaming = false;
    this.duckTimer = null;
    this.stt = cfg.stt.provider; // 'deepgram' | 'browser'
    this.browserStt = null;

    this.mic.onFrame = (pcm) => this.#frame(pcm);
    this.mic.onVad = (speaking) => this.#vad(speaking);
    this.mic.onEnded = () => {
      this.micEnabled = false;
      this.onNotice('error', 'Mikrofon', 'Das Mikrofon wurde getrennt.');
      this.#updateMode();
    };
  }

  // ---------- Mikrofon ----------
  async enableMic() {
    try {
      await this.mic.start(localStorage.getItem('jarvis.micDevice') || undefined);
    } catch (e) {
      const msg =
        e.name === 'NotAllowedError'
          ? 'Zugriff verweigert. Bitte erlaube das Mikrofon in den Browser-Einstellungen (Schloss-Symbol in der Adressleiste).'
          : e.name === 'NotFoundError'
            ? 'Kein Mikrofon gefunden.'
            : `Mikrofon konnte nicht gestartet werden: ${e.message}`;
      this.onNotice('error', 'Mikrofon', msg);
      this.net.send({ type: 'mic', enabled: false, error: msg });
      this.onMode('error', msg);
      return false;
    }
    this.micEnabled = true;
    this.net.send({ type: 'mic', enabled: true });
    if (this.stt === 'browser') this.#setupBrowserStt();
    await this.#applyWake();
    this.#updateMode();
    return true;
  }

  disableMic() {
    this.micEnabled = false;
    this.mic.stop();
    this.wake?.stop().catch(() => {});
    this.browserStt?.stop();
    this.net.send({ type: 'mic', enabled: false });
    this.#updateMode();
  }

  async setWakeEnabled(on) {
    this.wakeEnabled = on;
    await this.#applyWake();
    this.#updateMode();
  }

  async #applyWake() {
    const want = this.micEnabled && this.wakeEnabled && this.wakeEngine === 'porcupine';
    if (want) {
      try {
        if (!this.wake) {
          const { WakeWord } = await import('./wakeword.js');
          this.wake = new WakeWord({
            accessKey: this.cfg.wake.picovoiceKey,
            sensitivity: this.cfg.wake.sensitivity,
            onDetect: () => this.trigger('wakeword'),
            onError: (e) => this.onNotice('error', 'Wake-Word', e?.message || String(e)),
          });
        }
        await this.wake.start();
      } catch (e) {
        // Fallback: Wake-Word über das Transkript
        this.wakeEngine = 'transcript';
        this.wake = null;
        this.onNotice(
          'error',
          'Lokales Wake-Word nicht verfügbar',
          `${e?.message || e}. Prüfe PICOVOICE_ACCESS_KEY und führe "npm run setup:wakeword" aus. Nutze jetzt die Erkennung über das Transkript.`,
        );
      }
    } else {
      await this.wake?.stop().catch(() => {});
    }
    this.#syncBrowserStt();
  }

  // ---------- Steuerung ----------
  /** Wake-Word erkannt oder manuell (Klick/Leertaste). */
  trigger(source = 'manual') {
    this.localListenUntil = performance.now() + 4000;
    if (this.convState === 'speaking') this.audioOut.stop();
    this.#flushPreroll(source === 'wakeword' ? 250 : 120);
    this.net.send({ type: 'wake', source });
    this.#syncBrowserStt(true);
    this.#updateMode();
  }

  setConvState(s) {
    this.convState = s;
    this.localListenUntil = 0;
    this.mic.vadBoost = s === 'speaking' ? 1.8 : 1;
    this.#syncBrowserStt();
    this.#updateMode();
  }

  #wantsAudio() {
    if (!this.micEnabled) return false;
    if (this.convState !== 'idle' && this.convState !== 'error') return true;
    if (performance.now() < this.localListenUntil) return true;
    // Ohne lokales Wake-Word: nur bei erkannter Sprache (mit Nachlauf) übertragen
    if (this.wakeEnabled && this.wakeEngine === 'transcript') return this.mic.speaking || performance.now() < this.hangoverUntil;
    return false;
  }

  #frame(pcm) {
    if (this.stt !== 'deepgram') return;
    const want = this.#wantsAudio();
    if (want) this.net.sendBinary(pcm);
    if (want !== this.streaming) {
      this.streaming = want;
      this.#updateMode();
    }
  }

  #flushPreroll(ms) {
    if (this.stt !== 'deepgram' || this.streaming) return;
    for (const f of this.mic.preroll(ms)) this.net.sendBinary(f.slice(0));
  }

  #vad(speaking) {
    this.net.send({ type: 'vad', speaking });
    if (speaking) {
      if (this.wakeEnabled && this.wakeEngine === 'transcript' && this.convState === 'idle' && !this.streaming) this.#flushPreroll(500);
      // Während Jarvis spricht: Ausgabe absenken, damit die Unterbrechung gut erkannt wird
      if (this.convState === 'speaking') {
        this.audioOut.duck(true);
        clearTimeout(this.duckTimer);
        this.duckTimer = setTimeout(() => this.audioOut.duck(false), 1500);
      }
    } else {
      this.hangoverUntil = performance.now() + 1500;
      clearTimeout(this.duckTimer);
      this.duckTimer = setTimeout(() => this.audioOut.duck(false), 400);
    }
  }

  // ---------- Browser-Spracherkennung ----------
  #setupBrowserStt() {
    if (this.browserStt) return;
    this.browserStt = new BrowserSTT({
      onResult: ({ text, final }) => this.net.send({ type: 'stt', text, final, speechFinal: final }),
      onEnd: () => this.#updateMode(),
      onError: (err) => {
        const msg = err === 'network' ? 'Netzwerkfehler der Browser-Spracherkennung.' : `Browser-Spracherkennung: ${err}`;
        this.onNotice('error', 'Spracherkennung', msg);
      },
    });
    if (!this.browserStt.supported) {
      this.onNotice('error', 'Spracherkennung', 'Dieser Browser unterstützt keine Spracherkennung. Bitte Chrome/Edge verwenden oder DEEPGRAM_API_KEY setzen.');
    }
  }

  #syncBrowserStt(force = false) {
    if (this.stt !== 'browser' || !this.browserStt?.supported) return;
    const active = this.convState !== 'idle' && this.convState !== 'error';
    const want = this.micEnabled && (force || active || (this.wakeEnabled && this.wakeEngine === 'transcript'));
    if (want) this.browserStt.start();
    else this.browserStt.stop();
    this.#updateMode();
  }

  #updateMode() {
    if (!this.micEnabled) return this.onMode('off');
    const cloud = this.stt === 'browser' ? this.browserStt?.want : this.streaming;
    this.onMode(cloud ? 'stream' : 'local');
  }

  /** Visualisierungsdaten des Mikrofons */
  sample() {
    return this.mic.sample();
  }
}
