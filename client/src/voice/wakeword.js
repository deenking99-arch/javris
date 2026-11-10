// Lokale Wake-Word-Erkennung "Jarvis" mit Picovoice Porcupine (läuft komplett im Browser, offline).
import { PorcupineWorker, BuiltInKeyword } from '@picovoice/porcupine-web';
import { WebVoiceProcessor } from '@picovoice/web-voice-processor';

export class WakeWord {
  constructor({ accessKey, sensitivity = 0.6, onDetect, onError }) {
    this.accessKey = accessKey;
    this.sensitivity = sensitivity;
    this.onDetect = onDetect;
    this.onError = onError;
    this.worker = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    if (!this.worker) {
      this.worker = await PorcupineWorker.create(
        this.accessKey,
        [{ builtin: BuiltInKeyword.Jarvis, sensitivity: this.sensitivity }],
        () => this.onDetect(),
        { publicPath: '/porcupine/porcupine_params.pv', forceWrite: false, version: 4 },
        { processErrorCallback: (e) => this.onError?.(e) },
      );
    }
    await WebVoiceProcessor.subscribe(this.worker);
    this.running = true;
  }

  async stop() {
    if (!this.running) return;
    await WebVoiceProcessor.unsubscribe(this.worker);
    this.running = false;
  }

  async release() {
    await this.stop();
    await this.worker?.release();
    this.worker?.terminate();
    this.worker = null;
  }
}
