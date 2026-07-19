/* ===== Application State ===== */

export const state = {
  homePath: '',
  rootDir: '',
  currentDir: '',
  selectedDir: '',
  selectedPath: '',
  expandedDirs: new Set(),
  treeData: {},
  openTabs: new Map(),
  activeTab: null,
  contextTarget: null,
  showHidden: false,
  pollTimer: null,
  cm: null,
  cmPath: null,
  initDone: false,
  userInteracted: false,
  openRequestToken: 0,
  searchContent: false,
  settings: {
    tabSize: 2,
    insertSpaces: true,
    wordWrap: false,
    fontSize: 14,
    autoSave: false,
    autoSaveDelay: 1000,
    languageIndentation: true,
  },
  recentRoots: [],
};

export const STORAGE_KEY = 'omnideck-code-ide-state';

let saveTimer = null;

export function hasDirtyTabs() {
  return [...state.openTabs.values()].some(tab => tab.dirty && !tab.isPreview);
}

export function serializeTabs() {
  return [...state.openTabs.entries()].map(([path, tab]) => ({
    path,
    name: tab.name,
    dirty: Boolean(tab.dirty),
    draft: tab.dirty && !tab.isPreview ? tab.content : null,
    pinned: Boolean(tab.pinned),
    diskModified: tab.diskModified || 0,
    cursor: tab.cursor || null,
    scroll: tab.scroll || null,
  }));
}

function snapshot(dom, termState) {
  return {
    rootDir: state.rootDir,
    activeTab: state.activeTab,
    openTabs: [...state.openTabs.keys()], // backward compatibility
    tabs: serializeTabs(),
    expandedDirs: [...state.expandedDirs],
    selectedDir: state.selectedDir,
    showHidden: state.showHidden,
    settings: state.settings,
    recentRoots: state.recentRoots,
    termCwd: termState.cwd,
    sidebarWidth: dom.sidebar.offsetWidth,
    sidebarHidden: dom.sidebar.classList.contains('hidden'),
    sidebarView: dom.sidebar.dataset.view || 'explorer',
    terminalState: dom.terminalPanel.classList.contains('hidden') ? 'hidden'
      : dom.terminalPanel.classList.contains('collapsed') ? 'collapsed'
      : dom.terminalPanel.classList.contains('maximized') ? 'maximized'
      : 'normal',
    terminalHeight: dom.terminalPanel.style.height || '220px',
  };
}

async function persistState(api, dom, termState) {
  try {
    await api('save_state', { data: JSON.stringify(snapshot(dom, termState)) });
  } catch {
    // State recovery must never interrupt editing.
  }
}

export function saveState(api, dom, termState) {
  // Debounce — don't save more than twice per second
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistState(api, dom, termState), 500);
}

export function saveStateImmediate(api, dom, termState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  return persistState(api, dom, termState);
}

export async function loadState(api) {
  try {
    const result = await api('load_state');
    if (result.error || !result.data) return null;
    return JSON.parse(result.data);
  } catch (e) {
    return null;
  }
}
