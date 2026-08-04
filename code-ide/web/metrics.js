/* ===== Code Observatory — Metrics dashboard ===== */

import { state } from './state.js';
import { $, escapeHtml } from './dom.js';
import { api, showToast } from './api.js';

let openFileFn = null;
let index = null;
let sortKey = 'complexity';
let sortDir = -1;

function repoRoot() {
  return state.rootDir || state.homePath;
}

function absPath(rel) {
  const root = repoRoot();
  return root.replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
}

function fmt(n) {
  if (n == null) return '–';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function ccClass(cc) {
  if (cc >= 40) return 'cc-high';
  if (cc >= 15) return 'cc-mid';
  return 'cc-low';
}

function rdClass(r) {
  if (r >= 70) return 'rd-good';
  if (r >= 45) return 'rd-mid';
  return 'rd-bad';
}

export async function refreshMetrics() {
  const status = $('metrics-status');
  status.textContent = 'Checking index…';
  const res = await api('metrics_status', { path: repoRoot() });
  if (res.error) { status.textContent = res.error; return; }
  if (!res.exists) {
    status.textContent = 'No index — click build to analyze the workspace.';
    $('metrics-body').innerHTML = '';
    return;
  }
  status.textContent = `Index: ${res.file_count} files`;
  await loadAndRender();
}

async function loadAndRender() {
  const res = await api('metrics_index', { path: repoRoot() });
  if (res.error) { $('metrics-status').textContent = res.error; return; }
  index = res;
  $('metrics-status').textContent =
    `${index.totals.files} files · ${fmt(index.totals.lines)} lines · dup ${index.totals.duplication_pct}%`;
  renderDashboard();
}

export async function buildMetrics() {
  const status = $('metrics-status');
  const body = $('metrics-body');
  status.textContent = 'Building index…';
  body.innerHTML = '<div class="loading"><div class="spinner"></div>Analyzing…</div>';
  const res = await api('metrics_index', { path: repoRoot(), refresh: true });
  if (res.error) {
    status.textContent = res.error;
    body.innerHTML = '';
    showToast(res.error, 'error');
    return;
  }
  index = res;
  status.textContent =
    `${index.totals.files} files · ${fmt(index.totals.lines)} lines · dup ${index.totals.duplication_pct}%`;
  renderDashboard();
  showToast(`Indexed ${index.totals.files} files`, 'success');
}

function card(label, value, sub, cls) {
  const el = document.createElement('div');
  el.className = 'metric-card' + (cls ? ' ' + cls : '');
  el.innerHTML = `<div class="metric-card-value">${value}</div>` +
    `<div class="metric-card-label">${label}</div>` +
    (sub ? `<div class="metric-card-sub">${sub}</div>` : '');
  return el;
}

function sectionTitle(text, count) {
  const el = document.createElement('div');
  el.className = 'obs-section-title';
  el.innerHTML = `<span>${text}</span>` + (count != null ? `<span class="obs-section-count">${count}</span>` : '');
  return el;
}

function renderDashboard() {
  const body = $('metrics-body');
  body.innerHTML = '';
  const t = index.totals;

  // Summary cards
  const cards = document.createElement('div');
  cards.className = 'metric-cards';
  cards.appendChild(card('Files', fmt(t.files), null));
  cards.appendChild(card('Lines of code', fmt(t.code), `${fmt(t.comment)} comment · ${fmt(t.blank)} blank`));
  cards.appendChild(card('Avg complexity', t.avg_complexity, `total ${fmt(t.complexity)}`));
  cards.appendChild(card('Duplication', t.duplication_pct + '%', `${t.dup_blocks} blocks · ${fmt(t.dupe_lines)} lines`, t.duplication_pct > 10 ? 'warn' : ''));
  body.appendChild(cards);

  // Language breakdown
  if (index.languages.length) {
    body.appendChild(sectionTitle('Languages', index.languages.length));
    const langBar = document.createElement('div');
    langBar.className = 'lang-bar';
    const totalCode = index.languages.reduce((s, l) => s + l.code, 0) || 1;
    for (const l of index.languages) {
      const seg = document.createElement('div');
      seg.className = 'lang-seg';
      seg.style.flex = l.code;
      seg.title = `${l.language}: ${fmt(l.code)} lines · ${l.files} files · cc ${l.complexity}`;
      seg.innerHTML = `<span>${escapeHtml(l.language)}</span>`;
      langBar.appendChild(seg);
    }
    body.appendChild(langBar);
    const legend = document.createElement('div');
    legend.className = 'lang-legend';
    for (const l of index.languages) {
      const pct = Math.round(100 * l.code / totalCode);
      legend.innerHTML += `<span class="lang-leg-item"><b>${escapeHtml(l.language)}</b> ${fmt(l.code)} (${pct}%) · ${l.files}f</span>`;
    }
    body.appendChild(legend);
  }

  // Complexity hotspots
  if (index.hotspots.length) {
    body.appendChild(sectionTitle('Complexity hotspots', index.hotspots.length));
    const list = document.createElement('div');
    list.className = 'obs-list';
    const maxCc = Math.max(...index.hotspots.map(h => h.complexity), 1);
    for (const h of index.hotspots.slice(0, 15)) {
      const row = document.createElement('div');
      row.className = 'hotspot-row';
      row.title = `${h.file}:${h.line} · ${h.name}()`;
      const bar = document.createElement('div');
      bar.className = 'hotspot-bar ' + ccClass(h.complexity);
      bar.style.width = (100 * h.complexity / maxCc) + '%';
      const name = document.createElement('span');
      name.className = 'hotspot-name';
      name.textContent = h.name;
      const loc = document.createElement('span');
      loc.className = 'hotspot-loc';
      loc.textContent = h.file;
      const cc = document.createElement('span');
      cc.className = 'hotspot-cc ' + ccClass(h.complexity);
      cc.textContent = h.complexity;
      row.append(bar, name, loc, cc);
      row.addEventListener('click', () => openFileFn && openFileFn(absPath(h.file), h.file.split('/').pop()));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  // Largest files
  if (index.largest_files.length) {
    body.appendChild(sectionTitle('Largest files', index.largest_files.length));
    body.appendChild(fileList(index.largest_files.slice(0, 12), 'lines', 'complexity'));
  }

  // Most complex files
  if (index.most_complex_files.length) {
    body.appendChild(sectionTitle('Most complex files', index.most_complex_files.length));
    body.appendChild(fileList(index.most_complex_files.slice(0, 12), 'complexity', 'lines'));
  }

  // Least readable
  if (index.least_readable.length) {
    body.appendChild(sectionTitle('Least readable', index.least_readable.length));
    body.appendChild(readableList(index.least_readable.slice(0, 12)));
  }

  // Duplication
  if (index.duplicates.length) {
    body.appendChild(sectionTitle('Duplication', index.duplicates.length));
    body.appendChild(dupeList(index.duplicates.slice(0, 20)));
  }

  // Full per-file table
  body.appendChild(sectionTitle('All files', index.files.length));
  body.appendChild(fileTable());
}

function fileList(items, primary, secondary) {
  const list = document.createElement('div');
  list.className = 'obs-list';
  for (const f of items) {
    const row = document.createElement('div');
    row.className = 'filelist-row';
    row.title = f.path;
    const name = document.createElement('span');
    name.className = 'filelist-name';
    name.textContent = f.path.split('/').pop();
    const parent = document.createElement('span');
    parent.className = 'filelist-parent';
    parent.textContent = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';
    const val = document.createElement('span');
    val.className = 'filelist-val';
    val.innerHTML = `<span class="${primary === 'complexity' ? ccClass(f[primary]) : ''}">${fmt(f[primary])}</span>` +
      `<span class="filelist-sub">${secondary}: ${fmt(f[secondary])}</span>`;
    row.append(name, parent, val);
    row.addEventListener('click', () => openFileFn && openFileFn(absPath(f.path), f.path.split('/').pop()));
    list.appendChild(row);
  }
  return list;
}

function readableList(items) {
  const list = document.createElement('div');
  list.className = 'obs-list';
  for (const f of items) {
    const row = document.createElement('div');
    row.className = 'filelist-row';
    row.title = f.path;
    const name = document.createElement('span');
    name.className = 'filelist-name';
    name.textContent = f.path.split('/').pop();
    const parent = document.createElement('span');
    parent.className = 'filelist-parent';
    parent.textContent = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';
    const val = document.createElement('span');
    val.className = 'filelist-val';
    val.innerHTML = `<span class="rd-badge ${rdClass(f.readability)}">${f.readability}</span>` +
      `<span class="filelist-sub">${fmt(f.lines)} lines</span>`;
    row.append(name, parent, val);
    row.addEventListener('click', () => openFileFn && openFileFn(absPath(f.path), f.path.split('/').pop()));
    list.appendChild(row);
  }
  return list;
}

function dupeList(groups) {
  const list = document.createElement('div');
  list.className = 'obs-list';
  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'dupe-row';
    const head = document.createElement('div');
    head.className = 'dupe-head';
    head.innerHTML = `<span class="dupe-lines">${g.lines} lines</span>` +
      `<span class="dupe-count">${g.occurrences.length} copies</span>`;
    row.appendChild(head);
    for (const o of g.occurrences) {
      const occ = document.createElement('div');
      occ.className = 'dupe-occ';
      occ.innerHTML = `<span class="dupe-occ-path">${escapeHtml(o.path)}</span>` +
        `<span class="dupe-occ-range">L${o.start}–${o.end}</span>`;
      occ.addEventListener('click', () => openFileFn && openFileFn(absPath(o.path), o.path.split('/').pop()));
      row.appendChild(occ);
    }
    list.appendChild(row);
  }
  return list;
}

const COLUMNS = [
  { key: 'path', label: 'File', flex: 2 },
  { key: 'language', label: 'Lang', flex: 1 },
  { key: 'lines', label: 'Lines', sub: 'total', flex: 1 },
  { key: 'complexity', label: 'CC', flex: 1 },
  { key: 'readability', label: 'Read', flex: 1 },
];

function fileTable() {
  const wrap = document.createElement('div');
  wrap.className = 'obs-table-wrap';
  const table = document.createElement('div');
  table.className = 'obs-table';
  // header
  const head = document.createElement('div');
  head.className = 'obs-table-head';
  for (const c of COLUMNS) {
    const cell = document.createElement('div');
    cell.className = 'obs-table-th' + (sortKey === c.key ? ' sorted' : '');
    cell.style.flex = c.flex;
    cell.textContent = (sortDir === -1 ? '▼ ' : '▲ ') + c.label;
    cell.addEventListener('click', () => {
      if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = -1; }
      renderDashboard();
    });
    head.appendChild(cell);
  }
  table.appendChild(head);
  // rows
  const files = [...index.files].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });
  for (const f of files.slice(0, 200)) {
    const row = document.createElement('div');
    row.className = 'obs-table-row';
    row.title = f.path;
    const cells = [
      f.path.split('/').pop(),
      f.language,
      fmt(f.lines.total),
      `<span class="${ccClass(f.complexity)}">${f.complexity}</span>`,
      `<span class="rd-badge ${rdClass(f.readability)}">${f.readability}</span>`,
    ];
    COLUMNS.forEach((c, i) => {
      const cell = document.createElement('div');
      cell.className = 'obs-table-td';
      cell.style.flex = c.flex;
      cell.innerHTML = cells[i];
      row.appendChild(cell);
    });
    row.addEventListener('click', () => openFileFn && openFileFn(absPath(f.path), f.path.split('/').pop()));
    table.appendChild(row);
  }
  wrap.appendChild(table);
  if (files.length > 200) {
    const note = document.createElement('div');
    note.className = 'obs-table-note';
    note.textContent = `Showing top 200 of ${files.length} (sorted by ${sortKey})`;
    wrap.appendChild(note);
  }
  return wrap;
}

export function resetMetrics() {
  index = null;
  const body = $('metrics-body');
  if (body) body.innerHTML = '';
  const status = $('metrics-status');
  if (status) status.textContent = 'No index — click build.';
}

export function initMetrics(openFile) {
  openFileFn = openFile;
  $('metrics-build').addEventListener('click', buildMetrics);
}