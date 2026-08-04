# Code Observatory — Review Tab

## Goal
A "Review" tab that compares structural indices between two git states
(HEAD vs working tree, or two commits) and shows what the AI changed
at the architecture level — with health verdicts, not raw data.

## Backend — `review.py`

### `review(path, base="HEAD", target="working")`
1. Resolve repo root from `path`.
2. Get changed files: `git diff --name-only <base> <target>`.
3. Load cached full symbol index (the baseline). If none, build it.
4. For changed files only:
   - Deleted → remove symbols
   - Added/modified → re-parse with tree-sitter, replace symbols
5. Re-run call resolution + edge derivation on the full set (fast — ~0.1s).
6. Diff old index vs new index:
   - New/removed symbols (with kind, module, line, complexity)
   - New/removed dependency edges
   - New/removed cycles (SCC diff)
   - Complexity delta (new functions vs repo average)
   - Layering: topological sort, flag skip-layer edges
   - Convention: per-directory stats, flag deviations
   - Blast radius: transitive dependents of changed files
7. Return structured verdict.

### `review_status(path)`
- Does a cached baseline index exist?
- Is the working tree dirty (has uncommitted changes)?
- Current HEAD short SHA.

## Frontend — `review.js` + Review tab

### Layout
- Header: base/target selector (dropdown: "HEAD → Working Tree" default,
  plus recent commits) + "Review" button.
- Summary bar: "7 files changed · +142 −38" (from git diff --stat).
- Verdict sections (each item is a row, click → open file at symbol):
  1. Structural changes (new/removed symbols, new/removed deps)
  2. Health verdicts (complexity, cycles, layering, conventions)
  3. Blast radius (transitive dependents)
- Each verdict is ✅ or ⚠️.

## Files
- New: `review.py`, `web/review.js`
- Edit: `app.py` (add review/review_status actions), `web/index.html`,
  `web/main.js`, `web/app.css`, `web/dom.js`, `web/sidebar.js`
- Tests: `tests/test_review.py`