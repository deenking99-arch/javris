// Streaming-Spracherkennung über Deepgram (WebSocket). Audio: PCM16 mono 16 kHz vom Browser.
// Die Verbindung wird nur geöffnet, solange tatsächlich Audio gesendet wird (Datenschutz + Kosten).
import WebSocket from 'ws';
import { config } from '../config.js';

export class DeepgramStream {
  /**
   * @param {{onTranscript:(t:{text:string,isFinal:boolean,speechFinal:boolean})=>void, onUtteranceEnd:()=>void, onSpeechStarted:()=>void, onError:(e:Error)=>void, onStatus:(s:string)=>void}} h
   */
  constructor(h) {
    this.h = h;
    this.ws = null;
    this.queue = [];
    this.idleTimer = null;
    this.keepAlive = null;
    this.model = config.stt.deepgramModel;
  }

  #open() {
    const q = new URLSearchParams({
      model: this.model,
      language: config.stt.language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(config.stt.endpointingMs),
      utterance_end_ms: String(config.stt.utteranceEndMs),
      vad_events: 'true',
    });
    // Keyterm-Prompting (nova-3) verbessert die Erkennung des Wake-Words
    if (this.model.startsWith('nova-3')) q.append('keyterm', 'Jarvis');
    else q.append('keywords', 'Jarvis:3');
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${q}`, { headers: { Authorization: `Token ${config.stt.deepgramKey}` } });
    this.ws = ws;
    this.h.onStatus('connecting');
    ws.on('open', () => {
      this.h.onStatus('connected');
      for (const b of this.queue) ws.send(b);
      this.queue = [];
      this.keepAlive = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'KeepAlive' })), 7000);
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        // Fallback, falls das Modell die Sprache nicht unterstützt
        if (res.statusCode === 400 && this.model !== 'nova-2') {
          console.warn(`[stt] ${this.model} abgelehnt (${body.slice(0, 120)}), wechsle zu nova-2`);
          this.model = 'nova-2';
          this.ws = null;
          return;
        }
        this.h.onError(new Error(`Deepgram ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript || '';
        if (text || msg.speech_final) this.h.onTranscript({ text, isFinal: !!msg.is_final, speechFinal: !!msg.speech_final });
      } else if (msg.type === 'UtteranceEnd') this.h.onUtteranceEnd();
      else if (msg.type === 'SpeechStarted') this.h.onSpeechStarted();
    });
    ws.on('error', (e) => this.h.onError(e));
    ws.on('close', () => {
      clearInterval(this.keepAlive);
      if (this.ws === ws) this.ws = null;
      this.h.onStatus('closed');
    });
  }

  /** @param {Buffer} pcm */
  send(pcm) {
    if (!config.stt.deepgramKey) return;
    if (!this.ws) this.#open();
    if (this.ws.readyState === 1) this.ws.send(pcm);
    else if (this.queue.length < 200) this.queue.push(pcm);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), 12_000);
  }

  close() {
    clearTimeout(this.idleTimer);
    clearInterval(this.keepAlive);
    const ws = this.ws;
    this.ws = null;
    this.queue = [];
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => ws.close(), 500);
    } else ws?.terminate?.();
  }
}
