// Mikrofon: Aufnahme mit Echo-Unterdrückung, 16-kHz-PCM, Pegel, Spektrum, lokale Sprachaktivitätserkennung (VAD)
// und ein Ringpuffer, damit beim Aktivieren keine Silbe verloren geht.

export class Mic {
  constructor(ctx) {
    this.ctx = ctx;
    this.stream = null;
    this.node = null;
    this.analyser = null;
    this.level = 0;
    this.bins = new Float32Array(96);
    this.speaking = false;
    this.noise = 0.004;
    this.above = 0;
    this.below = 0;
    this.ring = []; // letzte ~1,2 s PCM-Frames
    this.onFrame = null; // (ArrayBuffer) => void
    this.onVad = null; // (speaking:boolean) => void
    this.vadBoost = 1; // während Jarvis spricht höhere Schwelle (Echo)
  }

  get active() {
    return Boolean(this.stream);
  }

  async start(deviceId) {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, deviceId: deviceId ? { exact: deviceId } : undefined },
    });
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-processor');
    src.connect(this.analyser);
    src.connect(this.node);
    // Worklet muss am Graph hängen, um zu laufen – stumm verbinden
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this.#frame(e.data);
    this.stream.getAudioTracks()[0].addEventListener('ended', () => {
      this.stop();
      this.onEnded?.();
    });
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.stream = null;
    this.node = null;
    this.level = 0;
    this.ring = [];
    if (this.speaking) {
      this.speaking = false;
      this.onVad?.(false);
    }
  }

  #frame({ pcm, rms }) {
    this.ring.push(pcm);
    if (this.ring.length > 60) this.ring.shift(); // 60 × 20 ms = 1,2 s
    // Adaptive Rauschschwelle
    if (!this.speaking) this.noise = this.noise * 0.995 + Math.min(rms, 0.05) * 0.005;
    const threshold = Math.max(0.012, this.noise * 3.2) * this.vadBoost;
    if (rms > threshold) {
      this.above++;
      this.below = 0;
      if (!this.speaking && this.above >= 4) {
        this.speaking = true;
        this.onVad?.(true);
      }
    } else {
      this.below++;
      this.above = 0;
      if (this.speaking && this.below >= 35) {
        this.speaking = false;
        this.onVad?.(false);
      }
    }
    this.onFrame?.(pcm);
  }

  /** Gepufferte Frames der letzten `ms` Millisekunden. */
  preroll(ms = 600) {
    const n = Math.ceil(ms / 20);
    return this.ring.slice(-n);
  }

  /** Für die Visualisierung (pro Animationsframe aufrufen). */
  sample() {
    if (!this.analyser) return { level: 0, bins: this.bins };
    this.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    const n = this.bins.length;
    for (let i = 0; i < n; i++) {
      const v = this.freq[Math.floor(2 + i * 1.6)] / 255;
      this.bins[i] = v * v;
      sum += v;
    }
    this.level = Math.min(1, (sum / n) * 2.2);
    return { level: this.level, bins: this.bins };
  }
}
