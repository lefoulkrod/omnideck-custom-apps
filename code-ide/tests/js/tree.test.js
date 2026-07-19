import { beforeEach, describe, expect, it } from 'vitest';

import { dom } from '../../web/dom.js';
import { state } from '../../web/state.js';
import {
  collapseAllDirs, isSameOrDescendant, optimisticRename, remapPathPrefix, setTreeDeps,
} from '../../web/tree.js';

describe('tree path state', () => {
  beforeEach(() => {
    dom.treeContainer = document.createElement('div');
    state.currentDir = '/root';
    state.homePath = '/root';
    state.treeData = {
      '/root': { items: [{ name: 'old', path: '/root/old', is_dir: true }] },
      '/root/old': { items: [{ name: 'file.js', path: '/root/old/file.js', is_dir: false }] },
    };
    state.expandedDirs = new Set(['/root/old']);
    state.openTabs = new Map([['/root/old/file.js', { name: 'file.js' }]]);
    state.activeTab = '/root/old/file.js';
    state.selectedDir = '/root/old';
    state.selectedPath = '/root/old';
    setTreeDeps({ saveState: () => {} });
  });

  it('recognizes and remaps descendants without prefix collisions', () => {
    expect(isSameOrDescendant('/root/old/file', '/root/old')).toBe(true);
    expect(isSameOrDescendant('/root/older/file', '/root/old')).toBe(false);
    expect(remapPathPrefix('/root/old/file', '/root/old', '/root/new')).toBe('/root/new/file');
  });

  it('remaps loaded descendants, tabs, selection, and active state on directory rename', () => {
    optimisticRename('/root/old', 'new');

    expect(state.treeData['/root/new'].items[0].path).toBe('/root/new/file.js');
    expect(state.expandedDirs.has('/root/new')).toBe(true);
    expect(state.openTabs.has('/root/new/file.js')).toBe(true);
    expect(state.activeTab).toBe('/root/new/file.js');
    expect(state.selectedDir).toBe('/root/new');
  });

  it('collapses all folders and persists the change', () => {
    let saves = 0;
    setTreeDeps({ saveState: () => { saves += 1; } });

    collapseAllDirs();

    expect(state.expandedDirs.size).toBe(0);
    expect(saves).toBe(1);
  });
});

