/* ===== Context Menu ===== */

import { state } from './state.js';
import { dom } from './dom.js';

function renderContextMenu(x, y, items) {
  dom.contextMenu.innerHTML = '';

  for (const mi of items) {
    if (mi.sep) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      dom.contextMenu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'context-menu-item'
      + (mi.danger ? ' danger' : '')
      + (mi.disabled ? ' disabled' : '');
    el.innerHTML = `<span class="ctx-icon"><i class="bi ${mi.icon || ''}"></i></span><span class="ctx-label">${mi.label}</span>`;
    if (mi.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.className = 'ctx-shortcut';
      shortcut.textContent = mi.shortcut;
      el.appendChild(shortcut);
    }
    if (!mi.disabled) {
      el.onclick = () => {
        hideContextMenu();
        mi.action();
      };
    }
    dom.contextMenu.appendChild(el);
  }

  dom.contextMenu.style.left = x + 'px';
  dom.contextMenu.style.top = y + 'px';
  dom.contextMenu.classList.add('visible');

  // Adjust if off-screen
  const rect = dom.contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    dom.contextMenu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    dom.contextMenu.style.top = (window.innerHeight - rect.height - 4) + 'px';
  }
}

export function showContextMenu(x, y, item) {
  state.contextTarget = item;
  const isTab = item._isTab;
  const isDir = item.is_dir;
  const items = [];

  if (!isTab) {
    if (isDir) {
      items.push({ icon: 'bi-folder2-open', label: 'Open Folder', action: () => ctxDeps.navigateTo(item.path) });
      items.push({ icon: 'bi-collection', label: 'Open as Root', action: () => ctxDeps.openFolderAsRoot(item.path) });
      items.push({ sep: true });
      items.push({ icon: 'bi-file-earmark-plus', label: 'New File', action: () => ctxDeps.openNewFileModal(item.path) });
      items.push({ icon: 'bi-folder-plus', label: 'New Folder', action: () => ctxDeps.openNewFolderModal(item.path) });
    } else {
      items.push({ icon: 'bi-file-earmark', label: 'Open', action: () => ctxDeps.openFile(item.path, item.name) });
      items.push({ icon: 'bi-chat-left-text', label: 'Ask Omnideck About File', action: () => ctxDeps.askOmnideck(item.path) });
    }
    items.push({ sep: true });
    items.push({ icon: 'bi-pencil', label: 'Rename', action: () => ctxDeps.openRenameModal(item) });
    items.push({ icon: 'bi-clipboard', label: 'Copy Path', action: () => ctxDeps.copyPath(item.path, false) });
    items.push({ icon: 'bi-clipboard-check', label: 'Copy Relative Path', action: () => ctxDeps.copyPath(item.path, true) });
    if (isDir) {
      items.push({ icon: 'bi-terminal', label: 'Open in Terminal', action: () => ctxDeps.openInTerminal(item.path) });
    }
  } else {
    const tab = state.openTabs.get(item.path);
    items.push({ icon: 'bi-pin-angle', label: tab?.pinned ? 'Unpin Tab' : 'Pin Tab', action: () => ctxDeps.togglePinTab(item.path) });
    items.push({ sep: true });
    items.push({ icon: 'bi-file-earmark', label: 'Close Tab', action: () => ctxDeps.closeTab(item.path) });
    items.push({ icon: 'bi-files', label: 'Close Others', action: () => ctxDeps.closeOtherTabs(item.path) });
    items.push({ icon: 'bi-layout-sidebar-inset-reverse', label: 'Close to the Right', action: () => ctxDeps.closeTabsToRight(item.path) });
    items.push({ icon: 'bi-x-square', label: 'Close All', action: () => ctxDeps.closeAllTabs() });
    items.push({ sep: true });
    items.push({ icon: 'bi-folder-symlink', label: 'Reveal in Explorer', action: () => ctxDeps.revealPath(item.path) });
    items.push({ icon: 'bi-chat-left-text', label: 'Ask Omnideck About File', action: () => ctxDeps.askOmnideck(item.path) });
  }

  if (!isTab) {
    items.push({ sep: true });
    items.push({ icon: 'bi-trash', label: 'Delete', danger: true, action: () => ctxDeps.confirmDelete(item) });
  }
  renderContextMenu(x, y, items);
}

export function showEditorContextMenu(x, y) {
  const cm = state.cm;
  if (!cm || !state.activeTab) return;
  const hasSelection = Boolean(cm.getSelection());
  const history = cm.getDoc().historySize?.() || { undo: 0, redo: 0 };
  renderContextMenu(x, y, [
    { icon: 'bi-arrow-counterclockwise', label: 'Undo', shortcut: 'Ctrl+Z', disabled: !history.undo, action: () => cm.undo() },
    { icon: 'bi-arrow-clockwise', label: 'Redo', shortcut: 'Ctrl+Y', disabled: !history.redo, action: () => cm.redo() },
    { sep: true },
    { icon: 'bi-scissors', label: 'Cut', shortcut: 'Ctrl+X', disabled: !hasSelection, action: ctxDeps.editorCut },
    { icon: 'bi-clipboard', label: 'Copy', shortcut: 'Ctrl+C', disabled: !hasSelection, action: ctxDeps.editorCopy },
    { icon: 'bi-clipboard-plus', label: 'Paste', shortcut: 'Ctrl+V', action: ctxDeps.editorPaste },
    { icon: 'bi-textarea-t', label: 'Select All', shortcut: 'Ctrl+A', action: () => cm.execCommand('selectAll') },
    { sep: true },
    { icon: 'bi-terminal', label: 'Command Palette…', shortcut: 'Ctrl+Shift+P', action: ctxDeps.openCommandPalette },
    { icon: 'bi-braces', label: 'Format Document', shortcut: 'Shift+Alt+F', action: ctxDeps.formatDocument },
    { icon: 'bi-save', label: 'Save', shortcut: 'Ctrl+S', action: ctxDeps.saveFile },
    { sep: true },
    { icon: 'bi-chat-left-text', label: hasSelection ? 'Ask Omnideck About Selection' : 'Ask Omnideck About File', shortcut: 'Ctrl+Shift+A', action: ctxDeps.askOmnideck },
    { icon: 'bi-folder-symlink', label: 'Reveal in Explorer', action: () => ctxDeps.revealPath(state.activeTab) },
  ]);
}

export function hideContextMenu() {
  dom.contextMenu.classList.remove('visible');
  state.contextTarget = null;
}

export function initContextMenu() {
  document.addEventListener('click', (e) => {
    if (!dom.contextMenu.contains(e.target)) hideContextMenu();
  });
}

// These are set by main.js after all modules are loaded
// Use a mutable object so reassignments are visible to all callers
const ctxDeps = {
  navigateTo: null,
  openFolderAsRoot: null,
  openNewFileModal: null,
  openNewFolderModal: null,
  openFile: null,
  openRenameModal: null,
  closeTab: null,
  confirmDelete: null,
  copyPath: null,
  openInTerminal: null,
  togglePinTab: null,
  closeOtherTabs: null,
  closeTabsToRight: null,
  closeAllTabs: null,
  revealPath: null,
  askOmnideck: null,
  editorCut: null,
  editorCopy: null,
  editorPaste: null,
  openCommandPalette: null,
  formatDocument: null,
  saveFile: null,
};

export function setContextMenuDeps(deps) {
  Object.assign(ctxDeps, deps);
}
