// Echte Systemtelemetrie (CPU, RAM, Netzwerk, Prozesse, Konnektivität) – keine simulierten Werte.
import si from 'systeminformation';
import os from 'node:os';
import https from 'node:https';
import { bus } from '../core/bus.js';

let latest = null;
let net = { online: null, latencyMs: null, checkedAt: null, target: 'api.anthropic.com' };

function probe() {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = https.request({ host: net.target, method: 'HEAD', path: '/', timeout: 5000 }, (res) => {
      res.resume();
      resolve({ online: true, latencyMs: Date.now() - started });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ online: false, latencyMs: null }));
    req.end();
  });
}

async function checkNet() {
  const r = await probe();
  net = { ...net, ...r, checkedAt: Date.now() };
}

async function sample() {
  const [load, mem, nets, procs, battery] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.networkStats().catch(() => []),
    si.processes().catch(() => null),
    si.battery().catch(() => null),
  ]);
  const rx = nets.reduce((a, n) => a + (n.rx_sec || 0), 0);
  const tx = nets.reduce((a, n) => a + (n.tx_sec || 0), 0);
  latest = {
    cpu: { load: Math.round(load.currentLoad), cores: load.cpus.map((c) => Math.round(c.load)) },
    mem: { usedPct: Math.round(((mem.total - mem.available) / mem.total) * 100), used: mem.total - mem.available, total: mem.total },
    netio: { rxPerSec: Math.max(0, Math.round(rx)), txPerSec: Math.max(0, Math.round(tx)) },
    net,
    processes: procs
      ? {
          total: procs.all,
          top: procs.list
            .filter((p) => p.cpu > 0 || p.mem > 0)
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 6)
            .map((p) => ({ name: p.name, cpu: Math.round(p.cpu * 10) / 10, mem: Math.round(p.mem * 10) / 10, pid: p.pid })),
        }
      : null,
    battery: battery?.hasBattery ? { percent: battery.percent, charging: battery.isCharging } : null,
    host: { name: os.hostname(), platform: `${os.type()} ${os.release()}`, uptime: os.uptime() },
  };
  bus.broadcast('metrics', latest);
}

export function startMetrics() {
  checkNet();
  setInterval(checkNet, 15_000).unref();
  const loop = async () => {
    try {
      await sample();
    } catch (e) {
      console.warn('[metrics]', e.message);
    }
    setTimeout(loop, 2000).unref();
  };
  loop();
}

export function metricsSnapshot() {
  return latest;
}
