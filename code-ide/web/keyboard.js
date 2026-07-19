/* ===== Keyboard Shortcuts ===== */

import { state } from './state.js';

export function initKeyboard(
  saveCurrentFileFn, toggleSidebarFn, closeTabFn, toggleTerminalFn,
  openQuickOpenFn, openCommandPaletteFn, formatFileFn, askOmnideckFn,
) {
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 's') {
      e.preventDefault();
      saveCurrentFileFn();
    }
    if (ctrl && key === 'b') {
      e.preventDefault();
      toggleSidebarFn();
    }
    if (ctrl && key === 'w') {
      e.preventDefault();
      if (state.activeTab) closeTabFn(state.activeTab);
    }
    if (ctrl && e.key === '`') {
      e.preventDefault();
      toggleTerminalFn();
    }
    if (ctrl && !e.shiftKey && key === 'p') {
      e.preventDefault();
      openQuickOpenFn();
    }
    if (ctrl && e.shiftKey && key === 'p') {
      e.preventDefault();
      openCommandPaletteFn();
    }
    if (e.shiftKey && e.altKey && key === 'f') {
      e.preventDefault();
      formatFileFn();
    }
    if (ctrl && e.shiftKey && key === 'a') {
      e.preventDefault();
      askOmnideckFn();
    }
  });
}
