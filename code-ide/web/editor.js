/* ===== Editor Rendering ===== */

import { state } from './state.js';
import { dom } from './dom.js';
import { renderPreview } from './preview.js';

// ===== CodeMirror mode mapping =====
export const CM_MODES = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': { name: 'javascript', jsx: true },
  '.ts': { name: 'javascript', typescript: true },
  '.tsx': { name: 'javascript', typescript: true, jsx: true },
  '.html': 'xml',
  '.htm': 'xml',
  '.css': 'css',
  '.scss': 'css',
  '.json': 'application/json',
  '.md': 'gfm',
  '.markdown': 'gfm',
  '.go': 'go',
  '.sh': 'shell',
  '.bash': 'shell',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sql': 'sql',
  '.xml': 'xml',
  '.svg': 'xml',
  '.txt': 'text/plain',
};

export function getCMMode(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'shell';
  if (lower === 'makefile') return 'text/plain';
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.substring(dot);
    if (CM_MODES[ext]) return CM_MODES[ext];
  }
  return 'text/plain';
}

export function captureEditorState() {
  if (!state.cm || !state.cmPath) return;
  const tab = state.openTabs.get(state.cmPath);
  if (!tab) return;
  tab.doc = state.cm.getDoc();
  tab.content = state.cm.getValue();
  tab.cursor = state.cm.getCursor();
  tab.scroll = state.cm.getScrollInfo();
}

export function getEditorSelection() {
  if (!state.cm || !state.activeTab) return '';
  return state.cm.getSelection();
}

export function getIndentSettings(tab) {
  const settings = {
    tabSize: state.settings.tabSize,
    insertSpaces: state.settings.insertSpaces,
  };
  if (!state.settings.languageIndentation) return settings;
  if (tab.lang === 'Python') return { tabSize: 4, insertSpaces: true };
  if (tab.lang === 'Go' || tab.lang === 'Makefile') return { tabSize: 4, insertSpaces: false };
  return settings;
}

export function renderEditor(saveCurrentFileFn, closeTabFn, reloadFileFn, updateStatusFn, renderTabsFn, saveStateFn) {
  const previousCm = state.cm;
  captureEditorState();
  if (previousCm?.swapDoc && globalThis.CodeMirror?.Doc) {
    previousCm.swapDoc(new globalThis.CodeMirror.Doc(''));
  }
  state.cm = null;
  state.cmPath = null;
  dom.editorContent.innerHTML = '';

  if (!state.activeTab) {
    dom.editorContent.innerHTML = `
      <div class="welcome">
        <i class="bi bi-code-slash logo"></i>
        <h2>Code IDE</h2>
        <p>Browse folders from the sidebar and click any file to start editing. Your changes are saved with Ctrl+S or the Save button.</p>
        <div class="shortcuts">
          <div class="shortcut"><kbd>Ctrl</kbd> + <kbd>S</kbd> Save file</div>
          <div class="shortcut"><kbd>Ctrl</kbd> + <kbd>B</kbd> Toggle sidebar</div>
          <div class="shortcut"><kbd>Ctrl</kbd> + <kbd>W</kbd> Close tab</div>
          <div class="shortcut"><kbd>Ctrl</kbd> + <kbd>P</kbd> Quick open</div>
          <div class="shortcut"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> Commands</div>
          <div class="shortcut"><kbd>Ctrl</kbd> + <kbd>&#96;</kbd> Toggle terminal</div>
          <div class="shortcut"><kbd>Tab</kbd> Insert spaces</div>
        </div>
      </div>`;
    return;
  }

  const tab = state.openTabs.get(state.activeTab);
  if (!tab) return;

  // Stale banner (shown when file changed or deleted on disk)
  if (tab.stale) {
    const banner = document.createElement('div');
    banner.className = 'stale-banner';
    if (tab.stale === 'deleted') {
      banner.innerHTML = `
        <i class="bi bi-exclamation-triangle"></i>
        <span>This file has been deleted on disk.</span>
        <button class="stale-btn" id="stale-close">Close Tab</button>
        <button class="stale-btn" id="stale-save">Save Anyway</button>`;
      banner.querySelector('#stale-close').onclick = () => closeTabFn(state.activeTab);
      banner.querySelector('#stale-save').onclick = () => {
        saveCurrentFileFn(state.activeTab, true);
      };
    } else {
      const dirtyNote = tab.dirty
        ? ' You have unsaved changes that will be lost if you reload.'
        : '';
      banner.innerHTML = `
        <i class="bi bi-arrow-repeat"></i>
        <span>This file has changed on disk.${dirtyNote}</span>
        <button class="stale-btn primary" id="stale-reload">Reload from Disk</button>
        <button class="stale-btn" id="stale-overwrite">Overwrite</button>`;
      banner.querySelector('#stale-reload').onclick = () => reloadFileFn(state.activeTab);
      banner.querySelector('#stale-overwrite').onclick = () => {
        // Save current content, which overwrites disk
        tab.stale = false;
        saveCurrentFileFn(state.activeTab, true);
      };
    }
    dom.editorContent.appendChild(banner);
  }

  // Check if this is a previewable file (image, PDF, etc.)
  const preview = renderPreview(tab, state.activeTab);
  if (preview) {
    dom.editorContent.appendChild(preview);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'code-editor-cm';
  dom.editorContent.appendChild(wrapper);

  // Determine CodeMirror mode from file extension
  const cmMode = getCMMode(tab.name);
  const indentSettings = getIndentSettings(tab);

  // Create CodeMirror instance
  const cm = CodeMirror(wrapper, {
    value: tab.doc || tab.content,
    mode: cmMode,
    theme: 'vscode-dark',
    lineNumbers: true,
    lineWrapping: state.settings.wordWrap,
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    autoCloseBrackets: true,
    autoCloseTags: true,
    matchBrackets: true,
    styleActiveLine: true,
    indentUnit: indentSettings.tabSize,
    tabSize: indentSettings.tabSize,
    indentWithTabs: !indentSettings.insertSpaces,
    extraKeys: {
      'Ctrl-S': () => saveCurrentFileFn(state.activeTab),
      'Ctrl-F': 'findPersistent',
      'Tab': (cm) => {
        if (cm.somethingSelected()) {
          cm.indentSelection('add');
        } else {
          const indent = indentSettings.insertSpaces
            ? ' '.repeat(indentSettings.tabSize)
            : '\t';
          cm.replaceSelection(indent, 'end');
        }
      },
      'Shift-Tab': (cm) => {
        cm.indentSelection('subtract');
      },
    },
  });

  state.cm = cm;
  state.cmPath = state.activeTab;
  tab.doc = cm.getDoc();
  wrapper.style.fontSize = `${state.settings.fontSize}px`;

  // Change handler
  cm.on('change', () => {
    tab.content = cm.getValue();
    tab.dirty = tab.content !== tab.originalContent;
    tab.cursor = cm.getCursor();
    if (tab.autoSaveTimer) clearTimeout(tab.autoSaveTimer);
    if (state.settings.autoSave && tab.dirty) {
      const path = state.activeTab;
      tab.autoSaveTimer = setTimeout(
        () => saveCurrentFileFn(path),
        state.settings.autoSaveDelay,
      );
    }
    updateStatusFn();
    renderTabsFn();
    saveStateFn();
  });

  cm.on('cursorActivity', () => {
    tab.cursor = cm.getCursor();
  });

  if (tab.cursor) cm.setCursor(tab.cursor);
  if (tab.scroll) cm.scrollTo(tab.scroll.left || 0, tab.scroll.top || 0);

  cm.focus();
}
