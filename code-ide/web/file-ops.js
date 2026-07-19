/* ===== File Operations: Save, Status, Reload, Disk Polling ===== */

import { state } from './state.js';
import { dom } from './dom.js';
import { api, showToast } from './api.js';
import { relativePath } from './breadcrumb.js';

function setSaveStatus(text, cls) {
  dom.statusSave.innerHTML = '';
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  dom.statusSave.appendChild(span);
}

export function updateStatus() {
  const saveButton = document.getElementById('btn-save');
  if (!state.activeTab) {
    if (saveButton) saveButton.disabled = true;
    dom.statusPath.replaceChildren();
    const icon = document.createElement('i');
    icon.className = 'bi bi-file-earmark';
    dom.statusPath.append(icon, document.createTextNode(' No file open'));
    dom.statusLines.textContent = '0 lines';
    dom.statusLang.textContent = 'Plain Text';
    setSaveStatus('Ready', 'saved');
    return;
  }
  const tab = state.openTabs.get(state.activeTab);
  if (!tab) return;
  if (saveButton) saveButton.disabled = Boolean(tab.isPreview || tab.isDiff);
  const lines = tab.content.split('\n').length;
  dom.statusPath.replaceChildren();
  const icon = document.createElement('i');
  icon.className = 'bi bi-file-earmark';
  dom.statusPath.append(
    icon,
    document.createTextNode(` ${relativePath(tab.sourcePath || state.activeTab)}`),
  );
  dom.statusLines.textContent = `${lines} lines`;
  dom.statusLang.textContent = tab.lang;
  if (tab.stale === 'deleted') {
    setSaveStatus('⚠ Deleted on disk', 'error');
  } else if (tab.stale === 'changed') {
    setSaveStatus('↻ Changed on disk', 'warning');
  } else if (tab.dirty) {
    setSaveStatus('● Unsaved', 'unsaved');
  } else {
    setSaveStatus(tab.isDiff ? 'Git diff' : tab.isPreview ? 'Preview' : '✓ Saved', 'saved');
  }
}

export async function saveCurrentFile(renderTabsFn, renderEditorFn, path = state.activeTab, force = false) {
  if (!path) {
    showToast('No file open', 'info');
    return;
  }
  const tab = state.openTabs.get(path);
  if (!tab) return;
  if (tab.isPreview || tab.isDiff) {
    showToast(tab.isDiff ? 'Diff editors are read-only' : 'Preview files are read-only', 'info');
    return;
  }

  setSaveStatus('Saving...', 'unsaved');

  const params = { path, content: tab.content };
  if (!force && tab.diskModified) params.expected_modified = tab.diskModified;
  const result = await api('write_file', params);
  if (result.error) {
    showToast(result.error, 'error');
    if (result.conflict) tab.stale = result.error.includes('deleted') ? 'deleted' : 'changed';
    setSaveStatus('Save failed', 'error');
    renderTabsFn();
    if (path === state.activeTab && result.conflict) renderEditorFn();
    return;
  }

  tab.originalContent = tab.content;
  tab.dirty = false;
  tab.stale = false;
  tab.diskModified = result.modified || 0;
  renderTabsFn();
  if (path === state.activeTab) updateStatus();
  showToast(`Saved ${tab.name}`, 'success');
}

export async function reloadFile(path, renderTabsFn, renderEditorFn) {
  const tab = state.openTabs.get(path);
  if (!tab) return;

  const result = tab.isPreview
    ? await api('stat_file', { path })
    : await api('read_file', { path });
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }

  if (!tab.isPreview) {
    tab.content = result.content;
    tab.originalContent = result.content;
    tab.doc = null;
  } else {
    tab.previewVersion = Date.now();
  }
  tab.dirty = false;
  tab.stale = false;
  tab.diskModified = result.modified || 0;

  renderTabsFn();
  if (path === state.activeTab) {
    renderEditorFn();
  }
  updateStatus();
  showToast(`Reloaded ${tab.name}`, 'success');
}

export async function pollDiskChanges(renderEditorFn, renderTabsFn) {
  if (state.openTabs.size === 0) return;

  const paths = [...state.openTabs.entries()]
    .filter(([, tab]) => !tab.isDiff)
    .map(([path]) => path);
  if (!paths.length) return;
  const batch = await api('stat_files', { paths });
  if (batch.error) return;
  for (const path of paths) {
    const tab = state.openTabs.get(path);
    if (!tab) continue;

    const result = batch.items?.[path];
    if (!result) continue;
    if (result.error) continue;

    // File deleted on disk
    if (result.exists === false) {
      if (!tab.stale) {
        tab.stale = 'deleted';
        if (path === state.activeTab) renderEditorFn();
        renderTabsFn();
        updateStatus();
      }
      continue;
    }

    // Check if mtime changed
    if (tab.diskModified && result.modified && result.modified !== tab.diskModified) {
      if (!tab.stale) {
        tab.stale = 'changed';
        if (path === state.activeTab) renderEditorFn();
        renderTabsFn();
        updateStatus();
      }
    }
  }
}
