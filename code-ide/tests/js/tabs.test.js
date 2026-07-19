import { beforeEach, describe, expect, it } from 'vitest';

import { state } from '../../web/state.js';
import { openDiff, reorderTab, togglePinTab } from '../../web/tabs.js';

describe('tab ordering', () => {
  beforeEach(() => {
    state.openTabs = new Map([
      ['/a', { name: 'a' }],
      ['/b', { name: 'b' }],
      ['/c', { name: 'c' }],
    ]);
  });

  it('reorders a dragged tab before its drop target', () => {
    reorderTab('/c', '/a');
    expect([...state.openTabs.keys()]).toEqual(['/c', '/a', '/b']);
  });

  it('moves pinned tabs ahead of regular tabs', () => {
    togglePinTab('/c');
    expect([...state.openTabs.keys()]).toEqual(['/c', '/a', '/b']);
    expect(state.openTabs.get('/c').pinned).toBe(true);
  });

  it('opens source-control changes as read-only editor tabs', () => {
    const renderTabs = () => {};
    const activated = [];
    openDiff({
      repositoryRoot: '/work/project',
      path: 'src/app.js',
      sourcePath: '/work/project/src/app.js',
      name: 'app.js',
      original: 'const value = 1;\n',
      modified: 'const value = 2;\n',
      unifiedDiff: '@@ -1 +1 @@',
      status: ' M',
      deleted: false,
    }, renderTabs, path => activated.push(path), () => {});

    const [id, tab] = [...state.openTabs.entries()].at(-1);
    expect(id).toMatch(/^git-diff:/);
    expect(tab.isDiff).toBe(true);
    expect(tab.baseContent).toBe('const value = 1;\n');
    expect(tab.content).toBe('const value = 2;\n');
    expect(tab.sourcePath).toBe('/work/project/src/app.js');
    expect(activated).toEqual([id]);
  });
});
