import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initDom } from '../../web/dom.js';
import { initQuickOpen, openWorkspaceSwitcher } from '../../web/quick-open.js';
import { goHome, updateWorkspaceName } from '../../web/tree.js';
import { state } from '../../web/state.js';

function shell() {
  // jsdom has no layout, so scrollIntoView is undefined there.
  Element.prototype.scrollIntoView = () => {};
  document.body.innerHTML = `
    <button id="btn-workspace"><span id="workspace-current">Home</span></button>
    <span id="workspace-name">Explorer</span>
    <div id="quick-overlay"><input id="quick-input"><div id="quick-results"></div></div>
    <div id="tree-container"></div>
    <div id="breadcrumb"></div>
    <div id="toast"><i></i><span id="toast-msg"></span></div>
  `;
  initDom();
  state.homePath = '/home/me';
  state.rootDir = '/home/me';
  state.recentRoots = [];
  state.openTabs = new Map();
}

describe('workspace switcher', () => {
  beforeEach(shell);

  it('lists repositories and plain folders, searchable from anywhere', async () => {
    window.omnideck = {
      invoke: vi.fn(async (action) => {
        expect(action).toBe('list_workspaces');
        return {
          home: '/home/me',
          workspaces: [
            { path: '/home/me/api', name: 'api', is_repo: true, score: 80 },
            { path: '/home/me/notes', name: 'notes', is_repo: false, score: 60 },
          ],
        };
      }),
    };
    initQuickOpen({ openFile: vi.fn(), openFolder: vi.fn(), commands: [] });
    openWorkspaceSwitcher();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const labels = [...document.querySelectorAll('.quick-result-label')]
      .map((el) => el.textContent);
    expect(labels).toContain('api');
    expect(labels).toContain('notes');
    expect(document.getElementById('quick-input').placeholder)
      .toContain('workspace');
  });

  it('opens the chosen folder as the workspace', async () => {
    const openFolder = vi.fn();
    window.omnideck = {
      invoke: vi.fn(async () => ({
        home: '/home/me',
        workspaces: [{ path: '/home/me/api', name: 'api', is_repo: true, score: 80 }],
      })),
    };
    initQuickOpen({ openFile: vi.fn(), openFolder, commands: [] });
    openWorkspaceSwitcher();
    await new Promise((resolve) => setTimeout(resolve, 0));

    [...document.querySelectorAll('.quick-result')]
      .find((row) => row.textContent.includes('api'))
      .click();
    expect(openFolder).toHaveBeenCalledWith('/home/me/api');
  });
});

describe('workspace label', () => {
  beforeEach(shell);

  it('tracks the workspace, not the folder being browsed', () => {
    /* navigateTo used to relabel the header without changing rootDir, so the
     * title bar claimed a workspace that git-aware views never saw. */
    state.rootDir = '/home/me/api';
    updateWorkspaceName();
    expect(document.getElementById('workspace-current').textContent).toBe('api');

    state.currentDir = '/home/me/api/deep/nested';
    updateWorkspaceName();
    expect(document.getElementById('workspace-current').textContent).toBe('api');
  });

  it('says Home when the workspace is the home directory', () => {
    state.rootDir = '/home/me';
    updateWorkspaceName();
    expect(document.getElementById('workspace-current').textContent).toBe('Home');
  });

  it('updates the label when returning home', () => {
    state.rootDir = '/home/me/api';
    updateWorkspaceName();
    goHome(vi.fn(), vi.fn(), vi.fn());
    expect(document.getElementById('workspace-current').textContent).toBe('Home');
  });
});
