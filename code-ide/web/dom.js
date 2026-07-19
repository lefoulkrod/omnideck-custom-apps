/* ===== DOM References ===== */

export const $ = (id) => document.getElementById(id);

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
