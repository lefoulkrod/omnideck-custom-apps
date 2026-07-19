/* ===== Tab Management ===== */

import { state } from './state.js';
import { dom } from './dom.js';
import { api, showToast } from './api.js';
import { getFileIcon } from './icons.js';
import { isPreviewable } from './preview.js';

export function renderTabs(showContextMenuFn, closeTabFn, activateTabFn, saveStateFn = () => {}) {
  dom.tabBar.innerHTML = '';
  for (const [path, tab] of state.openTabs) {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab' + (path === state.activeTab ? ' active' : '') + (tab.stale ? ' stale' : '');
    tabEl.dataset.path = path;

    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.innerHTML = `<i class="bi ${tab.icon} ${tab.iconCls}"></i>`;
    tabEl.appendChild(icon);

    if (tab.pinned) {
      const pin = document.createElement('span');
      pin.className = 'tab-pin';
      pin.innerHTML = '<i class="bi bi-pin-angle-fill"></i>';
      tabEl.appendChild(pin);
    }

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tab.name;
    tabEl.appendChild(name);

    // Dirty indicator (small dot, like VS Code)
    if (tab.dirty) {
      const dot = document.createElement('span');
      dot.className = 'tab-dirty';
      tabEl.appendChild(dot);
    }

    // Close button — always visible, like VS Code
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.innerHTML = '<i class="bi bi-x"></i>';
    close.onclick = (e) => { e.stopPropagation(); e.preventDefault(); closeTabFn(path); };
    close.onmousedown = (e) => { e.stopPropagation(); };
    tabEl.appendChild(close);

    // Middle-click to close (like VS Code)
    tabEl.onmousedown = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTabFn(path);
      }
    };

    tabEl.onclick = () => activateTabFn(path);
    tabEl.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenuFn(e.clientX, e.clientY, { path, name: tab.name, is_dir: false, _isTab: true });
    };

    tabEl.draggable = true;
    tabEl.ondragstart = (e) => {
      e.dataTransfer.setData('text/x-code-ide-tab', path);
      e.dataTransfer.effectAllowed = 'move';
    };
    tabEl.ondragover = (e) => {
      if (e.dataTransfer.types.includes('text/x-code-ide-tab')) e.preventDefault();
    };
    tabEl.ondrop = (e) => {
      e.preventDefault();
      const source = e.dataTransfer.getData('text/x-code-ide-tab');
      if (source && source !== path) {
        reorderTab(source, path);
        renderTabs(showContextMenuFn, closeTabFn, activateTabFn, saveStateFn);
        saveStateFn();
      }
    };

    dom.tabBar.appendChild(tabEl);
  }
}

export function reorderTab(sourcePath, targetPath) {
  const entries = [...state.openTabs.entries()];
  const sourceIndex = entries.findIndex(([path]) => path === sourcePath);
  const targetIndex = entries.findIndex(([path]) => path === targetPath);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [entry] = entries.splice(sourceIndex, 1);
  entries.splice(targetIndex, 0, entry);
  state.openTabs = new Map(entries);
}

export function togglePinTab(path) {
  const tab = state.openTabs.get(path);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  const pinned = [...state.openTabs.entries()].filter(([, value]) => value.pinned);
  const regular = [...state.openTabs.entries()].filter(([, value]) => !value.pinned);
  state.openTabs = new Map([...pinned, ...regular]);
}

export function activateTab(path, renderTabsFn, renderEditorFn, updateStatusFn, saveStateFn) {
  state.activeTab = path;
  renderTabsFn();
  renderEditorFn();
  updateStatusFn();
  saveStateFn();
}

export function closeTab(path, openConfirmDialogFn, doCloseTabFn) {
  const tab = state.openTabs.get(path);
  if (tab && tab.dirty) {
    openConfirmDialogFn(
      'Unsaved Changes',
      `'${tab.name}' has unsaved changes. Close anyway?`,
      'Close Anyway',
      (confirmed) => {
        if (confirmed) doCloseTabFn(path);
      }
    );
    return;
  }
  doCloseTabFn(path);
}

export function doCloseTab(path, activateTabFn, renderTabsFn, renderEditorFn, updateStatusFn, saveStateFn) {
  state.openTabs.delete(path);
  if (state.activeTab === path) {
    // Activate next tab or show welcome
    const remaining = [...state.openTabs.keys()];
    if (remaining.length > 0) {
      activateTabFn(remaining[remaining.length - 1]);
    } else {
      state.activeTab = null;
      renderTabsFn();
      renderEditorFn();
      updateStatusFn();
    }
  } else {
    renderTabsFn();
  }
  saveStateFn();
}

export async function openFile(path, name, renderTabsFn, activateTabFn, saveStateFn) {
  const requestToken = ++state.openRequestToken;
  // If already open, just activate
  if (state.openTabs.has(path)) {
    if (requestToken === state.openRequestToken) activateTabFn(path);
    return;
  }

  // Check if it's a previewable file type
  const previewType = isPreviewable(name);
  if (previewType) {
    const stat = await api('stat_file', { path });
    if (stat.error || !stat.exists) {
      showToast(stat.error || 'File does not exist', 'error');
      return;
    }
    const fi = getFileIcon(name);
    state.openTabs.set(path, {
      name: name,
      content: '',
      originalContent: '',
      dirty: false,
      stale: false,
      diskModified: stat.modified || 0,
      lang: fi.lang,
      icon: fi.icon,
      iconCls: fi.cls,
      isPreview: true,
    });
    renderTabsFn();
    if (requestToken === state.openRequestToken) activateTabFn(path);
    saveStateFn();
    return;
  }

  const result = await api('read_file', { path });
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }

  const fi = getFileIcon(name);
  state.openTabs.set(path, {
    name: name,
    content: result.content,
    originalContent: result.content,
    dirty: false,
    stale: false,
    diskModified: result.modified || 0,
    lang: fi.lang,
    icon: fi.icon,
    iconCls: fi.cls,
  });

  renderTabsFn();
  if (requestToken === state.openRequestToken) activateTabFn(path);
  saveStateFn();
}

export function openDiff(diff, renderTabsFn, activateTabFn, saveStateFn) {
  const id = `git-diff:${encodeURIComponent(diff.repositoryRoot)}:${encodeURIComponent(diff.path)}`;
  const fi = getFileIcon(diff.path);
  state.openTabs.set(id, {
    name: `${diff.name} (Working Tree)`,
    content: diff.modified,
    originalContent: diff.modified,
    baseContent: diff.original,
    unifiedDiff: diff.unifiedDiff || '',
    dirty: false,
    stale: false,
    lang: fi.lang,
    icon: 'bi-file-diff',
    iconCls: fi.cls,
    isDiff: true,
    sourcePath: diff.sourcePath,
    repositoryRoot: diff.repositoryRoot,
    relativePath: diff.path,
    status: diff.status,
    deleted: diff.deleted,
  });
  renderTabsFn();
  activateTabFn(id);
  saveStateFn();
}
