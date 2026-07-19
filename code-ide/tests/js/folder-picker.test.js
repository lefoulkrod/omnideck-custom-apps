import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initDom } from '../../web/dom.js';
import { initFolderPicker, openFolderPicker } from '../../web/folder-picker.js';
import { state } from '../../web/state.js';

describe('workspace folder picker', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="folder-picker-overlay">
        <button id="folder-picker-up"></button>
        <button id="folder-picker-home"></button>
        <span id="folder-picker-path"></span>
        <div id="folder-picker-list"></div>
        <button id="folder-picker-cancel"></button>
        <button id="folder-picker-confirm"></button>
      </div>
      <div id="toast"><i></i><span id="toast-msg"></span></div>
    `;
    initDom();
    state.homePath = '/home/me';
    state.rootDir = '/home/me';
  });

  it('browses directories and selects the current folder without typed paths', async () => {
    window.omnideck = {
      invoke: vi.fn(async (action, params) => {
        expect(action).toBe('list_dir_with_hidden');
        if (params.path === '/home/me') {
          return {
            path: '/home/me', parent: null,
            items: [{ name: 'project', path: '/home/me/project', is_dir: true }],
          };
        }
        return {
          path: '/home/me/project', parent: '/home/me',
          items: [{ name: 'src', path: '/home/me/project/src', is_dir: true }],
        };
      }),
    };
    const selected = vi.fn();
    initFolderPicker();

    openFolderPicker('/home/me', selected);
    await vi.waitFor(() => {
      expect(document.querySelector('.folder-picker-row').textContent).toContain('project');
    });
    document.querySelector('.folder-picker-row').click();
    await vi.waitFor(() => {
      expect(document.querySelector('#folder-picker-path').textContent).toBe('~/project');
    });
    expect(document.querySelector('#folder-picker-confirm').textContent).toBe('Open project');
    document.querySelector('#folder-picker-confirm').click();

    expect(selected).toHaveBeenCalledWith('/home/me/project');
    expect(document.querySelector('#folder-picker-overlay').classList.contains('visible')).toBe(false);
  });
});
