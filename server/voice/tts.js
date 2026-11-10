// Text-to-Speech-Provider. Schlüssel bleiben auf dem Server; der Browser erhält nur Audio.
import { config } from '../config.js';

export class TTSError extends Error {}

async function elevenlabs(text, { signal, speed }) {
  const t = config.tts;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(t.elevenVoiceId)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=2`;
  const body = {
    text,
    model_id: t.elevenModel,
    voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true, speed: Math.min(1.2, Math.max(0.7, speed)) },
  };
  if (/flash|turbo/.test(t.elevenModel)) body.language_code = 'de';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': t.elevenKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new TTSError(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function openai(text, { signal, speed }) {
  const t = config.tts;
  const body = { model: t.openaiModel, voice: t.openaiVoice, input: text, response_format: 'mp3', speed };
  if (t.openaiModel.includes('gpt-4o')) {
    body.instructions =
      'Sprich Deutsch mit ruhiger, tiefer, souveräner männlicher Stimme – wie ein hochintelligenter, höflicher KI-Butler. Klar artikuliert, gelassen, mit dezenter Wärme.';
  }
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${t.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new TTSError(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Laufzeit-Einstellungen (über die UI änderbar, nicht geheim). */
export const ttsSettings = { provider: config.tts.provider, speed: config.tts.speed };

export function setTtsSettings({ provider, speed }) {
  if (provider) {
    if (provider === 'elevenlabs' && !config.tts.elevenKey) throw new TTSError('ELEVENLABS_API_KEY fehlt in der .env');
    if (provider === 'openai' && !config.tts.openaiKey) throw new TTSError('OPENAI_API_KEY fehlt in der .env');
    if (!['elevenlabs', 'openai', 'browser'].includes(provider)) throw new TTSError('Unbekannter Provider');
    ttsSettings.provider = provider;
  }
  if (speed) ttsSettings.speed = Math.min(1.5, Math.max(0.6, Number(speed)));
}

/**
 * Synthetisiert einen Satz. Gibt null zurück, wenn der Browser selbst spricht.
 * @returns {Promise<Buffer|null>}
 */
export async function synthesize(text, { signal } = {}) {
  const opts = { signal, speed: ttsSettings.speed };
  if (ttsSettings.provider === 'elevenlabs') return elevenlabs(text, opts);
  if (ttsSettings.provider === 'openai') return openai(text, opts);
  return null;
}
