// AudioWorklet: wandelt Mikrofonaudio in 16-kHz-PCM16 (20-ms-Frames) und misst den Pegel.
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.frame = new Int16Array(320);
    this.fi = 0;
    this.sumSq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Einfaches Downsampling mit Mittelwertbildung (Anti-Aliasing light)
    for (let i = 0; i < ch.length; i++) {
      this.pos += 1;
      this.acc = (this.acc || 0) + ch[i];
      this.cnt = (this.cnt || 0) + 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.acc = 0;
        this.cnt = 0;
        this.sumSq += s * s;
        this.frame[this.fi++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.fi === this.frame.length) {
          const rms = Math.sqrt(this.sumSq / this.frame.length);
          this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
          this.frame = new Int16Array(320);
          this.fi = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
