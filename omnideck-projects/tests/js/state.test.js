import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  fileUrl,
  formatBytes,
  itemKey,
  parseRoute,
  projectPrompt,
  routeHash,
  splitItemKey,
} from '../../web/state.js';

describe('hash routing', () => {
  it('parses known routes and project ids', () => {
    expect(parseRoute('#/inbox')).toEqual({ view: 'inbox', id: '' });
    expect(parseRoute('#/project/abc%20123')).toEqual({ view: 'project', id: 'abc 123' });
    expect(routeHash('project', 'abc 123')).toBe('#/project/abc%20123');
  });

  it('falls back safely for unknown or incomplete routes', () => {
    expect(parseRoute('#/unknown')).toEqual({ view: 'home', id: '' });
    expect(parseRoute('#/project')).toEqual({ view: 'home', id: '' });
    expect(parseRoute('#/project/%E0%A4%A')).toEqual({ view: 'home', id: '' });
  });
});

it('formats byte sizes for people', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(1024)).toBe('1.00 KB');
  expect(formatBytes(12 * 1024 * 1024)).toBe('12.0 MB');
});

it('escapes untrusted display text', () => {
  expect(escapeHtml('<img src=x onerror="bad">')).toBe(
    '&lt;img src=x onerror=&quot;bad&quot;&gt;',
  );
});

it('round-trips selection keys with paths', () => {
  const key = itemKey({ type: 'file', id: '/home/omnideck/My notes.md' });
  expect(splitItemKey(key)).toEqual({ type: 'file', id: '/home/omnideck/My notes.md' });
});

it('builds encoded same-origin file URLs', () => {
  expect(fileUrl('/home/omnideck/My notes.md')).toBe('/home/omnideck/My%20notes.md');
  expect(fileUrl('relative.txt')).toBe('#');
});

it('builds a non-destructive project chat prompt', () => {
  const prompt = projectPrompt(
    { name: 'Trip' },
    [{ type: 'conversation' }, { type: 'artifact' }, { type: 'artifact' }],
  );
  expect(prompt).toContain('1 conversation, 2 artifacts');
  expect(prompt).toContain('Do not move or delete files');
});
