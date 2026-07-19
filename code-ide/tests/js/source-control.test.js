import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initDom } from '../../web/dom.js';
import { initSourceControl, refreshSourceControl } from '../../web/source-control.js';
import { state } from '../../web/state.js';

describe('source control editor integration', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="source-refresh"></button>
      <button id="source-close"></button>
      <div id="source-branch"></div>
      <div id="source-files"></div>
      <div id="toast"><i></i><span id="toast-msg"></span></div>
    `;
    initDom();
    state.rootDir = '/home/me/project';
    state.homePath = '/home/me';
  });

  it('opens a changed file as a HEAD-to-working-tree editor diff', async () => {
    const openDiff = vi.fn();
    window.omnideck = {
      invoke: vi.fn(async (action) => {
        if (action === 'git_status') {
          return {
            root: '/home/me/project', branch: 'main', count: 1,
            files: [{ status: ' M', path: 'src/app.js', original_path: '' }],
          };
        }
        if (action === 'git_diff') {
          return {
            path: 'src/app.js', original: 'const n = 1;\n',
            modified: 'const n = 2;\n', diff: '@@ -1 +1 @@',
            binary: false, deleted: false,
          };
        }
        return {};
      }),
    };
    initSourceControl(vi.fn(), openDiff);

    await refreshSourceControl();
    expect(document.querySelector('.source-status').textContent).toBe('M');
    document.querySelector('.source-file').click();

    await vi.waitFor(() => expect(openDiff).toHaveBeenCalledOnce());
    expect(window.omnideck.invoke).toHaveBeenCalledWith('git_diff', {
      path: '/home/me/project',
      file_path: '/home/me/project/src/app.js',
      original_path: '',
    });
    expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/app.js',
      sourcePath: '/home/me/project/src/app.js',
      original: 'const n = 1;\n',
      modified: 'const n = 2;\n',
    }));
  });

  it('shows a readable U badge for untracked files', async () => {
    window.omnideck = {
      invoke: vi.fn(async action => action === 'git_status' ? {
        root: '/home/me/project', branch: 'main', count: 1,
        files: [{ status: '??', path: 'new-file.js', original_path: '' }],
      } : {}),
    };
    initSourceControl(vi.fn(), vi.fn());

    await refreshSourceControl();

    const badge = document.querySelector('.source-status');
    expect(badge.textContent).toBe('U');
    expect(badge.title).toBe('Untracked');
  });
});
