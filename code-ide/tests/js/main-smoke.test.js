import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { state } from '../../web/state.js';

describe('application startup', () => {
  afterEach(() => {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  });

  it('initializes the full DOM and loads the home explorer', async () => {
    const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.innerHTML = parsed.body.innerHTML;
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    window.omnideck = {
      invoke: vi.fn(async (action) => {
        if (action === 'get_home') return { home: '/home/me' };
        if (action === 'load_state') return { data: null };
        if (action === 'list_dir') {
          return {
            path: '/home/me',
            items: [{ name: 'project', path: '/home/me/project', is_dir: true }],
          };
        }
        if (action === 'save_state') return { success: true };
        if (action === 'git_status') {
          return { root: '/home/me', branch: 'main', count: 0, files: [] };
        }
        return {};
      }),
      chat: { compose: vi.fn() },
    };

    await import('../../web/main.js');

    await vi.waitFor(() => {
      expect(document.querySelector('#tree-container').textContent).toContain('project');
    });
    expect(document.querySelector('#btn-collapse-all')).toBeTruthy();
    expect(document.querySelector('#quick-overlay')).toBeTruthy();

    const sidebar = document.querySelector('#sidebar');
    sidebar.style.width = '420px';
    document.querySelector('#btn-explorer').click();
    expect(sidebar.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#resizer').classList.contains('hidden')).toBe(true);

    document.querySelector('#btn-source-control').click();
    await vi.waitFor(() => {
      expect(document.querySelector('#source-branch').textContent).toContain('main');
    });
    expect(sidebar.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('#source-view').hidden).toBe(false);
    expect(document.querySelector('#explorer-view').hidden).toBe(true);
    expect(document.querySelector('#source-view').parentElement).toBe(sidebar);
  });
});
