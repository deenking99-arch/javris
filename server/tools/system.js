// Systemsteuerung: Status, Programme/URLs öffnen, Shell-Befehle (mit Bestätigung).
import { spawn, exec } from 'node:child_process';
import os from 'node:os';
import { config } from '../config.js';
import { requestConfirmation } from '../core/confirm.js';
import { metricsSnapshot } from '../system/metrics.js';
import { registerTool } from './registry.js';

registerTool({
  name: 'system_status',
  label: 'Systemstatus',
  group: 'system',
  description: 'Liefert aktuelle, echte Systemwerte: CPU, RAM, Netzwerk, Internetverbindung, Top-Prozesse, Akku.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    return metricsSnapshot() || 'Messwerte werden noch erfasst.';
  },
});

function openCommand(target) {
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '""', target]];
  if (process.platform === 'darwin') return ['open', [target]];
  return ['xdg-open', [target]];
}

registerTool({
  name: 'open_target',
  label: 'Öffnen',
  group: 'system',
  description:
    'Öffnet eine URL im Standardbrowser des Nutzers, eine Datei mit dem Standardprogramm oder (macOS: App-Name, z.B. "Spotify") eine Anwendung auf dem Computer.',
  input_schema: {
    type: 'object',
    properties: { target: { type: 'string', description: 'URL, Dateipfad oder (macOS) App-Name' } },
    required: ['target'],
  },
  async run({ target }) {
    let [cmd, args] = openCommand(target);
    if (process.platform === 'darwin' && !/^[a-z]+:\/\//i.test(target) && !target.startsWith('/')) args = ['-a', target];
    await new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      p.on('error', reject);
      p.on('spawn', resolve);
      p.unref();
    });
    return `Geöffnet: ${target}`;
  },
});

registerTool({
  name: 'run_shell',
  label: 'Shell-Befehl',
  group: 'system',
  description: `Führt einen Shell-Befehl auf dem Computer des Nutzers aus (${os.type()}). Nur wenn wirklich nötig. Der Nutzer muss jeden Befehl bestätigen.`,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      reason: { type: 'string', description: 'Kurze Begründung für den Nutzer' },
    },
    required: ['command', 'reason'],
  },
  async run({ command, cwd, reason }, ctx) {
    if (!config.allowShell) return 'Shell-Befehle sind deaktiviert (JARVIS_ALLOW_SHELL=false).';
    const ok = await requestConfirmation({
      title: `Befehl ausführen: ${reason}`,
      detail: command,
      speak: `Ich möchte einen Befehl ausführen: ${reason}. Darf ich?`,
      signal: ctx.signal,
    });
    if (!ok) return 'Vom Nutzer abgelehnt.';
    return await new Promise((resolve) => {
      const child = exec(command, { cwd: cwd || os.homedir(), timeout: 120_000, maxBuffer: 2_000_000 }, (err, stdout, stderr) => {
        resolve(JSON.stringify({ exit: err?.code ?? 0, stdout: stdout.slice(-20_000), stderr: stderr.slice(-5000) }));
      });
      ctx.signal?.addEventListener('abort', () => child.kill(), { once: true });
    });
  },
});

registerTool({
  name: 'get_time',
  label: 'Uhrzeit',
  group: 'system',
  description: 'Aktuelles Datum und Uhrzeit in der Zeitzone des Nutzers.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    return new Date().toLocaleString('de-DE', { timeZone: config.timezone, dateStyle: 'full', timeStyle: 'short' });
  },
});
