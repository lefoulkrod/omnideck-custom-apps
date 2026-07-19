/* ===== Terminal ===== */

import { dom } from './dom.js';
import { api, showToast } from './api.js';
import { relativePath } from './breadcrumb.js';

export const termState = {
  cwd: '',
  history: [],
  historyIndex: -1,
  running: false,
  savedHeight: null,
  nextId: 2,
  activeTerminalId: 1,
  workspaceCwd: '',
  terminals: [{ id: 1, name: 'Terminal 1', cwd: '', history: [], historyIndex: -1, output: '' }],
};

function activeTerminal() {
  return termState.terminals.find(terminal => terminal.id === termState.activeTerminalId);
}

function saveActiveTerminal() {
  const terminal = activeTerminal();
  if (!terminal) return;
  terminal.cwd = termState.cwd;
  terminal.history = termState.history;
  terminal.historyIndex = termState.historyIndex;
  terminal.output = dom.terminalOutput?.innerHTML || '';
}

function renderTerminalTabs() {
  const container = dom.terminalPanel.querySelector('.terminal-tabs');
  container.innerHTML = '';
  for (const terminal of termState.terminals) {
    const tab = document.createElement('button');
    tab.className = 'terminal-tab' + (terminal.id === termState.activeTerminalId ? ' active' : '');
    tab.innerHTML = '<i class="bi bi-terminal"></i>';
    tab.appendChild(document.createTextNode(` ${terminal.name}`));
    tab.onclick = (event) => {
      event.stopPropagation();
      switchTerminal(terminal.id);
    };
    container.appendChild(tab);
  }
}

export function switchTerminal(id) {
  saveActiveTerminal();
  const terminal = termState.terminals.find(candidate => candidate.id === id);
  if (!terminal) return;
  termState.activeTerminalId = id;
  termState.cwd = terminal.cwd || termState.cwd;
  termState.history = terminal.history;
  termState.historyIndex = terminal.historyIndex;
  dom.terminalOutput.innerHTML = terminal.output;
  renderTerminalTabs();
  updatePrompt();
  dom.terminalInput.focus();
}

export function setTerminalWorkspace(path) {
  const cwd = path || '';
  termState.workspaceCwd = cwd;
  termState.cwd = cwd;
  for (const terminal of termState.terminals) terminal.cwd = cwd;
  if (dom.terminalPrompt) updatePrompt();
}

export function createTerminal() {
  saveActiveTerminal();
  const id = termState.nextId++;
  const cwd = termState.workspaceCwd || termState.cwd;
  termState.terminals.push({
    id, name: `Terminal ${id}`, cwd,
    history: [], historyIndex: -1, output: '',
  });
  switchTerminal(id);
}

export function closeActiveTerminal() {
  if (termState.terminals.length === 1) {
    dom.terminalOutput.innerHTML = '';
    activeTerminal().output = '';
    return;
  }
  const index = termState.terminals.findIndex(terminal => terminal.id === termState.activeTerminalId);
  termState.terminals.splice(index, 1);
  termState.activeTerminalId = termState.terminals[Math.max(0, index - 1)].id;
  const terminal = activeTerminal();
  termState.cwd = terminal.cwd;
  termState.history = terminal.history;
  termState.historyIndex = terminal.historyIndex;
  dom.terminalOutput.innerHTML = terminal.output;
  renderTerminalTabs();
  updatePrompt();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function updatePrompt() {
  const displayCwd = termState.cwd
    ? relativePath(termState.cwd)
    : '~';
  dom.terminalPrompt.textContent = `${displayCwd}$`;
}

export function termAppend(html) {
  const line = document.createElement('div');
  line.className = 'term-line';
  line.innerHTML = html;
  dom.terminalOutput.appendChild(line);
  dom.terminalBody.scrollTop = dom.terminalBody.scrollHeight;
}

export function termAppendText(text, cls = '') {
  const escaped = escapeHtml(text);
  termAppend(`<span class="${cls}">${escaped}</span>`);
}

export function collapseTerminal(saveStateFn) {
  const collapseIcon = dom.termCollapse ? dom.termCollapse.querySelector('i') : null;
  // If maximized, restore first
  if (dom.terminalPanel.classList.contains('maximized')) {
    maximizeTerminal(() => {});
  }
  const shouldCollapse = !dom.terminalPanel.classList.contains('collapsed');
  dom.terminalPanel.classList.toggle('collapsed', shouldCollapse);
  if (shouldCollapse) {
    termState.savedHeight = dom.terminalPanel.style.height
      || `${dom.terminalPanel.offsetHeight || 220}px`;
    dom.terminalPanel.style.height = '32px';
    if (collapseIcon) collapseIcon.className = 'bi bi-chevron-up';
  } else {
    dom.terminalPanel.style.height = termState.savedHeight || '220px';
    if (collapseIcon) collapseIcon.className = 'bi bi-chevron-down';
    dom.terminalInput.focus();
  }
  saveStateFn();
}

export function hideTerminal(saveStateFn) {
  // If maximized, restore first
  if (dom.terminalPanel.classList.contains('maximized')) {
    maximizeTerminal(saveStateFn);
  }
  if (dom.terminalPanel.classList.contains('collapsed')) {
    dom.terminalPanel.style.height = termState.savedHeight || '220px';
    const collapseIcon = dom.termCollapse ? dom.termCollapse.querySelector('i') : null;
    if (collapseIcon) collapseIcon.className = 'bi bi-chevron-down';
  }
  dom.terminalPanel.classList.add('hidden');
  dom.terminalPanel.classList.remove('collapsed');
  saveStateFn();
}

export function showTerminal(saveStateFn) {
  if (dom.terminalPanel.classList.contains('hidden')) {
    dom.terminalPanel.classList.remove('hidden');
    dom.terminalInput.focus();
  } else if (dom.terminalPanel.classList.contains('collapsed')) {
    collapseTerminal(saveStateFn);
  } else {
    dom.terminalInput.focus();
  }
  saveStateFn();
}

// Toggle: if hidden -> show, if visible -> hide
export function toggleTerminal(saveStateFn) {
  if (dom.terminalPanel.classList.contains('hidden')) {
    showTerminal(saveStateFn);
  } else {
    hideTerminal(saveStateFn);
  }
}

export function maximizeTerminal(saveStateFn) {
  const maxIcon = dom.termMaximize ? dom.termMaximize.querySelector('i') : null;
  const collapseIcon = dom.termCollapse ? dom.termCollapse.querySelector('i') : null;
  const editorArea = dom.terminalPanel.parentElement;
  const isMaximized = dom.terminalPanel.classList.contains('maximized');
  if (isMaximized) {
    // Restore
    dom.terminalPanel.classList.remove('maximized');
    dom.terminalPanel.style.height = termState.savedHeight || '220px';
    editorArea.classList.remove('terminal-maximized');
    if (maxIcon) maxIcon.className = 'bi bi-arrows-fullscreen';
  } else {
    // Maximize
    if (dom.terminalPanel.classList.contains('collapsed')) {
      dom.terminalPanel.classList.remove('collapsed');
      dom.terminalPanel.style.height = termState.savedHeight || '220px';
    } else {
      termState.savedHeight = dom.terminalPanel.style.height || '220px';
    }
    dom.terminalPanel.classList.add('maximized');
    editorArea.classList.add('terminal-maximized');
    if (maxIcon) maxIcon.className = 'bi bi-fullscreen-exit';
    if (collapseIcon) collapseIcon.className = 'bi bi-chevron-down';
    dom.terminalInput.focus();
  }
  saveStateFn();
}

export async function runTerminalCommand(cmd) {
  if (termState.running) return;
  if (!cmd.trim()) {
    termAppend(`<span class="term-prompt">${escapeHtml(dom.terminalPrompt.textContent)}</span> <span class="term-cmd"></span>`);
    return;
  }

  termState.running = true;
  termState.history.push(cmd);
  termState.historyIndex = termState.history.length;

  // Echo the command
  const displayCwd = termState.cwd ? relativePath(termState.cwd) : '~';
  termAppend(`<span class="term-prompt">${escapeHtml(displayCwd)}$</span> <span class="term-cmd">${escapeHtml(cmd)}</span>`);

  dom.terminalInput.value = '';

  const result = await api('run_command', { command: cmd, cwd: termState.cwd || '' });

  if (result.error) {
    termAppendText(result.error, 'term-stderr');
  } else {
    if (result.stdout) {
      termAppendText(result.stdout);
    }
    if (result.stderr) {
      termAppendText(result.stderr, 'term-stderr');
    }
    if (result.timeout) {
      termAppendText('⏱ Command timed out after 30 seconds.', 'term-stderr');
    }
    if (!result.stdout && !result.stderr && !result.timeout) {
      termAppendText('(no output)', 'term-info');
    }
    // Show exit code if non-zero
    if (result.exit_code !== 0 && result.exit_code !== -1) {
      termAppendText(`[exit code: ${result.exit_code}]`, 'term-exit-err');
    } else if (result.exit_code === 0) {
      // Optionally show success — VS Code doesn't, so keep quiet
    }

    // Update cwd if the command was a cd
    if (result.cwd) {
      termState.cwd = result.cwd;
    }
  }

  updatePrompt();
  termState.running = false;
  saveActiveTerminal();
  dom.terminalInput.focus();
}

// Clipboard helpers
function copyToClipboard(text) {
  // Method 1: navigator.clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      fallbackCopy(text);
    });
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  // Method 2: execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) {
    // Method 3: nothing works — at least don't crash
  }
}

function insertAtCursor(input, text) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.substring(0, start) + text + input.value.substring(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  input.focus();
}

export function initTerminal(saveStateFn) {
  renderTerminalTabs();
  dom.termNew.addEventListener('click', (event) => {
    event.stopPropagation();
    createTerminal();
    saveStateFn();
  });
  dom.termKill.addEventListener('click', (event) => {
    event.stopPropagation();
    closeActiveTerminal();
    saveStateFn();
  });
  // Terminal input handler
  dom.terminalInput.addEventListener('keydown', (e) => {
    // Copy: Ctrl+Shift+C when text is selected in the terminal
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && e.shiftKey) {
      e.preventDefault();
      const sel = window.getSelection();
      const text = sel.toString();
      if (text) {
        copyToClipboard(text);
      }
      return;
    }
    // Paste: Ctrl+V or Ctrl+Shift+V — let native paste work
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = dom.terminalInput.value;
      runTerminalCommand(cmd);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (termState.history.length > 0 && termState.historyIndex > 0) {
        termState.historyIndex--;
        dom.terminalInput.value = termState.history[termState.historyIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (termState.historyIndex < termState.history.length - 1) {
        termState.historyIndex++;
        dom.terminalInput.value = termState.history[termState.historyIndex];
      } else {
        termState.historyIndex = termState.history.length;
        dom.terminalInput.value = '';
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      dom.terminalOutput.innerHTML = '';
    }
  });

  // Also handle copy from terminal output area (Ctrl+C when selection is in output)
  dom.terminalBody.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      const sel = window.getSelection();
      const text = sel.toString();
      if (text) {
        e.preventDefault();
        copyToClipboard(text);
      }
    }
  });

  // Paste via execCommand as fallback
  dom.terminalInput.addEventListener('paste', (e) => {
    // Let native paste work — this event fires even in sandboxed iframes
    // for text inputs. If it doesn't, the user can use Ctrl+Shift+V.
  });

  // Ctrl+Shift+V: explicit paste fallback
  dom.terminalInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && e.shiftKey) {
      e.preventDefault();
      // Try clipboard API first
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then((text) => {
          insertAtCursor(dom.terminalInput, text);
        }).catch(() => {
          // Fallback: focus and let user paste manually
          dom.terminalInput.focus();
          showToast('Press Ctrl+V to paste', 'info');
        });
      } else {
        showToast('Clipboard not available — try Ctrl+V', 'info');
      }
    }
  });

  // Click anywhere in terminal body focuses input
  dom.terminalBody.onclick = () => dom.terminalInput.focus();

  // Terminal panel resize (drag the header)
  let termResizing = false;
  let termStartY = 0;
  let termStartH = 0;
  const termHeader = dom.terminalPanel.querySelector('.terminal-header');
  termHeader.addEventListener('mousedown', (e) => {
    // Only resize from the header, not from buttons
    if (e.target.closest('.icon-btn')) return;
    termResizing = true;
    termStartY = e.clientY;
    termStartH = dom.terminalPanel.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });
  // Double-click header to maximize/restore
  termHeader.addEventListener('dblclick', (e) => {
    if (e.target.closest('.icon-btn')) return;
    maximizeTerminal(saveStateFn);
  });
  document.addEventListener('mousemove', (e) => {
    if (!termResizing) return;
    const delta = termStartY - e.clientY;
    const newH = Math.max(80, Math.min(window.innerHeight - 100, termStartH + delta));
    dom.terminalPanel.style.height = newH + 'px';
    termState.savedHeight = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (termResizing) {
      termResizing = false;
      document.body.style.cursor = '';
      saveStateFn();
    }
  });
}
