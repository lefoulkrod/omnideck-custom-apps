import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../web/dom.js';

describe('escapeHtml', () => {
  it('neutralizes a script payload in a file name', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const el = document.createElement('div');
    el.innerHTML = `<span>${escapeHtml(hostile)}</span>`;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe(hostile);
  });

  it('escapes every html-significant character', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary symbol names untouched', () => {
    expect(escapeHtml('render_email_body')).toBe('render_email_body');
    expect(escapeHtml('integrations/brokers/_mime.py')).toBe(
      'integrations/brokers/_mime.py',
    );
  });

  it('renders null and undefined as empty rather than as text', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
