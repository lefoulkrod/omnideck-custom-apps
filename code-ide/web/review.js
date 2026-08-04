/* ===== Code Observatory — Review =====
 *
 * Two questions about a changeset, answered without reading the diff:
 *   1. Did it write something the project already had?
 *   2. What exercises the new code, and in whose words?
 */

import { state } from './state.js';
import { $, escapeHtml } from './dom.js';
import { api, showToast } from './api.js';
import { basename } from './breadcrumb.js';
import { revealLine } from './editor.js';

let openFileFn = null;
let openDiffFn = null;
let report = null;

/* The selected workspace, not the repository. Every path in the report is
 * relative to it. */
function workspace() {
  return state.rootDir || state.homePath;
}
function absPath(rel) {
  return workspace().replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
}

async function open(module, line) {
  if (!openFileFn) return;
  if (report && report.openable === false) {
    showToast(
      `${module} is shown as it was at ${report.target}. Compare against the working tree to open it.`,
      'info',
    );
    return;
  }
  await openFileFn(absPath(module), basename(module), line);
  revealLine(line);
}

export async function refreshReview() {
  const status = $('review-status');
  const scope = $('review-scope');
  const res = await api('review_status', { path: workspace() });

  if (res.error) { status.textContent = res.error; scope.textContent = ''; return; }

  /* Git resolves upward to the repository root, so a workspace can be a whole
   * repository, one directory inside a larger one, or not versioned at all.
   * Say which, instead of letting the difference stay invisible.
   *
   * Only an explicit false means "not a repository". A missing field means an
   * older backend or a response shape we do not recognise, and guessing "not a
   * repository" from that is a confident wrong answer. Leave Run enabled and
   * let the real attempt report the real error. */
  if (res.is_repo === false) {
    scope.className = 'review-scope not-repo';
    scope.textContent = res.git_error
      ? `Git could not read ${res.checked_path || 'this workspace'}: ${res.git_error}`
      : `Not a git repository: ${res.checked_path || 'this workspace'}`;
    status.textContent =
      'Open the repository as your workspace with the Open Folder button.';
    return;
  }
  scope.className = 'review-scope';
  if (res.repo_name) {
    scope.textContent = res.is_repo_root
      ? `whole repository ${res.repo_name}`
      : `${res.scope} in ${res.repo_name}`;
  } else {
    scope.textContent = '';
  }
  status.textContent = res.head_sha
    ? `HEAD ${res.head_sha}${res.is_dirty ? ' · working tree dirty' : ' · clean'}`
    : 'Pick base and target, then run.';
  fillCommits('review-base', res.recent_commits || [], 'HEAD');
  fillCommits('review-target', res.recent_commits || [], 'working');
}

function fillCommits(selectId, commits, fallback) {
  const sel = $(selectId);
  const previous = sel.value;
  sel.innerHTML = '';
  if (selectId === 'review-target') {
    sel.appendChild(new Option('Working Tree', 'working'));
  }
  sel.appendChild(new Option(`HEAD (${commits[0]?.sha || ''})`, 'HEAD'));
  for (const c of commits.slice(1)) {
    sel.appendChild(new Option(`${c.sha} ${c.message.slice(0, 50)}`, c.sha));
  }
  sel.value = previous || fallback;
}

export async function runReview() {
  const status = $('review-status');
  const body = $('review-body');
  const base = $('review-base').value || 'HEAD';
  const target = $('review-target').value || 'working';
  status.textContent = 'Checking…';
  body.innerHTML =
    '<div class="loading"><div class="spinner"></div>Indexing both revisions…</div>';

  const res = await api('review', { path: workspace(), base, target });
  if (res.error) {
    status.textContent = res.error;
    body.innerHTML = '';
    showToast(res.error, 'error');
    return;
  }
  report = res;
  // Persist report so it survives page refresh
  await api('save_state', { data: JSON.stringify({ __review_report: res }) });
  const d = res.diff_stat || {};
  status.textContent =
    `${res.base} → ${res.target} · ${d.files || 0} files · +${d.insertions || 0} −${d.deletions || 0}`;
  render();

  const reuse = res.reuse.duplicated.length + res.reuse.similar.length;
  const untested = res.tests.uncovered.length;
  showToast(
    `${res.reviewed_functions ?? res.new_functions} functions · ${reuse} reuse flag${reuse === 1 ? '' : 's'} · ${untested} untested`,
    reuse || untested ? 'info' : 'success',
  );
}

export async function loadReview() {
  const saved = await api('load_state');
  if (saved.error || !saved.data) return;
  try {
    const data = JSON.parse(saved.data);
    if (data.__review_report) {
      report = data.__review_report;
      const d = report.diff_stat || {};
      const status = $('review-status');
      if (status) status.textContent =
        `${report.base} → ${report.target} · ${d.files || 0} files · +${d.insertions || 0} −${d.deletions || 0}`;
      render();
    }
  } catch {}
}

function sectionHeader(text, count, tone) {
  const el = document.createElement('div');
  el.className = 'obs-section-title' + (tone ? ' ' + tone : '');
  el.innerHTML = `<span>${escapeHtml(text)}</span>` +
    (count != null ? `<span class="obs-section-count">${count}</span>` : '');
  return el;
}

function row(className, innerNodes, title, onClick) {
  const el = document.createElement('div');
  el.className = className;
  for (const n of innerNodes) el.appendChild(n);
  if (title) el.title = title;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function render() {
  const body = $('review-body');
  body.innerHTML = '';
  if (!report) return;

  // ---- files changed, grouped by directory ----
  const diffDirs = report.diff_stat?.dirs;
  if (diffDirs && diffDirs.length) {
    body.appendChild(sectionHeader('Changed files', report.diff_stat.files));
    for (const dir of diffDirs) {
      const dirRow = document.createElement('div');
      dirRow.className = 'review-dir';
      const dirLabel = document.createElement('span');
      dirLabel.className = 'review-dir-label';
      const icon = document.createElement('i');
      icon.className = 'bi bi-folder2-open';
      dirLabel.append(icon, document.createTextNode(' ' + dir.dir));
      const dirStat = document.createElement('span');
      dirStat.className = 'review-dir-stat';
      dirStat.textContent = `${dir.files} file${dir.files === 1 ? '' : 's'} · +${dir.insertions} −${dir.deletions}`;
      dirRow.append(dirLabel, dirStat);
      body.appendChild(dirRow);

      for (const entry of dir.entries) {
        const fileRow = document.createElement('div');
        fileRow.className = 'review-file';
        const fileIcon = document.createElement('i');
        fileIcon.className = 'bi bi-file-earmark';
        const fileName = document.createElement('span');
        fileName.className = 'review-file-name';
        fileName.textContent = entry.path.split('/').pop();
        const fileStat = document.createElement('span');
        fileStat.className = 'review-file-stat';
        const parts = [];
        if (entry.insertions) parts.push(`+${entry.insertions}`);
        if (entry.deletions) parts.push(`−${entry.deletions}`);
        fileStat.textContent = parts.join(' ');
        fileRow.append(fileIcon, fileName, fileStat);
        fileRow.title = entry.path;
        fileRow.addEventListener('click', () => open(entry.path, 1));
        body.appendChild(fileRow);
      }
    }
  }

  // ---- unchecked languages come first: silence must not read as a pass ----
  const unchecked = report.checked.test_linkage_unavailable_for || [];
  if (unchecked.length) {
    const warn = document.createElement('div');
    warn.className = 'review-unchecked';
    warn.textContent =
      `Tests not checked for: ${unchecked.join(', ')}. No test findings below cover these files.`;
    body.appendChild(warn);
  }

  // ---- reuse ----
  const { duplicated, similar, method } = report.reuse;
  const reuseTotal = (report.reuse.duplicated_total ?? duplicated.length)
    + (report.reuse.similar_total ?? similar.length);
  body.appendChild(sectionHeader('Potential duplicates', reuseTotal,
    reuseTotal ? 'warn' : 'ok'));

  if (!duplicated.length && !similar.length) {
    body.appendChild(row('review-empty', [span('', 'Nothing new duplicates existing code.')]));
  }

  for (const h of duplicated) {
    body.appendChild(row('review-row',
      [
        span('review-tag copied', 'copied'),
        span('review-name', h.name + '()'),
        span('review-detail', `${h.match_lines} lines also in ${h.match_module}`),
      ],
      `${h.module}:${h.line}\nmatches ${h.match_module}`,
      () => open(h.module, h.line),
    ));
  }
  for (const h of similar) {
    const sameName = h.name === h.other_name;
    const label = sameName
      ? `${h.name}() in ${h.module} — also in ${h.other_module}`
      : `${h.name}() in ${h.module} — resembles ${h.other_name}() in ${h.other_module}`;
    body.appendChild(row('review-row',
      [span('review-label', label)],
      `${h.module}:${h.line} → ${h.other_module}`,
      () => {
        if (openDiffFn && h.new_body != null && h.other_body != null) {
          openDiffFn({
            name: `${h.name} vs ${h.other_name}`,
            path: h.module,
            original: h.other_body,
            modified: h.new_body,
            repositoryRoot: workspace(),
            sourcePath: absPath(h.module),
            status: ' ',
            labelLeft: `${h.other_module}:${h.other_line}`,
            labelRight: `${h.module}:${h.line}`,
          });
        } else {
          open(h.other_module, h.other_line || 1);
        }
      },
    ));
  }
  const shownReuse = duplicated.length + similar.length;
  if (reuseTotal > shownReuse) {
    const more = document.createElement('div');
    more.className = 'review-method-note';
    more.textContent = `Showing the ${shownReuse} largest of ${reuseTotal}.`;
    body.appendChild(more);
  }
  if (method === 'name') {
    const note = document.createElement('div');
    note.className = 'review-method-note';
    note.textContent =
      'Matched on names only. Install fastembed to also catch duplicates that were renamed.';
    body.appendChild(note);
  }

  // ---- tests ----
  const { covered, uncovered } = report.tests;
  const reviewed = report.reviewed_functions ?? report.new_functions;
  const mix = report.changed_functions
    ? ` · ${report.new_functions} new, ${report.changed_functions} changed`
    : '';
  body.appendChild(sectionHeader(
    `Test coverage`, `Covered by tests (${covered.length}/${reviewed})${mix}`,
    uncovered.length ? 'warn' : 'ok'));

  if (!reviewed) {
    const note = document.createElement('div');
    note.className = 'review-empty';
    note.textContent =
      'No functions were added or rewritten in this range, so there is nothing to check.';
    body.appendChild(note);
  }

  for (const c of covered) {
    body.appendChild(row('review-row review-covered',
      [
        span('review-tag ok', '\u2713'),
        span('review-name', c.name + '()'),
        span('review-detail', `${c.module}:${c.line}`),
        span('review-depth', c.depth === 1 ? 'direct' : '1 hop'),
      ],
      `${c.module}:${c.line}`, () => open(c.module, c.line)));

    // Each test is a place in the codebase too, so it opens like anything else.
    for (const t of c.tests) {
      body.appendChild(row('review-testrow',
        [
          span('review-testname', t.name),
          span('review-testpath', `${t.module}:${t.line}`),
        ],
        `${t.module}:${t.line}`, () => open(t.module, t.line)));
    }
  }

  if (uncovered.length) {
    body.appendChild(sectionHeader('Untested functions', uncovered.length, 'warn'));
    for (const u of uncovered) {
      body.appendChild(row('review-row review-uncovered',
        [
          span('review-tag miss', '—'),
          span('review-name', u.name + '()'),
          span('review-detail', `${u.size} lines · ${u.module}`),
        ],
        `${u.module}:${u.line}`, () => open(u.module, u.line),
      ));
    }
  }
}

export function resetReview() {
  report = null;
  const body = $('review-body');
  if (body) body.innerHTML = '';
  const status = $('review-status');
  if (status) status.textContent = 'Pick base and target, then run.';
  const scope = $('review-scope');
  if (scope) { scope.textContent = ''; scope.className = 'review-scope'; }
  for (const id of ['review-base', 'review-target']) {
    const sel = $(id);
    if (sel) sel.innerHTML = '';
  }
}

export function initReview(openFile, openDiff) {
  openFileFn = openFile;
  openDiffFn = openDiff;
  $('review-run').addEventListener('click', runReview);
  $('review-base').addEventListener('change', () => { report = null; });
  $('review-target').addEventListener('change', () => { report = null; });
}
