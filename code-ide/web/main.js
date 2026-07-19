/* ===== Code IDE — Main Entry Point ===== */

import {
  state, saveState, saveStateImmediate, loadState, hasDirtyTabs,
} from './state.js';
import { dom, initDom } from './dom.js';
import { api, showToast } from './api.js';
import { basename } from './breadcrumb.js';
import { renderBreadcrumb } from './breadcrumb.js';

// Tree
import {
  loadDir, navigateTo, openFolderAsRoot, goHome,
  renderTree,
  refreshTree as treeRefreshTree,
  setTreeDeps, collapseAllDirs, toggleHiddenFiles, revealPath, initTreeKeyboard,
} from './tree.js';

// Tabs
import {
  openFile as tabsOpenFile,
  closeTab as tabsCloseTab,
  doCloseTab as tabsDoCloseTab,
  activateTab as tabsActivateTab,
  renderTabs as tabsRenderTabs,
  togglePinTab,
} from './tabs.js';

// Editor
import {
  renderEditor as editorRenderEditor, getEditorSelection, captureEditorState,
} from './editor.js';

// File ops
import {
  saveCurrentFile as fileSaveCurrentFile,
  updateStatus as fileUpdateStatus,
  reloadFile as fileReloadFile,
  pollDiskChanges,
} from './file-ops.js';

// Terminal
import {
  termState, updatePrompt,
  collapseTerminal, hideTerminal, showTerminal, toggleTerminal,
  maximizeTerminal, initTerminal,
} from './terminal.js';

// Sidebar
import {
  toggleSidebar, toggleSidebarView, setSidebarView, initSidebar,
} from './sidebar.js';

// Context menu
import {
  showContextMenu, hideContextMenu, initContextMenu,
  setContextMenuDeps,
} from './context-menu.js';

// Modals
import {
  openModal, closeModal, openConfirmDialog, closeConfirmDialog,
  openNewFileModal, openNewFolderModal, openRenameModal, confirmDelete,
  initModals, setModalsDeps,
  triggerModalConfirm, triggerConfirmYes, triggerConfirmNo,
} from './modals.js';

// Keyboard
import { initKeyboard } from './keyboard.js';

// Search
import { initSearch } from './search.js';
import {
  initQuickOpen, openQuickOpen, openCommandPalette,
} from './quick-open.js';
import { initSettings, openSettings } from './settings.js';
import {
  initSourceControl, refreshSourceControl,
} from './source-control.js';

// ===== Wire up cross-module dependencies =====

// Create bound versions of functions that close over the wiring
function saveStateBound() { saveState(api, dom, termState); }
function toggleExplorerBound() {
  toggleSidebarView('explorer', saveStateBound);
}
async function toggleSourceControlBound() {
  const opened = toggleSidebarView('source-control', saveStateBound);
  if (opened) await refreshSourceControl();
}
async function showSourceControlBound() {
  setSidebarView('source-control');
  dom.sidebar.classList.remove('hidden');
  dom.resizer.classList.remove('hidden');
  saveStateBound();
  await refreshSourceControl();
}

// Tabs: create bound versions
function renderTabsBound() {
  tabsRenderTabs(showContextMenu, closeTabBound, activateTabBound, saveStateBound);
}
function activateTabBound(path) {
  tabsActivateTab(path, renderTabsBound, renderEditorBound, fileUpdateStatus, saveStateBound);
}
function closeTabBound(path) {
  tabsCloseTab(path, openConfirmDialog, doCloseTabBound);
}
function doCloseTabBound(path) {
  tabsDoCloseTab(path, activateTabBound, renderTabsBound, renderEditorBound, fileUpdateStatus, saveStateBound);
}
function openFileBound(path, name) {
  return tabsOpenFile(path, name, renderTabsBound, activateTabBound, saveStateBound);
}

// Editor: create bound version
function renderEditorBound() {
  editorRenderEditor(
    saveCurrentFileBound, closeTabBound, reloadFileBound,
    fileUpdateStatus, renderTabsBound, saveStateBound,
  );
}

// File ops: create bound versions
function saveCurrentFileBound(path = state.activeTab, force = false) {
  return fileSaveCurrentFile(renderTabsBound, renderEditorBound, path, force);
}
function reloadFileBound(path) {
  return fileReloadFile(path, renderTabsBound, renderEditorBound);
}

// Tree: create bound versions
function navigateToBound(path) {
  return navigateTo(path, goHomeBound);
}
function goHomeBound() {
  goHome(navigateToBound, updatePrompt, saveStateBound);
  updatePrompt();
  termState.cwd = state.homePath;
}
function openFolderAsRootBound(path) {
  if (path && path !== state.homePath) {
    state.recentRoots = [path, ...state.recentRoots.filter(root => root !== path)].slice(0, 10);
  }
  termState.cwd = path;
  updatePrompt();
  return openFolderAsRoot(path, updatePrompt, saveStateBound, goHomeBound);
}
function refreshTreeBound() {
  return treeRefreshTree();
}

function togglePinTabBound(path) {
  togglePinTab(path);
  renderTabsBound();
  saveStateBound();
}

function closeTabPaths(paths) {
  const existing = paths.filter(path => state.openTabs.has(path));
  if (!existing.length) return;
  const dirty = existing.filter(path => state.openTabs.get(path)?.dirty);
  const close = () => existing.forEach(path => doCloseTabBound(path));
  if (!dirty.length) {
    close();
    return;
  }
  openConfirmDialog(
    'Unsaved Changes',
    `${dirty.length} tab${dirty.length === 1 ? '' : 's'} contain unsaved changes. Close them anyway?`,
    'Close Tabs',
    confirmed => { if (confirmed) close(); },
  );
}

function closeAllTabsBound() {
  closeTabPaths([...state.openTabs.keys()]);
}

function closeOtherTabsBound(path) {
  closeTabPaths([...state.openTabs.entries()]
    .filter(([candidate, tab]) => candidate !== path && !tab.pinned)
    .map(([candidate]) => candidate));
}

function closeTabsToRightBound(path) {
  const paths = [...state.openTabs.keys()];
  closeTabPaths(paths.slice(paths.indexOf(path) + 1)
    .filter(candidate => !state.openTabs.get(candidate)?.pinned));
}

async function copyPathBound(path, relative = false) {
  const value = relative && path.startsWith(state.rootDir + '/')
    ? path.substring(state.rootDir.length + 1) : path;
  try {
    await navigator.clipboard.writeText(value);
    showToast(relative ? 'Relative path copied' : 'Path copied', 'success');
  } catch {
    showToast(value, 'info');
  }
}

function openInTerminalBound(path) {
  termState.cwd = path;
  updatePrompt();
  showTerminal(saveStateBound);
  saveStateBound();
}

function askOmnideckBound(path = state.activeTab) {
  const tab = path ? state.openTabs.get(path) : null;
  const selection = path === state.activeTab ? getEditorSelection() : '';
  if (!window.omnideck?.chat?.compose) {
    showToast('Omnideck chat bridge is unavailable', 'error');
    return;
  }
  window.omnideck.chat.compose({
    text: selection
      ? `Help me with this selection from ${path}:\n\n${selection}`
      : `Help me review or improve ${path || 'the current workspace'}.`,
    context: {
      path,
      language: tab?.lang || null,
      selection: selection || null,
      content: selection ? null : tab?.content?.slice(0, 20000) || null,
    },
  });
}

async function formatCurrentFileBound() {
  const tab = state.activeTab ? state.openTabs.get(state.activeTab) : null;
  if (!tab || tab.isPreview) return;
  captureEditorState();
  const result = await api('format_content', { content: tab.content, language: tab.lang });
  if (result.error) {
    showToast(result.error, 'error');
    return;
  }
  if (state.cm && state.cmPath === state.activeTab) state.cm.setValue(result.content);
  else {
    tab.content = result.content;
    tab.dirty = tab.content !== tab.originalContent;
    tab.doc = null;
    renderEditorBound();
  }
  showToast(`Formatted ${tab.name}`, 'success');
}

// Terminal: create bound versions
function collapseTerminalBound() { collapseTerminal(saveStateBound); }
function hideTerminalBound() { hideTerminal(saveStateBound); }
function toggleTerminalBound() { toggleTerminal(saveStateBound); }
function maximizeTerminalBound() { maximizeTerminal(saveStateBound); }

// Sidebar: create bound version
function toggleSidebarBound() { toggleSidebar(saveStateBound); }

// ===== Set cross-module dependencies =====

// Tree needs: openFile, showContextMenu, openNewFileModal, openNewFolderModal, confirmDelete
setTreeDeps({
  openFile: openFileBound,
  showContextMenu,
  openNewFileModal,
  openNewFolderModal,
  confirmDelete,
  saveState: saveStateBound,
});

// Context menu needs: navigateTo, openFolderAsRoot, openNewFileModal, openNewFolderModal,
//   openFile, openRenameModal, closeTab, confirmDelete
setContextMenuDeps({
  navigateTo: navigateToBound,
  openFolderAsRoot: openFolderAsRootBound,
  openNewFileModal,
  openNewFolderModal,
  openFile: openFileBound,
  openRenameModal,
  closeTab: closeTabBound,
  confirmDelete,
  copyPath: copyPathBound,
  openInTerminal: openInTerminalBound,
  togglePinTab: togglePinTabBound,
  closeOtherTabs: closeOtherTabsBound,
  closeTabsToRight: closeTabsToRightBound,
  closeAllTabs: closeAllTabsBound,
  revealPath,
  askOmnideck: askOmnideckBound,
});

// Modals need: refreshTree, openFile, renderTabs, renderEditor, updateStatus, doCloseTab
setModalsDeps({
  refreshTree: refreshTreeBound,
  openFile: openFileBound,
  renderTabs: renderTabsBound,
  renderEditor: renderEditorBound,
  updateStatus: fileUpdateStatus,
  doCloseTab: doCloseTabBound,
  saveState: saveStateBound,
});

// ===== Button binding helper =====
function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', (e) => { e.stopPropagation(); state.userInteracted = true; handler(); });
}

// ===== Init =====
async function init() {
  initDom();

  // Set up event listeners for sidebar, keyboard, context menu, modals, terminal
  initSidebar(saveStateBound);
  initKeyboard(
    saveCurrentFileBound, toggleSidebarBound, closeTabBound, toggleTerminalBound,
    openQuickOpen, openCommandPalette, formatCurrentFileBound, askOmnideckBound,
  );
  initContextMenu();
  initModals();
  initTerminal(saveStateBound);
  initSearch(openFileBound, navigateToBound, refreshTreeBound);
  initTreeKeyboard();
  initSettings(renderEditorBound, saveStateBound);
  initSourceControl(toggleSidebarBound);
  initQuickOpen({
    openFile: openFileBound,
    openFolder: openFolderAsRootBound,
    commands: [
      { label: 'File: Save', detail: 'Ctrl+S', icon: 'bi-save', action: saveCurrentFileBound },
      { label: 'File: Format Document', detail: 'Shift+Alt+F', icon: 'bi-braces', action: formatCurrentFileBound },
      { label: 'File: Close All Editors', icon: 'bi-x-square', action: closeAllTabsBound },
      { label: 'Explorer: Collapse All Folders', icon: 'bi-arrows-collapse', action: collapseAllDirs },
      { label: 'Explorer: Toggle Hidden Files', icon: 'bi-eye-slash', action: () => toggleHiddenFiles() },
      { label: 'Explorer: Reveal Active File', icon: 'bi-folder-symlink', action: () => revealPath(state.activeTab) },
      { label: 'View: Toggle Terminal', detail: 'Ctrl+`', icon: 'bi-terminal', action: toggleTerminalBound },
      { label: 'View: Toggle Sidebar', detail: 'Ctrl+B', icon: 'bi-layout-sidebar', action: toggleSidebarBound },
      { label: 'View: Source Control', icon: 'bi-git', action: showSourceControlBound },
      { label: 'Preferences: Editor Settings', icon: 'bi-gear', action: openSettings },
      { label: 'Omnideck: Ask About Selection or File', detail: 'Ctrl+Shift+A', icon: 'bi-chat-left-text', action: askOmnideckBound },
    ],
  });

  // Button bindings
  bindClick('btn-save', saveCurrentFileBound);
  bindClick('btn-new-file', () => openNewFileModal(state.selectedDir || state.currentDir));
  bindClick('btn-new-folder', () => openNewFolderModal(state.selectedDir || state.currentDir));
  bindClick('btn-new-file-side', () => openNewFileModal(state.selectedDir || state.currentDir));
  bindClick('btn-new-folder-side', () => openNewFolderModal(state.selectedDir || state.currentDir));
  bindClick('btn-refresh', refreshTreeBound);
  bindClick('btn-collapse-all', collapseAllDirs);
  bindClick('btn-hidden', async () => {
    const visible = await toggleHiddenFiles();
    const button = document.getElementById('btn-hidden');
    button.classList.toggle('active', visible);
    button.title = visible ? 'Hide Hidden Files' : 'Show Hidden Files';
  });
  bindClick('btn-reveal', () => {
    if (!state.activeTab) showToast('No active file to reveal', 'info');
    else revealPath(state.activeTab);
  });
  bindClick('btn-home', goHomeBound);
  bindClick('btn-open-folder', () => {
    openModal('Open Folder', 'Folder path (from home):', 'apps/code-ide', 'Open', async (name) => {
      if (!name) return;
      const fullPath = name.startsWith('/') ? name : state.homePath + '/' + name;
      const stat = await api('stat_file', { path: fullPath });
      if (stat.error) { showToast(stat.error, 'error'); return; }
      if (!stat.exists) { showToast('Path does not exist', 'error'); return; }
      if (!stat.is_dir) { showToast('Not a folder', 'error'); return; }
      openFolderAsRootBound(fullPath);
      showToast(`Opened ${basename(fullPath)} as root`, 'success');
    });
  });

  // Activity Bar explorer toggle
  bindClick('btn-explorer', toggleExplorerBound);
  bindClick('btn-source-control', toggleSourceControlBound);
  bindClick('btn-settings', openSettings);

  // Modal/confirm bindings
  bindClick('modal-confirm', triggerModalConfirm);
  bindClick('modal-cancel', closeModal);

  // Confirm dialog bindings
  bindClick('confirm-yes', triggerConfirmYes);
  bindClick('confirm-cancel', triggerConfirmNo);

  // Terminal button bindings
  bindClick('term-collapse', collapseTerminalBound);
  bindClick('term-close', hideTerminalBound);
  bindClick('btn-terminal', toggleTerminalBound);
  bindClick('term-maximize', maximizeTerminalBound);
  bindClick('term-clear', () => { dom.terminalOutput.innerHTML = ''; });

  // ===== Load state and init =====
  const homeResult = await api('get_home');
  if (homeResult.home) {
    state.homePath = homeResult.home;
    state.rootDir = homeResult.home;
    termState.cwd = homeResult.home;
    updatePrompt();

    // Restore saved state — but only UI state that the user hasn't already touched
    const saved = await loadState(api);
    if (saved && !state.userInteracted) {
      if (saved.settings) {
        state.settings = { ...state.settings, ...saved.settings };
      }
      state.recentRoots = Array.isArray(saved.recentRoots) ? saved.recentRoots : [];
      state.showHidden = Boolean(saved.showHidden);
      const hiddenButton = document.getElementById('btn-hidden');
      if (hiddenButton) {
        hiddenButton.classList.toggle('active', state.showHidden);
        hiddenButton.title = state.showHidden ? 'Hide Hidden Files' : 'Show Hidden Files';
      }
      // Restore sidebar width
      if (saved.sidebarWidth && saved.sidebarWidth > 240) {
        dom.sidebar.style.width = saved.sidebarWidth + 'px';
      }
      setSidebarView(saved.sidebarView);
      // Restore sidebar visibility
      if (saved.sidebarHidden) {
        dom.sidebar.classList.add('hidden');
        dom.resizer.classList.add('hidden');
        const explorerBtn = document.getElementById('btn-explorer');
        if (explorerBtn) explorerBtn.classList.remove('active');
        const sourceControlBtn = document.getElementById('btn-source-control');
        if (sourceControlBtn) sourceControlBtn.classList.remove('active');
      }
      // Restore terminal state
      if (saved.terminalHeight) {
        dom.terminalPanel.style.height = saved.terminalHeight;
      }
      const collapseIcon = dom.termCollapse ? dom.termCollapse.querySelector('i') : null;
      const maxIcon = dom.termMaximize ? dom.termMaximize.querySelector('i') : null;
      if (saved.terminalState === 'hidden') {
        dom.terminalPanel.classList.add('hidden');
      } else if (saved.terminalState === 'collapsed') {
        dom.terminalPanel.classList.add('collapsed');
        if (collapseIcon) collapseIcon.className = 'bi bi-chevron-up';
      } else if (saved.terminalState === 'maximized') {
        dom.terminalPanel.classList.add('maximized');
        dom.terminalPanel.parentElement.classList.add('terminal-maximized');
        if (maxIcon) maxIcon.className = 'bi bi-fullscreen-exit';
      }
      // Restore terminal cwd
      if (saved.termCwd) {
        termState.cwd = saved.termCwd;
        updatePrompt();
      }
      // Restore workspace root
      if (saved.rootDir && saved.rootDir !== state.homePath) {
        state.rootDir = saved.rootDir;
        state.currentDir = saved.rootDir;
        renderBreadcrumb(saved.rootDir, goHomeBound, navigateToBound);
        dom.treeContainer.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
        await loadDir(saved.rootDir);
        if (!state.userInteracted) renderTree();
      } else {
        await navigateToBound(state.homePath);
      }
      if (!saved.sidebarHidden && saved.sidebarView === 'source-control') {
        await refreshSourceControl();
      }
      if (saved.selectedDir) state.selectedDir = saved.selectedDir;
      // Restore expanded dirs
      if (saved.expandedDirs && saved.expandedDirs.length > 0) {
        for (const dir of saved.expandedDirs) {
          state.expandedDirs.add(dir);
          await loadDir(dir);
          if (state.userInteracted) break;
        }
        if (state.currentDir === state.rootDir || saved.rootDir === state.homePath) {
          renderTree();
        }
      }
      // Restore open tabs (reload content from disk)
      const savedTabs = saved.tabs || (saved.openTabs || []).map(path => ({ path }));
      if (savedTabs.length > 0) {
        for (const savedTab of savedTabs) {
          if (state.userInteracted) break;
          const tabPath = savedTab.path;
          const stat = await api('stat_file', { path: tabPath });
          if (stat.exists && !stat.is_dir) {
            const name = basename(tabPath);
            await openFileBound(tabPath, name);
            const tab = state.openTabs.get(tabPath);
            if (tab) {
              tab.pinned = Boolean(savedTab.pinned);
              tab.cursor = savedTab.cursor || null;
              tab.scroll = savedTab.scroll || null;
              if (savedTab.dirty && savedTab.draft !== null && !tab.isPreview) {
                if (savedTab.diskModified && savedTab.diskModified !== tab.diskModified) {
                  tab.stale = 'changed';
                  tab.diskModified = savedTab.diskModified;
                }
                tab.content = savedTab.draft;
                tab.dirty = tab.content !== tab.originalContent;
                if (state.cm && state.cmPath === tabPath) {
                  state.cm.setValue(tab.content);
                } else {
                  tab.doc = null;
                }
              }
              if (state.cm && state.cmPath === tabPath && tab.cursor) {
                state.cm.setCursor(tab.cursor);
                if (tab.scroll) state.cm.scrollTo(tab.scroll.left || 0, tab.scroll.top || 0);
              }
            }
          }
        }
        // Restore active tab
        if (!state.userInteracted && saved.activeTab && state.openTabs.has(saved.activeTab)) {
          activateTabBound(saved.activeTab);
        }
        renderTabsBound();
      }
    } else {
      await navigateToBound(state.homePath);
    }
  }
  // Start polling for disk changes every 3 seconds
  state.initDone = true;
  state.pollTimer = setInterval(() => pollDiskChanges(renderEditorBound, renderTabsBound), 3000);

  window.addEventListener('beforeunload', (event) => {
    captureEditorState();
    saveStateImmediate(api, dom, termState);
    if (hasDirtyTabs()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

// Wait for DOM, then init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
