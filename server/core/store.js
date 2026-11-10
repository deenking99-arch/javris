// Kleiner, atomarer JSON-Speicher für persistente Daten (Memory, Aufgaben, Automationen, Verlauf).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export class JsonStore {
  constructor(name, fallback) {
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.fallback = fallback;
    this.data = this.#load();
    this.timer = null;
  }
  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return structuredClone(this.fallback);
    }
  }
  /** Schreibt verzögert (gebündelt) und atomar. */
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }
  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
