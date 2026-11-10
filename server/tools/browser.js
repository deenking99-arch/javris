// Browsersteuerung über Playwright. Standardmäßig sichtbar, damit der Nutzer zusehen kann.
import path from 'node:path';
import { config, DATA_DIR } from '../config.js';
import { bus } from '../core/bus.js';
import { registerTool } from './registry.js';

let context = null;
let page = null;
let launching = null;

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  if (!launching) {
    launching = (async () => {
      const { chromium } = await import('playwright');
      const opts = { headless: config.browser.headless, viewport: { width: 1280, height: 860 } };
      if (config.browser.channel) opts.channel = config.browser.channel;
      if (config.browser.executablePath) opts.executablePath = config.browser.executablePath;
      // Eigenes Profil: Logins bleiben erhalten, aber getrennt vom privaten Browser.
      try {
        context = await chromium.launchPersistentContext(path.join(DATA_DIR, 'browser-profile'), opts);
      } catch (e) {
        if (/Executable doesn't exist|browserType\.launch/i.test(e.message)) {
          throw new Error('Kein steuerbarer Browser gefunden. Lösung: "npm run setup:browser" ausführen oder in der .env JARVIS_BROWSER_CHANNEL=chrome (bzw. msedge) setzen.');
        }
        throw e;
      }
      context.on('close', () => {
        context = null;
        page = null;
        bus.broadcast('browser', { open: false });
      });
      page = context.pages()[0] || (await context.newPage());
      bus.broadcast('browser', { open: true });
      return page;
    })().finally(() => {
      launching = null;
    });
  }
  return launching;
}

async function pageSummary(p) {
  const title = await p.title();
  const text = await p.evaluate(() => {
    const clone = document.body?.cloneNode(true);
    if (!clone) return '';
    clone.querySelectorAll('script,style,noscript,svg').forEach((n) => n.remove());
    return clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  });
  const links = await p.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .slice(0, 60)
      .map((a) => `${a.innerText.trim().slice(0, 60)} → ${a.href}`)
      .filter((l) => !l.startsWith(' →')),
  );
  bus.broadcast('browser', { open: true, url: p.url(), title });
  return { url: p.url(), title, text: text.slice(0, 15_000), links: links.slice(0, 40) };
}

registerTool({
  name: 'browser_open',
  label: 'Browser: öffnen',
  group: 'browser',
  description: 'Öffnet eine URL im von Jarvis gesteuerten Browser und liefert Titel, sichtbaren Text und Links der Seite.',
  input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async run({ url }) {
    const p = await ensurePage();
    await p.goto(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await p.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    return pageSummary(p);
  },
});

registerTool({
  name: 'browser_read',
  label: 'Browser: lesen',
  group: 'browser',
  description: 'Liest die aktuell geöffnete Seite im gesteuerten Browser erneut aus.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    return pageSummary(await ensurePage());
  },
});

registerTool({
  name: 'browser_click',
  label: 'Browser: klicken',
  group: 'browser',
  description: 'Klickt ein Element an – per sichtbarem Text (bevorzugt) oder CSS-Selektor.',
  input_schema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' } } },
  async run({ text, selector }) {
    const p = await ensurePage();
    if (!text && !selector) throw new Error('text oder selector angeben');
    const loc = selector ? p.locator(selector).first() : p.getByText(text, { exact: false }).first();
    await loc.click({ timeout: 10_000 });
    await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    return pageSummary(p);
  },
});

registerTool({
  name: 'browser_type',
  label: 'Browser: eingeben',
  group: 'browser',
  description: 'Gibt Text in ein Eingabefeld ein (Selektor, Label oder Platzhaltertext) und drückt optional Enter.',
  input_schema: {
    type: 'object',
    properties: { field: { type: 'string', description: 'CSS-Selektor, Label oder Placeholder' }, text: { type: 'string' }, submit: { type: 'boolean' } },
    required: ['field', 'text'],
  },
  async run({ field, text, submit = false }) {
    const p = await ensurePage();
    let loc = p.getByLabel(field).or(p.getByPlaceholder(field)).first();
    if (!(await loc.count())) loc = p.locator(field).first();
    await loc.fill(text, { timeout: 10_000 });
    if (submit) await loc.press('Enter');
    await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    return pageSummary(p);
  },
});

registerTool({
  name: 'browser_screenshot',
  label: 'Browser: Screenshot',
  group: 'browser',
  description: 'Erstellt einen Screenshot der aktuellen Seite, damit du das Layout sehen kannst.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const p = await ensurePage();
    const buf = await p.screenshot({ type: 'jpeg', quality: 70 });
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } },
      { type: 'text', text: `Screenshot von ${p.url()}` },
    ];
  },
});

registerTool({
  name: 'browser_close',
  label: 'Browser: schließen',
  group: 'browser',
  description: 'Schließt den gesteuerten Browser.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    await context?.close();
    return 'Browser geschlossen.';
  },
});

export async function closeBrowser() {
  await context?.close().catch(() => {});
}
