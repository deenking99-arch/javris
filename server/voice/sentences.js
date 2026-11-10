// Zerlegt gestreamten LLM-Text in sprechbare Sätze, damit die Sprachausgabe sofort beginnen kann.

const ABBREV = /(?:^|\s)(z\.\s?B|u\.\s?a|d\.\s?h|bzw|ca|usw|etc|evtl|ggf|inkl|bspw|Nr|Dr|Prof|Hr|Fr|St|vs|Mio|Mrd|Tsd|Jh|Mr|Mrs|Std|Min|Sek|ff|vgl|sog|z\.\s?T)\.$/i;

/** Bereinigt Text für die Sprachsynthese (Markdown, URLs, Emojis). */
export function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+\.\s+(?=\D)/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/[|>#*_~]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SentenceChunker {
  /** @param {(sentence:string)=>void} onSentence */
  constructor(onSentence) {
    this.buf = '';
    this.onSentence = onSentence;
    this.count = 0;
  }

  push(delta) {
    this.buf += delta;
    let idx;
    while ((idx = this.#boundary()) >= 0) {
      const s = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx);
      this.#emit(s);
    }
  }

  #boundary() {
    const b = this.buf;
    // Absatz/Zeilenumbruch
    const nl = b.indexOf('\n');
    if (nl >= 0 && b.slice(0, nl).trim().length > 0) return nl + 1;
    const re = /[.!?…:;]+["»“”')\]]*\s+/g;
    let m;
    while ((m = re.exec(b))) {
      const end = m.index + m[0].length;
      const head = b.slice(0, m.index + 1);
      if (ABBREV.test(head)) continue; // Abkürzung
      if (/\d\.$/.test(head) && /^\s*\d/.test(b.slice(end - 1))) continue; // "1. 2." / Datumsangaben
      if (/(^|\s)\d{1,2}\.$/.test(head)) continue; // "am 3. Mai"
      // Erster Satz darf kurz sein (schneller Start), danach mindestens ~25 Zeichen bündeln
      if (head.trim().length < (this.count === 0 ? 2 : 25) && m[0].trim() !== ':') continue;
      return end;
    }
    // Sehr lange Passage ohne Satzende → am letzten Komma trennen
    if (b.length > 240) {
      const c = b.lastIndexOf(', ', 220);
      if (c > 60) return c + 2;
    }
    return -1;
  }

  #emit(raw) {
    const s = speakable(raw);
    if (s && /[\p{L}\p{N}]/u.test(s)) {
      this.count++;
      this.onSentence(s);
    }
  }

  flush() {
    const rest = this.buf;
    this.buf = '';
    this.#emit(rest);
  }
}
