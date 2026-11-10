// Lädt das Porcupine-Sprachmodell (Apache-2.0) für das lokale Wake-Word "Jarvis" herunter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'client', 'public', 'porcupine', 'porcupine_params.pv');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@picovoice', 'porcupine-web', 'package.json'), 'utf8'));
const major = pkg.version.split('.')[0];
const urls = [
  `https://raw.githubusercontent.com/Picovoice/porcupine/v${major}.0/lib/common/porcupine_params.pv`,
  'https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params.pv',
];

fs.mkdirSync(path.dirname(target), { recursive: true });
for (const url of urls) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, buf);
    console.log(`✓ Porcupine-Modell gespeichert (${(buf.length / 1024).toFixed(0)} KB) → ${path.relative(root, target)}`);
    process.exit(0);
  } catch (e) {
    console.warn(`  ${url}: ${e.message}`);
  }
}
console.error('✗ Modell konnte nicht geladen werden.');
process.exit(1);
