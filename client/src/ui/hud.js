// HUD-Panels: rendern ausschließlich echte Daten vom Server.
const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtBytes = (b) => {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
};
const fmtDur = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const time = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

function gauge(pct, label) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, pct || 0));
  const ticks = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2 - Math.PI / 2;
    const on = i / 40 < v / 100;
    return `<line x1="${46 + Math.cos(a) * 43}" y1="${46 + Math.sin(a) * 43}" x2="${46 + Math.cos(a) * 45.5}" y2="${46 + Math.sin(a) * 45.5}" stroke="${on ? '#2be4ff' : 'rgba(43,228,255,.18)'}" stroke-width="1.4"/>`;
  }).join('');
  return `<svg class="gauge" viewBox="0 0 92 92" role="img" aria-label="${label} ${v}%">
    ${ticks}
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="rgba(43,228,255,.12)" stroke-width="5"/>
    <circle cx="46" cy="46" r="${r}" fill="none" stroke="url(#gg)" stroke-width="5" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 46 46)" style="transition:stroke-dasharray .6s ease; filter: drop-shadow(0 0 4px #2be4ff)"/>
    <defs><linearGradient id="gg"><stop offset="0" stop-color="#2d7bff"/><stop offset="1" stop-color="#2be4ff"/></linearGradient></defs>
    <text x="46" y="48" text-anchor="middle" font-size="18">${v}<tspan font-size="9">%</tspan></text>
    <text x="46" y="62" text-anchor="middle" font-size="7" fill="#6fa3b6" style="font-family:var(--mono);letter-spacing:.15em">${label}</text>
  </svg>`;
}

export function renderSystem(m) {
  if (!m) return;
  $('host-label').textContent = m.host?.name || '';
  const net = m.net || {};
  const online = net.online === null ? '<span class="warn">PRÜFE …</span>' : net.online ? '<span class="ok">ONLINE</span>' : '<span class="bad">OFFLINE</span>';
  $('system-body').innerHTML = `
    <div class="sys-grid">
      ${gauge(m.cpu.load, 'CPU')}
      <div>
        <div class="metric"><span class="k">RAM</span><span class="bar"><i style="width:${m.mem.usedPct}%"></i></span><span class="v">${m.mem.usedPct}%</span></div>
        <div class="metric"><span class="k">BELEGT</span><span class="item-sub">${fmtBytes(m.mem.used)} / ${fmtBytes(m.mem.total)}</span><span></span></div>
        ${m.battery ? `<div class="metric"><span class="k">AKKU</span><span class="bar"><i style="width:${m.battery.percent}%"></i></span><span class="v">${m.battery.percent}%${m.battery.charging ? '⚡' : ''}</span></div>` : ''}
        <div class="cores" title="CPU-Kerne">${m.cpu.cores.map((c) => `<i style="height:${Math.max(4, c)}%"></i>`).join('')}</div>
      </div>
    </div>
    <div class="subhead">Netzwerk</div>
    <div class="net-row"><span>Internet</span>${online}</div>
    <div class="net-row"><span>Latenz Claude-API</span><span>${net.latencyMs != null ? `${net.latencyMs} ms` : '–'}</span></div>
    <div class="net-row"><span>↓ ${fmtBytes(m.netio.rxPerSec)}/s</span><span>↑ ${fmtBytes(m.netio.txPerSec)}/s</span></div>
    ${
      m.processes
        ? `<div class="subhead">Prozesse · ${m.processes.total}</div>
      ${m.processes.top.map((p) => `<div class="proc"><span>${esc(p.name)}</span><span>${p.cpu}%</span><span>${p.mem}%</span></div>`).join('')}`
        : ''
    }
    <div class="net-row" style="margin-top:8px"><span>Laufzeit</span><span>${fmtDur(m.host.uptime)}</span></div>`;
}

export function renderMcp(servers) {
  const connected = servers.filter((s) => s.status === 'connected').length;
  $('mcp-count').textContent = servers.length ? `${connected}/${servers.length} AKTIV` : '';
  if (!servers.length) {
    $('mcp-body').innerHTML = `<div class="empty">Keine MCP-Server konfiguriert.<br/>Sag z.B. <b>„Jarvis, richte eine MCP-Integration für meinen Kalender ein“</b> oder trage Server in <b>data/mcp.json</b> ein.</div>`;
    return;
  }
  const label = { connected: 'verbunden', connecting: 'verbinde …', error: 'Fehler', disconnected: 'getrennt', disabled: 'deaktiviert' };
  $('mcp-body').innerHTML = servers
    .map(
      (s) => `<div class="item">
        <div class="item-title"><span class="dot ${s.status}"></span>${esc(s.name)}<span class="tag">${s.kind.toUpperCase()}</span></div>
        <div class="item-sub">${label[s.status] || s.status} · ${s.tools.length} Tools${s.error ? ` · ${esc(s.error)}` : ''}</div>
        ${s.active.length ? `<div class="item-sub" style="color:var(--cyan)">▸ führt aus: ${s.active.map(esc).join(', ')}</div>` : ''}
      </div>`,
    )
    .join('');
}

export function renderAgenda(events, todos) {
  const parts = [];
  if (events === null) parts.push(`<div class="empty">Kein Kalender verbunden – setze <b>JARVIS_CALENDAR_ICS</b> in der .env.</div>`);
  else if (events?.error) parts.push(`<div class="empty bad">Kalenderfehler: ${esc(events.error)}</div>`);
  else if (Array.isArray(events)) {
    parts.push(`<div class="subhead">Termine · ${events.length}</div>`);
    parts.push(events.length ? events.map((e) => `<div class="item"><div class="item-title">${esc(e.title)}</div><div class="item-sub">${e.allDay ? 'ganztägig' : `${time(e.start)} – ${time(e.end)}`}${e.location ? ` · ${esc(e.location)}` : ''}</div></div>`).join('') : '<div class="empty">Keine Termine heute.</div>');
  }
  if (todos) {
    parts.push(`<div class="subhead">Offene Aufgaben · ${todos.open}</div>`);
    parts.push(
      todos.items.length
        ? todos.items.map((t) => `<div class="item"><div class="item-title">${esc(t.title)}<span class="tag">${esc(t.priority)}</span></div>${t.due ? `<div class="item-sub">fällig ${esc(t.due)}</div>` : ''}</div>`).join('')
        : '<div class="empty">Keine offenen Aufgaben.</div>',
    );
  }
  $('agenda-meta').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  $('agenda-body').innerHTML = parts.join('');
}

export function renderTasks(tasks, onCancel) {
  const running = [...tasks.values()].filter((t) => t.status === 'running' || t.status === 'queued');
  const done = [...tasks.values()].filter((t) => !(t.status === 'running' || t.status === 'queued')).sort((a, b) => (b.finished || 0) - (a.finished || 0)).slice(0, 5);
  $('tasks-count').textContent = running.length ? `${running.length} AKTIV` : '';
  if (!running.length && !done.length) {
    $('tasks-body').innerHTML = `<div class="empty">Keine Agenten aktiv.<br/>Beispiel: <b>„Jarvis, recherchiere die besten aktuellen Investitionsmöglichkeiten im Bereich Robotik.“</b></div>`;
    return;
  }
  const statusText = { running: 'läuft', queued: 'wartet', done: 'fertig', error: 'Fehler', cancelled: 'abgebrochen' };
  const tools = (t) => Object.entries(t.tools || {}).map(([k, v]) => `<span class="tag">${esc(k)} ×${v}</span>`).join(' ');
  $('tasks-body').innerHTML = [
    ...running.map(
      (t) => `<div class="item">
        <div class="item-title"><span class="dot ${t.status}"></span>${esc(t.title)}<button class="small-btn" data-cancel="${t.id}" type="button">Stopp</button></div>
        <div class="item-sub">${statusText[t.status]} · ${t.started ? ago(t.started) : '–'} · ${t.origin}</div>
        <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">${tools(t)}</div>
        <ul class="steps">${(t.steps || []).slice(-4).map((s) => `<li class="${s.kind}">${esc(s.text)}</li>`).join('')}</ul>
      </div>`,
    ),
    ...done.map(
      (t) => `<div class="item" style="opacity:.8">
        <div class="item-title"><span class="dot ${t.status}"></span>${esc(t.title)}</div>
        <div class="item-sub">${statusText[t.status] || t.status}${t.finished ? ` · vor ${ago(t.finished)}` : ''}</div>
        ${t.summary ? `<div class="task-summary">${esc(t.summary)}</div>` : ''}
        ${t.resultFile ? `<div class="item-sub">📄 ${esc(t.resultFile)}</div>` : ''}
        ${t.error ? `<div class="item-sub bad">${esc(t.error)}</div>` : ''}
      </div>`,
    ),
  ].join('');
  $('tasks-body').querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => onCancel(b.dataset.cancel)));
}

export function renderActivity(list) {
  const running = list.filter((a) => a.status === 'running').length;
  $('activity-meta').textContent = running ? `${running} LAUFEND` : list.length ? `${list.length}` : '';
  if (!list.length) return;
  const icon = { running: '◌', done: '✓', error: '✕' };
  $('activity-body').innerHTML = list
    .slice(0, 30)
    .map(
      (a) => `<div class="act">
        <span class="st ${a.status}">${icon[a.status] || '·'}</span>
        <span><span class="nm">${esc(a.label || a.name)}</span><span class="sm">${esc(a.summary || '')}</span></span>
        <span class="src">${a.source === 'task' ? 'AGENT' : 'JARVIS'}${a.ms ? ` · ${a.ms < 1000 ? `${a.ms}ms` : `${(a.ms / 1000).toFixed(1)}s`}` : ''}</span>
      </div>`,
    )
    .join('');
}

export function renderLog(entries) {
  const body = $('log-body');
  if (!entries.length) {
    body.innerHTML = '<div class="empty">Noch kein Gespräch.</div>';
    return;
  }
  body.innerHTML = entries
    .slice(-40)
    .map((e) => `<div class="log-entry ${e.role}"><span class="who">${e.role === 'user' ? 'DU' : e.role === 'system' ? 'SYSTEM' : 'JARVIS'}</span><span class="txt">${esc(e.text)}</span></div>`)
    .join('');
  body.scrollTop = body.scrollHeight;
}

export function toast(level, title, body) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<b>${esc(title)}</b>${esc(body || '')}`;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .5s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 600);
  }, level === 'error' ? 9000 : 6000);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}
