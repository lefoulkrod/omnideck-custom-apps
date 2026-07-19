/* ===== Workspace Folder Picker ===== */

import { api, showToast } from './api.js';
import { basename, relativePath } from './breadcrumb.js';
import { dom } from './dom.js';
import { state } from './state.js';

let currentPath = '';
let parentPath = '';
let selectCallback = null;
let requestToken = 0;

function setLoading() {
  dom.folderPickerConfirm.disabled = true;
  dom.folderPickerList.innerHTML = '<div class="folder-picker-empty"><div class="spinner"></div>Loading folders…</div>';
}

async function navigate(path) {
  const token = ++requestToken;
  setLoading();
  const result = await api('list_dir_with_hidden', { path });
  if (token !== requestToken) return;
  if (result.error) {
    dom.folderPickerList.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'folder-picker-empty error';
    error.textContent = result.error;
    dom.folderPickerList.appendChild(error);
    return;
  }

  currentPath = result.path;
  parentPath = result.parent || '';
  dom.folderPickerPath.textContent = relativePath(currentPath);
  dom.folderPickerPath.title = currentPath;
  dom.folderPickerUp.disabled = !parentPath;
  dom.folderPickerConfirm.disabled = false;
  dom.folderPickerConfirm.textContent = `Open ${basename(currentPath) || 'Folder'}`;
  dom.folderPickerList.innerHTML = '';

  const folders = result.items.filter(item => item.is_dir);
  if (!folders.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-picker-empty';
    empty.textContent = 'No subfolders';
    dom.folderPickerList.appendChild(empty);
    return;
  }

  for (const folder of folders) {
    const row = document.createElement('button');
    row.className = 'folder-picker-row';
    row.type = 'button';
    row.title = `Browse ${folder.path}`;
    row.innerHTML = '<i class="bi bi-folder-fill"></i>';
    const name = document.createElement('span');
    name.textContent = folder.name;
    const arrow = document.createElement('i');
    arrow.className = 'bi bi-chevron-right';
    row.append(name, arrow);
    row.onclick = () => navigate(folder.path);
    dom.folderPickerList.appendChild(row);
  }
}

export function closeFolderPicker() {
  requestToken += 1;
  dom.folderPickerOverlay.classList.remove('visible');
  selectCallback = null;
}

export function openFolderPicker(startPath, callback) {
  selectCallback = callback;
  dom.folderPickerOverlay.classList.add('visible');
  navigate(startPath || state.rootDir || state.homePath);
}

export function initFolderPicker() {
  dom.folderPickerUp.addEventListener('click', () => {
    if (parentPath) navigate(parentPath);
  });
  dom.folderPickerHome.addEventListener('click', () => navigate(state.homePath));
  dom.folderPickerCancel.addEventListener('click', closeFolderPicker);
  dom.folderPickerConfirm.addEventListener('click', () => {
    const callback = selectCallback;
    const selected = currentPath;
    closeFolderPicker();
    if (callback && selected) {
      Promise.resolve(callback(selected)).catch(error => {
        showToast(error.message || String(error), 'error');
      });
    }
  });
  dom.folderPickerOverlay.addEventListener('click', event => {
    if (event.target === dom.folderPickerOverlay) closeFolderPicker();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dom.folderPickerOverlay.classList.contains('visible')) {
      event.preventDefault();
      closeFolderPicker();
    }
    if (event.key === 'Backspace' && dom.folderPickerOverlay.classList.contains('visible')) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (parentPath) {
        event.preventDefault();
        navigate(parentPath);
      }
    }
  });
}
