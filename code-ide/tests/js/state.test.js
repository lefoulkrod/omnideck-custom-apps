import { beforeEach, describe, expect, it } from 'vitest';

import { state, hasDirtyTabs, serializeTabs } from '../../web/state.js';

describe('state serialization', () => {
  beforeEach(() => {
    state.openTabs = new Map();
    state.activeTab = null;
  });

  it('persists dirty drafts and omits clean content', () => {
    state.openTabs.set('/clean.js', { name: 'clean.js', content: 'clean', dirty: false });
    state.openTabs.set('/dirty.js', { name: 'dirty.js', content: 'draft', dirty: true, pinned: true });

    expect(hasDirtyTabs()).toBe(true);
    expect(serializeTabs()).toEqual([
      expect.objectContaining({ path: '/clean.js', draft: null, dirty: false }),
      expect.objectContaining({ path: '/dirty.js', draft: 'draft', dirty: true, pinned: true }),
    ]);
  });

  it('does not treat a preview as a recoverable dirty editor', () => {
    state.openTabs.set('/image.png', { name: 'image.png', content: '', dirty: true, isPreview: true });
    expect(hasDirtyTabs()).toBe(false);
  });

  it('does not persist generated Git diff editors', () => {
    state.openTabs.set('git-diff:example', {
      name: 'example.js (Working Tree)', content: 'changed', dirty: false, isDiff: true,
    });
    expect(serializeTabs()).toEqual([]);
  });
});
