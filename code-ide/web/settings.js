/* ===== Editor Settings ===== */

import { state } from './state.js';
import { dom, $ } from './dom.js';

export function openSettings() {
  $('setting-tab-size').value = state.settings.tabSize;
  $('setting-font-size').value = state.settings.fontSize;
  $('setting-spaces').checked = state.settings.insertSpaces;
  $('setting-wrap').checked = state.settings.wordWrap;
  $('setting-language-indent').checked = state.settings.languageIndentation;
  $('setting-autosave').checked = state.settings.autoSave;
  $('setting-autosave-delay').value = state.settings.autoSaveDelay;
  dom.settingsOverlay.classList.add('visible');
}

export function closeSettings() {
  dom.settingsOverlay.classList.remove('visible');
}

export function initSettings(renderEditorFn, saveStateFn) {
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', () => {
    state.settings = {
      tabSize: Math.max(1, Math.min(8, Number($('setting-tab-size').value) || 2)),
      fontSize: Math.max(10, Math.min(28, Number($('setting-font-size').value) || 14)),
      insertSpaces: $('setting-spaces').checked,
      wordWrap: $('setting-wrap').checked,
      languageIndentation: $('setting-language-indent').checked,
      autoSave: $('setting-autosave').checked,
      autoSaveDelay: Math.max(250, Math.min(10000, Number($('setting-autosave-delay').value) || 1000)),
    };
    closeSettings();
    renderEditorFn();
    saveStateFn();
  });
  dom.settingsOverlay.addEventListener('mousedown', (event) => {
    if (event.target === dom.settingsOverlay) closeSettings();
  });
}
