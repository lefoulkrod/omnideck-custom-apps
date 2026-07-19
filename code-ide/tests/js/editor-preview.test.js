import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dom } from '../../web/dom.js';
import { state } from '../../web/state.js';
import { getCMMode, getIndentSettings } from '../../web/editor.js';
import { saveCurrentFile } from '../../web/file-ops.js';
import { renderPreview } from '../../web/preview.js';

describe('editor and preview safety', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast"><i></i><span id="toast-msg"></span></div>';
    dom.toast = document.getElementById('toast');
    dom.toastMsg = document.getElementById('toast-msg');
    dom.statusSave = document.createElement('div');
    dom.statusPath = document.createElement('div');
    dom.statusLines = document.createElement('div');
    dom.statusLang = document.createElement('div');
    state.openTabs = new Map();
    state.settings = {
      tabSize: 2, insertSpaces: true, wordWrap: false, fontSize: 14,
      autoSave: false, autoSaveDelay: 1000, languageIndentation: true,
    };
    window.omnideck = { invoke: vi.fn() };
  });

  it('never invokes write_file for a binary preview', async () => {
    state.activeTab = '/home/me/image.png';
    state.openTabs.set(state.activeTab, { name: 'image.png', content: '', isPreview: true });

    await saveCurrentFile(vi.fn(), vi.fn());

    expect(window.omnideck.invoke).not.toHaveBeenCalled();
  });

  it('sends the disk modification token when saving text', async () => {
    state.activeTab = '/home/me/file.js';
    state.openTabs.set(state.activeTab, {
      name: 'file.js', content: 'changed', originalContent: 'old',
      dirty: true, diskModified: 123,
    });
    window.omnideck.invoke.mockResolvedValue({ success: true, modified: 456 });

    await saveCurrentFile(vi.fn(), vi.fn());

    expect(window.omnideck.invoke).toHaveBeenCalledWith('write_file', {
      path: '/home/me/file.js', content: 'changed', expected_modified: 123,
    });
    expect(state.openTabs.get(state.activeTab).dirty).toBe(false);
    expect(state.openTabs.get(state.activeTab).diskModified).toBe(456);
  });

  it('uses same-origin encoded preview paths', () => {
    const preview = renderPreview({ name: 'my image.png' }, '/home/me/my image.png');
    expect(preview.querySelector('img').getAttribute('src')).toBe('/home/me/my%20image.png');
  });

  it('maps modes and language indentation defaults', () => {
    expect(getCMMode('thing.py')).toBe('python');
    expect(getIndentSettings({ lang: 'Python' })).toEqual({ tabSize: 4, insertSpaces: true });
    expect(getIndentSettings({ lang: 'Go' })).toEqual({ tabSize: 4, insertSpaces: false });
  });
});
