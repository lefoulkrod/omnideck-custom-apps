# Code Observatory — Metrics & Structure views in Code IDE

## Goal
Add two new sidebar views (tabs) to the existing `code-ide` Custom App:
1. **Structure** — repo file/dir tree annotated with per-file metrics (LOC, complexity). Click a file → opens in editor.
2. **Metrics** — dashboard: summary cards, complexity hotspots, largest files, duplication report, readability ranking, sortable per-file table.

Both read from a single **on-demand metrics index** built by a backend action.

## Backend (`metrics.py` + actions in `app.py`)

New module `metrics.py` (pure stdlib — `ast` for Python, heuristics for other langs).

### Action: `metrics_index(path="", refresh=False)`
- Walk repo under `path` (respect `SEARCH_IGNORED_DIRS` + hidden skip).
- Per source file (by extension → language):
  - `lines`: total / code / comment / blank
  - `size`: bytes
  - `complexity`: cyclomatic complexity
    - Python: AST branch counting (if/for/while/except/with/and/or/assert/comprehensions/boolop) per function + file total
    - Other: keyword/operator heuristic (if/else/for/while/case/catch/switch/&&/||/?/elif)
  - `functions`: [{name, line, complexity, length}] (Python AST; others: file-level only)
  - `readability`: 0–100 composite (comment ratio, avg line length, avg function length, identifier density)
  - `language`
- **Duplication**: normalize lines (strip whitespace/comments), rolling hash, find repeated blocks ≥6 lines across files → groups with file+line ranges.
- **Summary**: totals (files, LOC, code, comment, blank), avg complexity, max complexity, duplication %, top hotspots, largest files, least-readable files.
- Cache to `data/metrics-<sha8>.json` keyed by resolved path. Return cached unless `refresh=True`.
- Caps: skip files >512KB, skip binary, limit ~5000 files.

### Action: `metrics_status(path="")`
- Lightweight: returns whether a cached index exists + its mtime + file count (for the "Build/Refresh" button state).

## Frontend

### index.html
- Activity bar: add `btn-structure` (bi-diagram-3) and `btn-metrics` (bi-bar-chart-line) between source-control and settings.
- Sidebar: add `structure-view` and `metrics-view` divs (hidden).

### dom.js
- Add refs: `structureView`, `metricsView`, and inner container ids.

### sidebar.js
- Generalize `setSidebarView` to handle views: explorer / source-control / structure / metrics.

### structure.js (new)
- Header with "Build Index" / "Refresh" button + status.
- Renders directory→file tree from the metrics index. Each file row: name, LOC badge, complexity badge (color-coded). Click → open in editor (reuse openFile). Expand/collapse dirs.

### metrics.js (new)
- Header with "Build Index" / "Refresh".
- Summary cards row (files, LOC, avg complexity, duplication %).
- Sections: Complexity Hotspots (top functions), Largest Files, Duplication Groups, Readability (least readable), and a sortable per-file table.
- Clicking a row opens the file in the editor.

### main.js
- Import + init structure/metrics; wire activity-bar buttons; add command-palette entries.

### app.css
- Add styles for the new views (cards, badges, tree rows, tables, hotspot bars).

## Testing
- Unit test `metrics.py` complexity/lines/duplication/readability on sample snippets (pytest in `tests/`).
- Manual: build index on the `code-ide` app itself + on an omnideck repo; verify JSON shape and that views render.

## Status: DONE (v1)

- Backend `metrics.py` + actions `metrics_index` / `metrics_status` — implemented, cached, tested.
- Structure view + Metrics view added as sidebar tabs — wired, rendered, click-to-open verified in browser.
- 40 unit tests passing (20 new in `tests/test_metrics.py`).
- On-demand build from UI verified ("Indexed 36 files").

## Out of scope (v1)
- Coverage (runtime), architectural drift, regressions, impact analysis, symbol references, diffs/tests views. These land later.