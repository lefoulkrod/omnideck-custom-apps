/* ===== Quick Open & Command Palette ===== */

import { state } from './state.js';
import { dom } from './dom.js';
import { api } from './api.js';
import { basename, relativePath } from './breadcrumb.js';
import { getFileIcon } from './icons.js';

let mode = 'files';
let commands = [];
let selectedIndex = 0;
let sequence = 0;
let openFile = null;
let openFolder = null;

function closeQuick() {
  sequence += 1;
  dom.quickOverlay.classList.remove('visible');
  dom.quickResults.innerHTML = '';
}

function select(index) {
  const rows = [...dom.quickResults.querySelectorAll('.quick-result')];
  if (!rows.length) return;
  selectedIndex = Math.max(0, Math.min(rows.length - 1, index));
  rows.forEach((row, i) => row.classList.toggle('selected', i === selectedIndex));
  rows[selectedIndex].scrollIntoView({ block: 'nearest' });
}

function addResult(iconClass, label, detail, action) {
  const row = document.createElement('div');
  row.className = 'quick-result';
  const icon = document.createElement('i');
  icon.className = `bi ${iconClass}`;
  const text = document.createElement('span');
  text.className = 'quick-result-label';
  text.textContent = label;
  const hint = document.createElement('span');
  hint.className = 'quick-result-detail';
  hint.textContent = detail || '';
  row.append(icon, text, hint);
  row.onclick = () => {
    closeQuick();
    action();
  };
  dom.quickResults.appendChild(row);
}

function renderCommands(query) {
  dom.quickResults.innerHTML = '';
  const needle = query.toLowerCase();
  commands
    .filter(command => `${command.label} ${command.detail || ''}`.toLowerCase().includes(needle))
    .forEach(command => addResult(
      command.icon || 'bi-terminal', command.label, command.detail, command.action,
    ));
  select(0);
}

async function renderFiles(query) {
  const request = ++sequence;
  dom.quickResults.innerHTML = '';
  if (!query) {
    for (const path of state.recentRoots) {
      addResult('bi-folder2-open', `Recent: ${basename(path)}`, path, () => openFolder(path));
    }
    for (const [path, tab] of state.openTabs) {
      addResult(tab.icon || 'bi-file-earmark', tab.name, relativePath(path), () => openFile(path, tab.name));
    }
    select(0);
    return;
  }
  const result = await api('search_files', {
    path: state.rootDir || state.homePath,
    query,
    limit: 100,
    show_hidden: state.showHidden,
  });
  if (request !== sequence || result.error) return;
  for (const item of result.results || []) {
    if (item.is_dir) continue;
    const fileIcon = getFileIcon(item.name);
    addResult(fileIcon.icon, item.name, item.rel_path, () => openFile(item.path, item.name));
  }
  select(0);
}

function open(modeName) {
  mode = modeName;
  selectedIndex = 0;
  dom.quickInput.value = '';
  dom.quickInput.placeholder = mode === 'commands'
    ? 'Type a command'
    : 'Go to File (Ctrl+P)';
  dom.quickOverlay.classList.add('visible');
  if (mode === 'commands') renderCommands('');
  else renderFiles('');
  setTimeout(() => dom.quickInput.focus(), 0);
}

export function openQuickOpen() { open('files'); }
export function openCommandPalette() { open('commands'); }

export function initQuickOpen(options) {
  openFile = options.openFile;
  openFolder = options.openFolder;
  commands = options.commands;

  dom.quickInput.addEventListener('input', () => {
    if (mode === 'commands') renderCommands(dom.quickInput.value);
    else renderFiles(dom.quickInput.value);
  });
  dom.quickInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeQuick();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      select(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = dom.quickResults.querySelectorAll('.quick-result')[selectedIndex];
      row?.click();
    }
  });
  dom.quickOverlay.addEventListener('mousedown', (event) => {
    if (event.target === dom.quickOverlay) closeQuick();
  });
}
