/* ===== Code Observatory — Symbol Explorer (Structure tab) ===== */

import { state } from './state.js';
import { $ } from './dom.js';
import { api, showToast } from './api.js';
import { revealLine } from './editor.js';

let openFileFn = null;
let index = null;          // slim index: modules + edges + summary
let modById = new Map();
let mode = 'tree';         // 'tree' | 'entry' | 'calltree'
let treeExpanded = new Set();
let moduleSymCache = new Map();
let entryPointsData = null;
let callTreeData = null;
// Enough roots to show the shape without a wall of trees.
const CALLTREE_ROOTS = 6;
let callTreeExpanded = new Set();

function repoRoot() {
  return state.rootDir || state.homePath;
}
function absPath(rel) {
  const root = repoRoot();
  return root.replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
}
function parseId(id) {
  const at = id.lastIndexOf('@');
  const line = at >= 0 ? parseInt(id.slice(at + 1), 10) : 1;
  const mod = at >= 0 ? id.slice(0, at) : id;
  const dd = mod.indexOf('::');
  const module = dd >= 0 ? mod.slice(0, dd) : mod;
  return { module, line };
}
const KIND_ICON = {
  function: 'bi-box-arrow-in-right', method: 'bi-box-arrow-in-right',
  class: 'bi-bounding-box', struct: 'bi-bounding-box',
  interface: 'bi-bounding-boxes', trait: 'bi-bounding-boxes',
  protocol: 'bi-bounding-boxes', enum: 'bi-list-stars',
  type: 'bi-type', typedef: 'bi-type', object: 'bi-box',
  impl: 'bi-gear', module: 'bi-collection',
};
const LANG_COLOR = {
  python: '#4fc1ff', javascript: '#dcdcaa', typescript: '#569cd6',
  tsx: '#569cd6', go: '#4ec9b0', rust: '#ce9178', java: '#c586c0',
  c: '#9cdcfe', cpp: '#9cdcfe', csharp: '#c586c0', ruby: '#f14c4c',
  php: '#9b7edb', kotlin: '#c586c0', swift: '#f14c4c', scala: '#c586c0',
  lua: '#569cd6',
};
function langColor(l) { return LANG_COLOR[l] || '#888'; }
function kindIcon(k) { return KIND_ICON[k] || 'bi-box-arrow-in-right'; }

export async function refreshStructure() {
  const status = $('structure-status');
  status.textContent = 'Checking index…';
  const res = await api('symbol_status', { path: repoRoot() });
  if (res.error) { status.textContent = res.error; return; }
  if (!res.exists) {
    status.textContent = 'No index — click build to analyze symbols.';
    clearView();
    return;
  }
  status.textContent = `Index: ${res.symbol_count} symbols · ${res.file_count} files`;
  await loadAndRender();
}

async function loadAndRender() {
  const res = await api('symbol_index', { path: repoRoot() });
  if (res.error) { $('structure-status').textContent = res.error; return; }
  index = res;
  modById = new Map(index.modules.map(m => [m.id, m]));
  moduleSymCache = new Map();
  entryPointsData = null;
  callTreeData = null;
  $('structure-status').textContent =
    `${index.symbol_count} symbols · ${index.file_count} files · ${index.edges.length} deps · ${index.call_count} calls`;
  render();
}

export async function buildStructure() {
  const status = $('structure-status');
  status.textContent = 'Building symbol index…';
  clearView();
  const res = await api('symbol_index', { path: repoRoot(), refresh: true });
  if (res.error) {
    status.textContent = res.error;
    showToast(res.error, 'error');
    return;
  }
  index = res;
  modById = new Map(index.modules.map(m => [m.id, m]));
  moduleSymCache = new Map();
  entryPointsData = null;
  callTreeData = null;
  treeExpanded = new Set();
  status.textContent =
    `${index.symbol_count} symbols · ${index.file_count} files · ${index.edges.length} deps · ${index.call_count} calls`;
  render();
  showToast(`Indexed ${index.symbol_count} symbols in ${index.file_count} files`, 'success');
}

function clearView() {
  $('structure-tree').innerHTML = '';
  $('symbol-details').hidden = true;
}

function setMode(m) {
  mode = m;
  $('structure-mode-tree').classList.toggle('active', m === 'tree');
  $('structure-mode-entry').classList.toggle('active', m === 'entry');
  $('structure-mode-calltree').classList.toggle('active', m === 'calltree');
  $('symbol-details').hidden = true;
  render();
}

function render() {
  if (!index) return;
  $('symbol-details').hidden = true;
  if (mode === 'tree') renderTree();
  else if (mode === 'entry') renderEntryPoints();
  else if (mode === 'calltree') renderCallTreeMode();
}

// ---- Symbol Tree (browse by module) ----

function renderTree() {
  const container = $('structure-tree');
  container.innerHTML = '';
  if (!index) { container.textContent = 'No index loaded.'; return; }
  try {
    const q = ($('symbol-search').value || '').trim().toLowerCase();
    if (q) { renderSearchResults(container, q); return; }

    for (const m of index.modules) {
      const modNode = document.createElement('div');
      modNode.className = 'sym-mod';
      modNode.dataset.mod = m.id;
      const head = document.createElement('div');
      head.className = 'sym-mod-head';
      const open = treeExpanded.has(m.id);
      const chev = document.createElement('i');
      chev.className = open ? 'bi bi-chevron-down sym-chev' : 'bi bi-chevron-right sym-chev';
      const dot = document.createElement('span');
      dot.className = 'sym-mod-dot';
      dot.style.background = langColor(m.language);
      const name = document.createElement('span');
      name.className = 'sym-mod-name';
      name.textContent = m.path.split('/').pop();
      const parent = document.createElement('span');
      parent.className = 'sym-mod-parent';
      parent.textContent = m.path.includes('/') ? m.path.substring(0, m.path.lastIndexOf('/')) : '';
      const count = document.createElement('span');
      count.className = 'sym-mod-count';
      count.textContent = m.sym_count;
      head.append(chev, dot, name, parent, count);
      head.title = m.path + ' · ' + m.language + ' · ' + m.sym_count + ' symbols';
      head.addEventListener('click', () => {
        if (treeExpanded.has(m.id)) treeExpanded.delete(m.id); else treeExpanded.add(m.id);
        renderTree();
      });
      modNode.appendChild(head);

      const body = document.createElement('div');
      body.className = 'sym-mod-body';
      body.hidden = !open;
      if (open) renderModuleSymbols(body, m);
      modNode.appendChild(body);
      container.appendChild(modNode);
    }
  } catch (err) {
    container.textContent = 'Error rendering tree: ' + err.message;
  }
}

async function renderModuleSymbols(container, m) {
  if (moduleSymCache.has(m.id)) {
    drawModuleSymbols(container, m, moduleSymCache.get(m.id));
    return;
  }
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.innerHTML = '<div class="spinner"></div>Loading…';
  container.appendChild(loading);
  const res = await api('module_symbols', { path: repoRoot(), module: m.id });
  if (res.error) { loading.textContent = res.error; return; }
  moduleSymCache.set(m.id, res.symbols);
  container.removeChild(loading);
  drawModuleSymbols(container, m, res.symbols);
}

function drawModuleSymbols(container, m, syms) {
  const topLevel = syms.filter(s => !s.enclosing);
  const byEnclosing = new Map();
  for (const s of syms) {
    if (s.enclosing) {
      if (!byEnclosing.has(s.enclosing)) byEnclosing.set(s.enclosing, []);
      byEnclosing.get(s.enclosing).push(s);
    }
  }
  for (const s of topLevel) {
    container.appendChild(symbolRow(s, 0));
    const children = byEnclosing.get(s.id) || [];
    for (const c of children.sort((a, b) => a.line - b.line)) {
      container.appendChild(symbolRow(c, 1));
    }
  }
}

function symbolRow(s, depth) {
  const row = document.createElement('div');
  row.className = 'sym-row sym-' + s.kind;
  row.style.paddingLeft = (depth * 12 + 8) + 'px';
  row.dataset.sid = s.id;
  const icon = document.createElement('i');
  icon.className = 'bi ' + kindIcon(s.kind) + ' sym-kind-icon';
  const name = document.createElement('span');
  name.className = 'sym-name';
  name.textContent = s.name;
  const meta = document.createElement('span');
  meta.className = 'sym-meta';
  meta.textContent = 'L' + s.line;
  row.append(icon, name, meta);
  row.title = s.kind + ' ' + s.name + '\n' + (s.callees_count || 0) + ' callees · ' + (s.callers_count || 0) + ' callers';
  row.addEventListener('click', () => selectSymbol(s.id, s.name, s.kind));
  return row;
}

// ---- Search ----

let searchTimer = null;
async function renderSearchResults(container, q) {
  const head = document.createElement('div');
  head.className = 'sym-search-count';
  head.textContent = 'Searching…';
  container.appendChild(head);
  const res = await api('symbol_search', { path: repoRoot(), query: q, limit: 200 });
  if (res.error) { head.textContent = res.error; return; }
  head.textContent = res.count + ' symbol' + (res.count === 1 ? '' : 's') + ' matching "' + q + '"';
  for (const s of res.results) container.appendChild(searchRow(s));
}

function searchRow(s) {
  const row = document.createElement('div');
  row.className = 'sym-row sym-search-row';
  const icon = document.createElement('i');
  icon.className = 'bi ' + kindIcon(s.kind) + ' sym-kind-icon';
  const name = document.createElement('span');
  name.className = 'sym-name';
  name.textContent = s.name;
  const loc = document.createElement('span');
  loc.className = 'sym-meta';
  loc.textContent = s.module + ':' + s.line;
  row.append(icon, name, loc);
  row.title = s.kind + ' · ' + s.module + ':' + s.line;
  row.addEventListener('click', () => selectSymbol(s.id, s.name, s.kind));
  return row;
}

// ---- Entry Points ----

async function renderEntryPoints() {
  const container = $('structure-tree');
  container.innerHTML = '';
  if (!entryPointsData) {
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.innerHTML = '<div class="spinner"></div>Finding entry points…';
    container.appendChild(loading);
    const res = await api('entry_points', { path: repoRoot() });
    if (res.error) { loading.textContent = res.error; return; }
    entryPointsData = res;
    container.removeChild(loading);
  }

  const data = entryPointsData;
  const head = document.createElement('div');
  head.className = 'sym-search-count';
  head.textContent = data.entry_points.length + ' entry points · ' + data.tests.length + ' tests';
  container.appendChild(head);

  // Entry points
  const epTitle = document.createElement('div');
  epTitle.className = 'obs-section-title';
  epTitle.innerHTML = '<span>Entry Points</span><span class="obs-section-count">' + data.entry_points.length + '</span>';
  container.appendChild(epTitle);

  for (const s of data.entry_points) {
    container.appendChild(entryPointRow(s));
  }

  // Tests
  if (data.tests.length) {
    const tTitle = document.createElement('div');
    tTitle.className = 'obs-section-title';
    tTitle.innerHTML = '<span>Tests</span><span class="obs-section-count">' + data.tests.length + '</span>';
    container.appendChild(tTitle);
    for (const s of data.tests) {
      container.appendChild(entryPointRow(s));
    }
  }
}

function entryPointRow(s) {
  const row = document.createElement('div');
  row.className = 'sym-row sym-' + s.kind;
  const icon = document.createElement('i');
  icon.className = 'bi ' + kindIcon(s.kind) + ' sym-kind-icon';
  const name = document.createElement('span');
  name.className = 'sym-name';
  name.textContent = s.name;
  const mod = document.createElement('span');
  mod.className = 'sym-mod-parent';
  mod.textContent = s.module;
  const meta = document.createElement('span');
  meta.className = 'sym-meta';
  meta.textContent = s.size + 'L';
  row.append(icon, name, mod, meta);
  row.title = s.kind + ' ' + s.name + '\n' + s.module + ':' + s.line + '\n' + s.size + ' lines · ' + s.callees_count + ' callees';
  row.addEventListener('click', () => selectSymbol(s.id, s.name, s.kind));
  return row;
}

// ---- Call Tree ----

async function renderCallTreeMode() {
  const container = $('structure-tree');
  container.innerHTML = '';
  if (callTreeData) {
    drawCallTreeNode(container, callTreeData, 0);
    return;
  }
  /* With nothing selected this mode used to show only an instruction telling
   * you to go and do something in another mode first. Entry points are the
   * roots you would pick anyway, so start from the largest one. */
  container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading entry points…</div>';
  const res = await api('entry_points', { path: repoRoot() });
  container.innerHTML = '';
  if (res.error || !(res.entry_points || []).length) {
    const hint = document.createElement('div');
    hint.className = 'sym-search-count';
    hint.textContent = res.error
      || 'No entry points found. Pick a symbol in Tree, then choose Calls.';
    container.appendChild(hint);
    return;
  }
  const roots = res.entry_points.slice(0, CALLTREE_ROOTS);
  const title = document.createElement('div');
  title.className = 'obs-section-title';
  title.innerHTML = '<span>Call trees from entry points</span>'
    + '<span class="obs-section-count">' + roots.length
    + ' of ' + res.entry_points.length + '</span>';
  container.appendChild(title);

  // Fetched together rather than one after another: on a large repo the
  // sequential version left the panel blank for several seconds.
  const trees = await Promise.all(roots.map(
    symbol => api('call_tree', { path: repoRoot(), symbol_id: symbol.id }),
  ));
  for (const tree of trees) {
    if (tree.error || !tree.tree) continue;
    drawCallTreeNode(container, tree.tree, 0);
  }
}

function drawCallTreeNode(container, node, depth) {
  const row = document.createElement('div');
  row.className = 'sym-row calltree-row sym-' + node.kind;
  row.style.paddingLeft = (depth * 14 + 8) + 'px';

  const hasChildren = node.children && node.children.length > 0;
  const nodeId = node.id;
  const isOpen = callTreeExpanded.has(nodeId);

  if (hasChildren) {
    const chev = document.createElement('i');
    chev.className = isOpen ? 'bi bi-chevron-down sym-chev' : 'bi bi-chevron-right sym-chev';
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (callTreeExpanded.has(nodeId)) callTreeExpanded.delete(nodeId);
      else callTreeExpanded.add(nodeId);
      renderCallTreeMode();
    });
    row.appendChild(chev);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'sym-chev-spacer';
    row.appendChild(spacer);
  }

  const icon = document.createElement('i');
  icon.className = 'bi ' + kindIcon(node.kind) + ' sym-kind-icon';
  const name = document.createElement('span');
  name.className = 'sym-name';
  name.textContent = node.name;
  const mod = document.createElement('span');
  mod.className = 'sym-mod-parent';
  mod.textContent = node.module;
  row.append(icon, name, mod);

  if (node.truncated) {
    const trunc = document.createElement('span');
    trunc.className = 'sym-meta';
    trunc.textContent = '…';
    row.appendChild(trunc);
  }

  row.title = node.kind + ' ' + node.name + '\n' + node.module + ':' + node.line;
  row.addEventListener('click', () => openAtLine(node.module, node.line));
  container.appendChild(row);

  if (hasChildren && isOpen) {
    for (const child of node.children) {
      drawCallTreeNode(container, child, depth + 1);
    }
  }
}

// ---- Symbol details + navigation ----

async function selectSymbol(sid, name, kind) {
  const { module, line } = parseId(sid);
  openAtLine(module, line);
  showDetailsLoading(name, kind, module, line);
  const res = await api('symbol_details', { path: repoRoot(), symbol_id: sid });
  if (res.error) { showToast(res.error, 'error'); return; }
  showDetails(res);
}

async function openAtLine(relPath, line) {
  const full = absPath(relPath);
  const name = relPath.split('/').pop();
  if (openFileFn) await openFileFn(full, name);
  const setCursor = () => {
    if (state.cm && state.cmPath === full) {
      const pos = { line: Math.max(0, line - 1), ch: 0 };
      revealLine(line);
      state.cm.focus();
    }
  };
  setTimeout(setCursor, 60);
  setTimeout(setCursor, 200);
  setTimeout(setCursor, 400);
}

function showDetailsLoading(name, kind, module, line) {
  const panel = $('symbol-details');
  panel.hidden = false;
  $('structure-tree').hidden = true;
  panel.innerHTML = '';
  const back = document.createElement('button');
  back.className = 'sym-back';
  back.innerHTML = '<i class="bi bi-arrow-left"></i> Back';
  back.addEventListener('click', () => { panel.hidden = true; $('structure-tree').hidden = false; });
  const title = document.createElement('div');
  title.className = 'sym-detail-title';
  title.innerHTML = '<i class="bi ' + kindIcon(kind) + '"></i> <span>' + name + '</span>' +
    '<span class="sym-detail-kind">' + (kind || '') + '</span>';
  const loc = document.createElement('div');
  loc.className = 'sym-detail-loc';
  loc.textContent = module + ':' + line;
  const loading = document.createElement('div');
  loading.className = 'sym-detail-empty';
  loading.textContent = 'Loading details…';
  panel.append(back, title, loc, loading);
}

function showDetails(s) {
  const panel = $('symbol-details');
  panel.hidden = false;
  $('structure-tree').hidden = true;
  panel.innerHTML = '';

  const back = document.createElement('button');
  back.className = 'sym-back';
  back.innerHTML = '<i class="bi bi-arrow-left"></i> Back';
  back.addEventListener('click', () => { panel.hidden = true; $('structure-tree').hidden = false; });

  const title = document.createElement('div');
  title.className = 'sym-detail-title';
  title.innerHTML = '<i class="bi ' + kindIcon(s.kind) + '"></i> <span>' + s.name + '</span>' +
    '<span class="sym-detail-kind">' + s.kind + '</span>';
  const loc = document.createElement('div');
  loc.className = 'sym-detail-loc';
  loc.textContent = s.module + ':' + s.line;
  loc.addEventListener('click', () => openAtLine(s.module, s.line));

  const sig = document.createElement('div');
  sig.className = 'sym-detail-sig';
  sig.textContent = s.signature || '(no signature)';

  const stats = document.createElement('div');
  stats.className = 'sym-detail-stats';
  stats.innerHTML = '<span>' + s.size + ' lines</span><span>' + s.callees.length + ' callees</span><span>' + s.callers.length + ' callers</span>';

  panel.append(back, title, loc, sig, stats);

  // Call tree button
  if (s.callees.length > 0) {
    const ctBtn = document.createElement('button');
    ctBtn.className = 'sym-detail-calltree-btn';
    ctBtn.innerHTML = '<i class="bi bi-diagram-2"></i> View Call Tree';
    ctBtn.addEventListener('click', async () => {
      const res = await api('call_tree', { path: repoRoot(), symbol_id: s.id, max_depth: 5 });
      if (res.error) { showToast(res.error, 'error'); return; }
      callTreeData = res.tree;
      callTreeExpanded = new Set([s.id]);
      panel.hidden = true;
      $('structure-tree').hidden = false;
      setMode('calltree');
    });
    panel.appendChild(ctBtn);
  }

  panel.appendChild(detailList('Calls', s.callees));
  panel.appendChild(detailList('Called by', s.callers));
}

function detailList(label, refs) {
  const wrap = document.createElement('div');
  wrap.className = 'sym-detail-list';
  const h = document.createElement('div');
  h.className = 'sym-detail-list-title';
  h.textContent = label + ' (' + refs.length + ')';
  wrap.appendChild(h);
  if (!refs.length) {
    const empty = document.createElement('div');
    empty.className = 'sym-detail-empty';
    empty.textContent = '— none —';
    wrap.appendChild(empty);
    return wrap;
  }
  for (const r of refs) {
    const row = document.createElement('div');
    row.className = 'sym-detail-ref';
    row.innerHTML = '<i class="bi ' + kindIcon(r.kind) + '"></i> <span class="sym-ref-name">' + r.name + '</span>' +
      '<span class="sym-ref-loc">' + r.module + ':' + r.line + '</span>';
    row.title = r.kind + ' ' + r.name + ' · ' + r.module + ':' + r.line;
    row.addEventListener('click', () => selectSymbol(r.id, r.name, r.kind));
    wrap.appendChild(row);
  }
  return wrap;
}

// ---- init ----

export function resetStructure() {
  index = null;
  const tree = $('structure-tree');
  if (tree) tree.innerHTML = '';
  const details = $('symbol-details');
  if (details) details.hidden = true;
  const status = $('structure-status');
  if (status) status.textContent = 'No index — click build.';
  const search = $('symbol-search');
  if (search) search.value = '';
}

export function initStructure(openFile) {
  openFileFn = openFile;
  $('structure-build').addEventListener('click', buildStructure);
  $('structure-mode-tree').addEventListener('click', () => setMode('tree'));
  $('structure-mode-entry').addEventListener('click', () => setMode('entry'));
  $('structure-mode-calltree').addEventListener('click', () => setMode('calltree'));
  $('symbol-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (mode !== 'tree') setMode('tree');
      else renderTree();
    }, 200);
  });
}