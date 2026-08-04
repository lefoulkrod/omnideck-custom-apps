import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initDom } from '../../web/dom.js';
import { initReview, refreshReview, runReview } from '../../web/review.js';
import { state } from '../../web/state.js';

function report(overrides = {}) {
  return {
    base: 'HEAD',
    target: 'Working Tree',
    new_functions: 2,
    diff_stat: { files: 3, insertions: 40, deletions: 5 },
    reuse: {
      method: 'name+meaning',
      duplicated: [{
        name: 'projectTurns', module: 'src/events/projectTurns.js', line: 27,
        match_lines: 9, match_module: 'src/hooks/useStreamingChat.js',
      }],
      similar: [{
        name: 'html_to_markdown', module: 'src/mime.py', line: 53,
        other_name: 'html_to_markdown', other_module: 'browser/_html.py',
        score: 0.918, method: 'meaning',
      }],
    },
    tests: {
      covered: [{
        name: 'render_email_body', module: 'src/mime.py', line: 12, size: 30,
        depth: 1,
        tests: [{
          name: 'test_renderer_decodes_declared_charset',
          module: 'tests/test_mime.py', line: 9,
        }],
      }],
      uncovered: [{
        name: 'send_message', module: 'src/gmail.py', line: 150, size: 40,
      }],
    },
    checked: { languages_in_change: ['python'], test_linkage_unavailable_for: [] },
    ...overrides,
  };
}

function mockInvoke(result) {
  window.omnideck = {
    invoke: vi.fn(async (action) => (
      action === 'review_status'
        ? {
            head_sha: 'abc1234', is_dirty: true, recent_commits: [],
            is_repo: true, repo_name: 'monorepo', scope: 'code-ide',
            is_repo_root: false,
          }
        : result
    )),
  };
}

describe('review view', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="review-run"></button>
      <div id="review-status"></div>
      <select id="review-base"></select>
      <select id="review-target"></select>
      <div id="review-scope"></div>
      <div id="review-body"></div>
      <div id="toast"><i></i><span id="toast-msg"></span></div>
    `;
    initDom();
    state.rootDir = '/home/me/project';
    state.homePath = '/home/me';
  });

  it('names the repository when the workspace is only part of one', async () => {
    mockInvoke(report());
    initReview(vi.fn());
    await refreshReview();

    expect(document.getElementById('review-scope').textContent)
      .toBe('code-ide in monorepo');
  });

  it('says so plainly when the workspace is not a repository', async () => {
    window.omnideck = {
      invoke: vi.fn(async () => ({
        is_repo: false, repo_root: '', repo_name: '', scope: '', is_repo_root: false,
      })),
    };
    initReview(vi.fn());
    await refreshReview();

    const scope = document.getElementById('review-scope');
    expect(scope.textContent).toContain('Not a git repository');
    expect(scope.classList.contains('not-repo')).toBe(true);
  });

  it('reports why git failed rather than claiming it is not a repository', async () => {
    window.omnideck = {
      invoke: vi.fn(async () => ({
        is_repo: false, git_error: 'detected dubious ownership in repository',
      })),
    };
    initReview(vi.fn());
    await refreshReview();

    expect(document.getElementById('review-scope').textContent)
      .toContain('detected dubious ownership');
  });

  it('does not claim "not a repository" when the field is simply absent', async () => {
    window.omnideck = { invoke: vi.fn(async () => ({ head_sha: 'abc1234' })) };
    initReview(vi.fn());
    await refreshReview();

    const scope = document.getElementById('review-scope');
    expect(scope.classList.contains('not-repo')).toBe(false);
    expect(scope.textContent).not.toContain('Not a git repository');
    expect(document.getElementById('review-run').disabled).toBe(false);
  });

  it('lists reuse findings and the test names that cover new code', async () => {
    mockInvoke(report());
    initReview(vi.fn());
    await runReview();

    const body = document.getElementById('review-body').textContent;
    expect(body).toContain('projectTurns()');
    expect(body).toContain('9 lines also in src/hooks/useStreamingChat.js');
    expect(body).toContain('resembles html_to_markdown() in browser/_html.py');
    expect(body).toContain('test_renderer_decodes_declared_charset');
    expect(body).toContain('tests/test_mime.py:9');
    expect(body).toContain('src/mime.py:12');
    expect(body).toContain('send_message()');
    expect(document.getElementById('review-status').textContent)
      .toContain('3 files');
  });

  it('opens the file when a finding is clicked', async () => {
    const openFile = vi.fn();
    mockInvoke(report());
    initReview(openFile);
    await runReview();

    document.querySelector('.conf-row').click();
    expect(openFile).toHaveBeenCalledWith(
      '/home/me/project/src/events/projectTurns.js', 'projectTurns.js', 27,
    );
  });

  it('says which languages went unchecked instead of implying a pass', async () => {
    mockInvoke(report({
      checked: {
        languages_in_change: ['elixir'],
        test_linkage_unavailable_for: ['elixir'],
      },
    }));
    initReview(vi.fn());
    await runReview();

    expect(document.querySelector('.conf-unchecked').textContent)
      .toContain('Tests not checked for: elixir');
  });

  it('does not execute markup coming from a symbol name', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const data = report();
    data.tests.uncovered[0].name = hostile;
    mockInvoke(data);
    initReview(vi.fn());
    await runReview();

    const body = document.getElementById('review-body');
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain(hostile);
  });
});
