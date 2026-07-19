import { beforeEach, describe, expect, it } from 'vitest';

import { state } from '../../web/state.js';
import { reorderTab, togglePinTab } from '../../web/tabs.js';

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
});
