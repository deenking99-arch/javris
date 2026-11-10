// Zentrale Konfiguration. Secrets kommen ausschließlich aus .env (nie ins Frontend, nie ins Git).
import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.resolve(process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const env = (k, d = undefined) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const list = (k, d = []) => (env(k) ? env(k).split(/[;,]/).map((s) => s.trim()).filter(Boolean) : d);
const num = (k, d) => (env(k) !== undefined && !Number.isNaN(Number(env(k))) ? Number(env(k)) : d);
const bool = (k, d) => (env(k) === undefined ? d : /^(1|true|yes|ja|on)$/i.test(env(k)));

const home = os.homedir();

export const config = {
  host: env('JARVIS_HOST', '127.0.0.1'),
  port: num('JARVIS_PORT', 7777),
  userName: env('JARVIS_USER_NAME', ''),
  timezone: env('JARVIS_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone),
  locale: 'de-DE',

  claude: {
    model: env('JARVIS_MODEL', 'claude-opus-5-5'),
    // Gesprächs-Turns: niedriger Aufwand = schnellere Antwort. Hintergrundaufgaben: gründlich.
    effortVoice: env('JARVIS_EFFORT_VOICE', 'low'),
    effortTask: env('JARVIS_EFFORT_TASK', 'high'),
    serverFallback: bool('JARVIS_SERVER_FALLBACK', true),
    configured: Boolean(env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN')),
  },

  stt: {
    // 'deepgram' (Server-Streaming, empfohlen) oder 'browser' (Web Speech API, Chrome/Edge)
    provider: env('JARVIS_STT', env('DEEPGRAM_API_KEY') ? 'deepgram' : 'browser'),
    deepgramKey: env('DEEPGRAM_API_KEY'),
    deepgramModel: env('DEEPGRAM_MODEL', 'nova-3'),
    language: env('JARVIS_STT_LANGUAGE', 'de'),
    endpointingMs: num('JARVIS_ENDPOINTING_MS', 450),
    utteranceEndMs: num('JARVIS_UTTERANCE_END_MS', 1100),
  },

  tts: {
    // 'elevenlabs' | 'openai' | 'browser'
    provider: env('JARVIS_TTS', env('ELEVENLABS_API_KEY') ? 'elevenlabs' : env('OPENAI_API_KEY') ? 'openai' : 'browser'),
    elevenKey: env('ELEVENLABS_API_KEY'),
    elevenVoiceId: env('ELEVENLABS_VOICE_ID', 'onwK4e9ZLuTAKqWW03F9'), // "Daniel" – ruhig, männlich, multilingual
    elevenModel: env('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
    openaiKey: env('OPENAI_API_KEY'),
    openaiVoice: env('OPENAI_TTS_VOICE', 'onyx'),
    openaiModel: env('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
    speed: num('JARVIS_VOICE_SPEED', 1.0),
    browserVoice: env('JARVIS_BROWSER_VOICE', ''),
  },

  wake: {
    picovoiceKey: env('PICOVOICE_ACCESS_KEY'),
    sensitivity: num('JARVIS_WAKE_SENSITIVITY', 0.6),
    followUpWindowMs: num('JARVIS_FOLLOWUP_MS', 8000),
  },

  files: {
    roots: list('JARVIS_FILE_ROOTS', [home]).map((p) => path.resolve(p.replace(/^~(?=$|[\\/])/, home))),
    outputDir: path.resolve((env('JARVIS_OUTPUT_DIR', path.join(home, 'Jarvis'))).replace(/^~(?=$|[\\/])/, home)),
  },

  browser: {
    headless: bool('JARVIS_BROWSER_HEADLESS', false),
    channel: env('JARVIS_BROWSER_CHANNEL', ''), // z.B. 'chrome' oder 'msedge' für installierten Browser
    executablePath: env('JARVIS_BROWSER_EXECUTABLE', ''),
  },

  calendar: {
    icsUrls: list('JARVIS_CALENDAR_ICS'),
  },

  allowShell: bool('JARVIS_ALLOW_SHELL', true),
};

fs.mkdirSync(config.files.outputDir, { recursive: true });

/** Öffentliche (nicht geheime) Konfiguration für das Frontend. */
export function publicConfig() {
  return {
    userName: config.userName,
    locale: config.locale,
    model: config.claude.model,
    claudeConfigured: config.claude.configured,
    stt: { provider: config.stt.provider, deepgramConfigured: Boolean(config.stt.deepgramKey) },
    tts: {
      provider: config.tts.provider,
      speed: config.tts.speed,
      elevenConfigured: Boolean(config.tts.elevenKey),
      openaiConfigured: Boolean(config.tts.openaiKey),
      browserVoice: config.tts.browserVoice,
    },
    wake: {
      // Der Picovoice-AccessKey ist laut Picovoice für den Client-Einsatz bestimmt;
      // er wird nur an das lokal ausgelieferte Frontend gegeben.
      engine: config.wake.picovoiceKey ? 'porcupine' : 'transcript',
      picovoiceKey: config.wake.picovoiceKey || null,
      sensitivity: config.wake.sensitivity,
      followUpWindowMs: config.wake.followUpWindowMs,
    },
  };
}
