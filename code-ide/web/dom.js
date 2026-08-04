/* ===== DOM References ===== */

export const $ = (id) => document.getElementById(id);

/* Escape a string for interpolation into innerHTML.
 *
 * Symbol names, file paths and language names all come from whatever
 * repository is open, which the user did not necessarily write. A file named
 * `<img src=x onerror=...>` would otherwise execute inside the app, where it
 * can reach every backend action including terminal and write_file. Prefer
 * textContent where practical; use this where a template literal is clearer. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export const dom = {};

export function initDom() {
  dom.treeContainer = $('tree-container');
  dom.searchInput = $('search-input');
  dom.searchClear = $('search-clear');
  dom.searchMode = $('search-mode');
  dom.searchOptionsToggle = $('search-options-toggle');
  dom.searchOptions = $('search-options');
  dom.searchInclude = $('search-include');
  dom.searchExclude = $('search-exclude');
  dom.searchReplace = $('search-replace');
  dom.searchReplaceAll = $('search-replace-all');
  dom.tabBar = $('tab-bar');
  dom.editorContent = $('editor-content');
  dom.statusPath = $('status-path');
  dom.statusLines = $('status-lines');
  dom.statusLang = $('status-lang');
  dom.statusSave = $('status-save');
  dom.contextMenu = $('context-menu');
  dom.modalOverlay = $('modal-overlay');
  dom.modalTitle = $('modal-title');
  dom.modalLabel = $('modal-label');
  dom.modalInput = $('modal-input');
  dom.modalConfirm = $('modal-confirm');
  dom.modalCancel = $('modal-cancel');
  dom.confirmOverlay = $('confirm-overlay');
  dom.confirmTitle = $('confirm-title');
  dom.confirmMessage = $('confirm-message');
  dom.confirmYes = $('confirm-yes');
  dom.confirmCancel = $('confirm-cancel');
  dom.toast = $('toast');
  dom.toastMsg = $('toast-msg');
  dom.activityBar = $('activity-bar');
  dom.sidebar = $('sidebar');
  dom.explorerView = $('explorer-view');
  dom.sourceView = $('source-view');
  dom.structureView = $('structure-view');
  dom.metricsView = $('metrics-view');
  dom.reviewView = $('review-view');
  dom.workspaceCurrent = $('workspace-current');
  dom.resizer = $('resizer');
  dom.terminalPanel = $('terminal-panel');
  dom.terminalBody = $('terminal-body');
  dom.terminalOutput = $('terminal-output');
  dom.terminalInput = $('terminal-input');
  dom.terminalPrompt = $('terminal-prompt');
  dom.termCollapse = $('term-collapse');
  dom.termClose = $('term-close');
  dom.termClear = $('term-clear');
  dom.termNew = $('term-new');
  dom.termKill = $('term-kill');
  dom.btnTerminal = $('btn-terminal');
  dom.termMaximize = $('term-maximize');
  dom.quickOverlay = $('quick-overlay');
  dom.quickInput = $('quick-input');
  dom.quickResults = $('quick-results');
  dom.settingsOverlay = $('settings-overlay');
  dom.sourcePanel = dom.sourceView;
  dom.folderPickerOverlay = $('folder-picker-overlay');
  dom.folderPickerPath = $('folder-picker-path');
  dom.folderPickerList = $('folder-picker-list');
  dom.folderPickerUp = $('folder-picker-up');
  dom.folderPickerHome = $('folder-picker-home');
  dom.folderPickerCancel = $('folder-picker-cancel');
  dom.folderPickerConfirm = $('folder-picker-confirm');
}
