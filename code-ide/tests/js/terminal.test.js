import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dom, initDom } from '../../web/dom.js';
import { collapseTerminal, termState } from '../../web/terminal.js';

describe('terminal panel state', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="editor-area">
        <div id="terminal-panel" style="height: 280px">
          <div class="terminal-header"><button id="term-collapse"><i></i></button></div>
          <div id="terminal-body"></div>
          <div id="terminal-output"></div>
          <input id="terminal-input">
          <span id="terminal-prompt"></span>
        </div>
      </div>
    `;
    initDom();
    termState.savedHeight = null;
  });

  it('collapses to a strip and restores the previous height', () => {
    const saveState = vi.fn();

    collapseTerminal(saveState);

    expect(dom.terminalPanel.classList.contains('collapsed')).toBe(true);
    expect(dom.terminalPanel.style.height).toBe('32px');
    expect(termState.savedHeight).toBe('280px');
    expect(dom.termCollapse.querySelector('i').className).toBe('bi bi-chevron-up');

    collapseTerminal(saveState);

    expect(dom.terminalPanel.classList.contains('collapsed')).toBe(false);
    expect(dom.terminalPanel.style.height).toBe('280px');
    expect(dom.termCollapse.querySelector('i').className).toBe('bi bi-chevron-down');
    expect(saveState).toHaveBeenCalledTimes(2);
  });
});
