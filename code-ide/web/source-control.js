/* ===== Lightweight Source Control ===== */

import { state } from './state.js';
import { $ } from './dom.js';
import { api } from './api.js';

let repositoryRoot = '';

function fullPath(relative) {
  return repositoryRoot.replace(/\/$/, '') + '/' + relative.replace(/^\//, '');
}

async function showDiff(file) {
  const target = fullPath(file.path);
  const result = await api('git_diff', { path: repositoryRoot, file_path: target });
  let diff = result.diff || '';
  if (!diff && file.status.includes('?')) {
    const read = await api('read_file', { path: target });
    if (!read.error) diff = `Untracked file: ${file.path}\n\n${read.content}`;
  }
  const files = $('source-files');
  files.innerHTML = '';
  const back = document.createElement('button');
  back.className = 'btn source-back';
  back.textContent = '← Changes';
  back.onclick = refreshSourceControl;
  const pre = document.createElement('pre');
  pre.className = 'source-diff';
  pre.textContent = diff || 'No unstaged diff for this file.';
  files.append(back, pre);
}

export async function refreshSourceControl() {
  $('source-branch').textContent = 'Loading…';
  $('source-files').innerHTML = '';
  const result = await api('git_status', { path: state.rootDir || state.homePath });
  if (result.error) {
    $('source-branch').textContent = result.error;
    return;
  }
  repositoryRoot = result.root;
  $('source-branch').textContent = `${result.branch || 'Repository'} · ${result.count} change${result.count === 1 ? '' : 's'}`;
  const container = $('source-files');
  if (!result.files.length) {
    const clean = document.createElement('div');
    clean.className = 'source-empty';
    clean.textContent = 'Working tree clean';
    container.appendChild(clean);
    return;
  }
  for (const file of result.files) {
    const row = document.createElement('button');
    row.className = 'source-file';
    const status = document.createElement('span');
    status.className = 'source-status';
    status.textContent = file.status.trim() || 'M';
    const name = document.createElement('span');
    name.textContent = file.path;
    row.append(status, name);
    row.onclick = () => showDiff(file);
    container.appendChild(row);
  }
}

export function initSourceControl(closeSidebar) {
  $('source-refresh').addEventListener('click', refreshSourceControl);
  $('source-close').addEventListener('click', closeSidebar);
}
