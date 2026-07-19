/* ===== Modals & Confirm Dialogs ===== */

import { state } from './state.js';
import { dom } from './dom.js';
import { api, showToast } from './api.js';
import {
  optimisticAdd, optimisticRemove, optimisticRename, isSameOrDescendant,
} from './tree.js';

let modalCallback = null;

function validName(name) {
  return Boolean(name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name));
}

export function openModal(title, label, placeholder, confirmText, callback) {
  dom.modalTitle.textContent = title;
  dom.modalLabel.textContent = label;
  dom.modalInput.placeholder = placeholder;
  dom.modalInput.value = '';
  dom.modalConfirm.textContent = confirmText;
  modalCallback = callback;
  dom.modalOverlay.classList.add('visible');
  setTimeout(() => dom.modalInput.focus(), 50);
}

export function closeModal() {
  dom.modalOverlay.classList.remove('visible');
  modalCallback = null;
}

// ===== Confirm Dialog (yes/no, no text input) =====
let confirmCallback = null;

export function openConfirmDialog(title, message, yesText, callback) {
  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmYes.textContent = yesText;
  confirmCallback = callback;
  dom.confirmOverlay.classList.add('visible');
  setTimeout(() => dom.confirmYes.focus(), 0);
}

export function closeConfirmDialog() {
  dom.confirmOverlay.classList.remove('visible');
  confirmCallback = null;
}

export function openNewFileModal(basePath) {
  openModal('New File', 'File name:', 'filename.ext', 'Create', async (name) => {
    if (!validName(name)) {
      showToast('Enter a single valid file name', 'error');
      return;
    }
    const fullPath = basePath + '/' + name;
    const result = await api('create_file', { path: fullPath, content: '' });
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast('File created', 'success');
    optimisticAdd(basePath, name, false);
    modalDeps.openFile(fullPath, name);
    modalDeps.saveState();
  });
}

export function openNewFolderModal(basePath) {
  openModal('New Folder', 'Folder name:', 'folder-name', 'Create', async (name) => {
    if (!validName(name)) {
      showToast('Enter a single valid folder name', 'error');
      return;
    }
    const fullPath = basePath + '/' + name;
    const result = await api('create_folder', { path: fullPath });
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast('Folder created', 'success');
    optimisticAdd(basePath, name, true);
    modalDeps.saveState();
  });
}

export function openRenameModal(item) {
  openModal('Rename', 'New name:', item.name, 'Rename', async (name) => {
    if (name === item.name) return;
    if (!validName(name)) {
      showToast('Enter a single valid name', 'error');
      return;
    }
    const result = await api('rename_path', { old_path: item.path, new_name: name });
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast('Renamed', 'success');
    optimisticRename(item.path, name);
    modalDeps.renderTabs();
    modalDeps.renderEditor();
    modalDeps.updateStatus();
    modalDeps.saveState();
  });
  dom.modalInput.value = item.name;
  setTimeout(() => dom.modalInput.select(), 60);
}

export async function confirmDelete(item) {
  const affectedTabs = [...state.openTabs.keys()]
    .filter(path => isSameOrDescendant(path, item.path));
  const dirtyCount = affectedTabs
    .filter(path => state.openTabs.get(path)?.dirty).length;
  const dirtyWarning = dirtyCount
    ? ` ${dirtyCount} affected tab${dirtyCount === 1 ? '' : 's'} contain unsaved changes.`
    : '';
  openConfirmDialog(
    'Delete',
    `Delete '${item.name}'? This cannot be undone.${dirtyWarning}`,
    'Delete',
    async (confirmed) => {
      if (!confirmed) return;
      const result = await api('delete_path', { path: item.path });
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      showToast('Deleted', 'success');
      for (const path of affectedTabs) modalDeps.doCloseTab(path);
      optimisticRemove(item.path);
      modalDeps.saveState();
    }
  );
}

export function triggerModalConfirm() {
  const val = dom.modalInput.value.trim();
  if (modalCallback) modalCallback(val);
  closeModal();
}

export function triggerConfirmYes() {
  if (confirmCallback) confirmCallback(true);
  closeConfirmDialog();
}

export function triggerConfirmNo() {
  if (confirmCallback) confirmCallback(false);
  closeConfirmDialog();
}

export function initModals() {
  // Modal input keydown
  dom.modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerModalConfirm();
    }
    if (e.key === 'Escape') {
      closeModal();
    }
  });

  // Modal overlay click
  dom.modalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.modalOverlay) closeModal();
  });

  // Confirm overlay click
  dom.confirmOverlay.addEventListener('click', (e) => {
    if (e.target === dom.confirmOverlay) {
      triggerConfirmNo();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.confirmOverlay.classList.contains('visible')) {
      e.preventDefault();
      triggerConfirmNo();
    }
  });
}

// These are set by main.js after all modules are loaded
// Use a mutable object so reassignments are visible to all callers
const modalDeps = {
  refreshTree: null,
  openFile: null,
  renderTabs: null,
  renderEditor: null,
  updateStatus: null,
  doCloseTab: null,
  saveState: () => {},
};

export function setModalsDeps(deps) {
  Object.assign(modalDeps, deps);
}
