// Spracherkennung über die Web Speech API (Chrome/Edge). Fallback, wenn kein Deepgram-Schlüssel gesetzt ist.
// Hinweis: Chrome überträgt das Audio dabei an Google-Server.

export class BrowserSTT {
  constructor({ onResult, onEnd, onError }) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = Boolean(SR);
    this.want = false;
    this.running = false;
    this.onResult = onResult;
    this.onEnd = onEnd;
    this.onError = onError;
    if (!SR) return;
    const r = new SR();
    r.lang = 'de-DE';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        this.onResult({ text: res[0].transcript, final: res.isFinal });
      }
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.onError?.(e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.want = false;
    };
    r.onend = () => {
      this.running = false;
      this.onEnd?.();
      if (this.want) setTimeout(() => this.#begin(), 150); // Chrome beendet die Erkennung regelmäßig
    };
    this.r = r;
  }

  #begin() {
    if (!this.want || this.running || !this.r) return;
    try {
      this.r.start();
      this.running = true;
    } catch {
      /* läuft bereits */
    }
  }

  start() {
    this.want = true;
    this.#begin();
  }

  stop() {
    this.want = false;
    if (this.running) this.r.stop();
  }
}
