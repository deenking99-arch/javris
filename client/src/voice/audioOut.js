// Sprachausgabe: spielt gestreamte Sätze lückenlos in Reihenfolge ab, liefert echte Pegel/Spektren
// für die Visualisierung und meldet Start/Ende an den Server. Fallback: Browser-Stimme (speechSynthesis).

const b64ToBuf = (b64) => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
};

export class AudioOut {
  constructor(ctx, { onPlayback, onState, onSentence }) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.55;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.gain.connect(this.analyser).connect(ctx.destination);
    this.queue = [];
    this.current = null;
    this.playing = false;
    this.muted = false;
    this.volume = 1;
    this.stoppedTurns = new Set();
    this.onPlayback = onPlayback;
    this.onState = onState;
    this.onSentence = onSentence;
    this.bins = new Float32Array(96);
    this.synthLevel = 0;
    this.browserVoice = null;
    this.rate = 1;
  }

  setVolume(v) {
    this.volume = v;
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
  duck(on) {
    this.gain.gain.setTargetAtTime(on ? this.volume * 0.35 : this.volume, this.ctx.currentTime, 0.06);
  }

  /** @param {{turnId:string, seq:number, text:string, audio:string|null}} msg */
  enqueue(msg) {
    if (this.stoppedTurns.has(msg.turnId)) return this.onPlayback({ turnId: msg.turnId, seq: msg.seq, status: 'end' });
    const item = { ...msg, decoded: null };
    if (msg.audio && !this.muted) {
      item.decoded = this.ctx.decodeAudioData(b64ToBuf(msg.audio)).catch(() => null);
    }
    this.queue.push(item);
    this.#setPlaying(true);
    if (!this.current) this.#next();
  }

  #setPlaying(p) {
    if (p !== this.playing) {
      this.playing = p;
      this.onState(p);
    }
  }

  async #next() {
    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      this.#setPlaying(false);
      return;
    }
    this.current = item;
    this.onPlayback({ turnId: item.turnId, seq: item.seq, status: 'start' });
    this.onSentence(item.text, item.turnId);
    const done = () => {
      if (this.current !== item) return;
      this.onPlayback({ turnId: item.turnId, seq: item.seq, status: 'end' });
      this.current = null;
      this.#next();
    };
    item.done = done;
    if (this.muted) return setTimeout(done, 0);
    const buffer = item.decoded ? await item.decoded : null;
    if (this.current !== item) return; // inzwischen gestoppt
    if (buffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.onended = done;
      item.src = src;
      src.start();
    } else {
      this.#speakBrowser(item, done);
    }
  }

  #speakBrowser(item, done) {
    if (!('speechSynthesis' in window)) return done();
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = 'de-DE';
    if (this.browserVoice) u.voice = this.browserVoice;
    u.rate = this.rate;
    u.volume = this.volume;
    u.onboundary = () => {
      this.synthLevel = 0.85; // echtes Wortgrenzen-Ereignis der Sprachsynthese
    };
    u.onend = done;
    u.onerror = done;
    item.utterance = u;
    speechSynthesis.speak(u);
  }

  /** Stoppt sofort (Unterbrechung). */
  stop(turnId) {
    if (turnId) this.stoppedTurns.add(turnId);
    const cur = this.current;
    const all = [cur, ...this.queue].filter(Boolean);
    this.queue = [];
    this.current = null;
    if (cur?.src) {
      cur.src.onended = null;
      try {
        cur.src.stop();
      } catch {}
    }
    if (cur?.utterance) speechSynthesis.cancel();
    for (const it of all) {
      this.stoppedTurns.add(it.turnId);
      this.onPlayback({ turnId: it.turnId, seq: it.seq, status: 'end' });
    }
    this.#setPlaying(false);
    if (this.stoppedTurns.size > 50) this.stoppedTurns = new Set([...this.stoppedTurns].slice(-20));
  }

  sample() {
    if (this.current?.utterance) {
      // Browser-Stimme liefert kein Audiosignal – Pegel aus echten Wortgrenzen-Ereignissen ableiten
      this.synthLevel *= 0.9;
      this.bins.fill(0);
      for (let i = 0; i < this.bins.length; i++) this.bins[i] = this.synthLevel * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.37 + performance.now() / 120))) * (1 - i / this.bins.length);
      return { level: this.synthLevel * 0.7, bins: this.bins };
    }
    this.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    for (let i = 0; i < this.bins.length; i++) {
      const v = this.freq[Math.floor(1 + i * 1.4)] / 255;
      this.bins[i] = v * v;
      sum += v;
    }
    return { level: Math.min(1, (sum / this.bins.length) * 2.4), bins: this.bins };
  }
}

/** Wählt eine passende deutsche, möglichst männliche Browser-Stimme. */
export function pickGermanVoice(preferredName) {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('de'));
  if (preferredName) {
    const v = voices.find((x) => x.name === preferredName);
    if (v) return v;
  }
  const male = /(conrad|killian|florian|stefan|markus|hans|yannick|christoph|male|männlich)/i;
  return voices.find((v) => male.test(v.name) && /natural|online|neural/i.test(v.name)) || voices.find((v) => male.test(v.name)) || voices.find((v) => /google/i.test(v.name)) || voices[0] || null;
}
