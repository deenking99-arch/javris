// Kalender über iCal/ICS-Feeds (z.B. Google Kalender "Privatadresse im iCal-Format", Outlook, iCloud).
// Weitere Kalender lassen sich zusätzlich über MCP-Server anbinden.
import ical from 'node-ical';
import { config } from '../config.js';
import { registerTool } from './registry.js';

let cache = { at: 0, events: [] };

async function loadEvents() {
  if (Date.now() - cache.at < 5 * 60_000) return cache.events;
  const all = [];
  for (const url of config.calendar.icsUrls) {
    const data = await ical.async.fromURL(url);
    for (const ev of Object.values(data)) if (ev.type === 'VEVENT') all.push(ev);
  }
  cache = { at: Date.now(), events: all };
  return all;
}

/** Expandiert (auch wiederkehrende) Termine in [from, to). */
export async function eventsBetween(from, to) {
  if (!config.calendar.icsUrls.length) return null;
  const out = [];
  for (const ev of await loadEvents()) {
    const dur = ev.end && ev.start ? new Date(ev.end) - new Date(ev.start) : 0;
    const push = (start, src = ev) => {
      const s = new Date(start);
      if (s < to && new Date(s.getTime() + dur) > from) {
        out.push({
          title: src.summary || '(ohne Titel)',
          start: s.toISOString(),
          end: new Date(s.getTime() + dur).toISOString(),
          allDay: ev.datetype === 'date',
          location: src.location || '',
        });
      }
    };
    if (ev.rrule) {
      const exdates = new Set(Object.values(ev.exdate || {}).map((d) => new Date(d).toISOString().slice(0, 10)));
      for (const d of ev.rrule.between(new Date(from.getTime() - dur), to, true)) {
        const key = d.toISOString().slice(0, 10);
        if (exdates.has(key)) continue;
        const override = ev.recurrences?.[key];
        push(override?.start || d, override || ev);
      }
    } else if (ev.start) {
      push(ev.start);
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function range(kind) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86_400_000;
  if (kind === 'morgen') return [new Date(+start + day), new Date(+start + 2 * day)];
  if (kind === 'woche') return [start, new Date(+start + 7 * day)];
  return [start, new Date(+start + day)];
}

registerTool({
  name: 'calendar_events',
  label: 'Kalender',
  group: 'calendar',
  description:
    'Liest Termine aus den konfigurierten Kalendern (ICS-Feeds). Zeitraum: "heute", "morgen", "woche" oder eigener Bereich mit from/to (ISO).',
  input_schema: {
    type: 'object',
    properties: {
      range: { type: 'string', enum: ['heute', 'morgen', 'woche'] },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  },
  async run({ range: r = 'heute', from, to }) {
    const [f, t] = from && to ? [new Date(from), new Date(to)] : range(r);
    const events = await eventsBetween(f, t);
    if (events === null)
      return 'Kein Kalender verbunden. Der Nutzer kann in der .env JARVIS_CALENDAR_ICS mit der iCal-Adresse seines Kalenders setzen oder einen Kalender-MCP-Server einrichten.';
    return events.length ? events : 'Keine Termine im Zeitraum.';
  },
});

export async function todayEventsSafe() {
  try {
    const [f, t] = range('heute');
    return await eventsBetween(f, t);
  } catch (e) {
    return { error: e.message };
  }
}
