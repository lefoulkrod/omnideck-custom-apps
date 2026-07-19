/* ===== Lightweight Source Control ===== */

import { state } from './state.js';
import { $ } from './dom.js';
import { api, showToast } from './api.js';

let repositoryRoot = '';
let openDiff = null;

function fullPath(relative) {
  return repositoryRoot.replace(/\/$/, '') + '/' + relative.replace(/^\//, '');
}

async function showDiff(file) {
  const target = fullPath(file.path);
  const originalTarget = file.original_path ? fullPath(file.original_path) : '';
  const result = await api('git_diff', {
    path: repositoryRoot,
    file_path: target,
    original_path: originalTarget,
  });
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }
  if (result.binary) {
    showToast('Binary files cannot be shown in the diff editor', 'info');
    return;
  }
  if (!openDiff) return;
  openDiff({
    name: file.path.split('/').pop(),
    path: result.path || file.path,
    sourcePath: target,
    repositoryRoot,
    status: file.status,
    original: result.original || '',
    modified: result.modified || '',
    unifiedDiff: result.diff || '',
    deleted: Boolean(result.deleted),
  });
}

function describeStatus(status) {
  if (status === '??') return 'Untracked';
  if (status.includes('R')) return 'Renamed';
  if (status.includes('D')) return 'Deleted';
  if (status.includes('A')) return 'Added';
  if (status.includes('M')) return 'Modified';
  return 'Changed';
}

function statusBadge(status) {
  if (status === '??') return 'U';
  if (status.includes('R')) return 'R';
  if (status.includes('D')) return 'D';
  if (status.includes('A')) return 'A';
  if (status.includes('M')) return 'M';
  return 'C';
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
  const group = document.createElement('div');
  group.className = 'source-group-title';
  group.textContent = `Changes ${result.count}`;
  container.appendChild(group);
  for (const file of result.files) {
    const row = document.createElement('button');
    row.className = 'source-file';
    const status = document.createElement('span');
    status.className = 'source-status';
    status.textContent = statusBadge(file.status);
    status.dataset.status = status.textContent;
    status.title = describeStatus(file.status);
    const details = document.createElement('span');
    details.className = 'source-file-details';
    const name = document.createElement('span');
    name.className = 'source-file-name';
    name.textContent = file.path.split('/').pop();
    const parent = document.createElement('span');
    parent.className = 'source-file-parent';
    parent.textContent = file.path.includes('/')
      ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
    details.append(name, parent);
    row.append(status, details);
    row.title = `${describeStatus(file.status)} · Open Changes`;
    row.onclick = () => showDiff(file);
    container.appendChild(row);
  }
}

export function initSourceControl(closeSidebar, openDiffFn) {
  openDiff = openDiffFn;
  $('source-refresh').addEventListener('click', refreshSourceControl);
  $('source-close').addEventListener('click', closeSidebar);
}
