# Code Observatory — Symbol Explorer (Structure tab rework)

## Vision
A new way to view code projects: navigate by **symbol and relationship**, not by
file/line. Understand the overall structure (architecture shape, call graph,
dependencies) — the thing that matters in the age of AI, where reading every
line is less important than seeing how the pieces connect.

Replaces the metrics-annotated file tree in the **Structure** tab. Metrics tab
stays as-is.

## Stack (open source)
- **tree-sitter** via `tree-sitter-language-pack` (already pip-installed) —
  accurate syntax parsing for ~15+ languages. Used for symbol/call/import
  extraction.
- **Reference resolution by name + scope** — tree-sitter gives syntax; we
  resolve a call to a definition by matching the callee name against symbols
  visible in that file's scope (same-file defs + imported names + global
  by-name). Approximate but effective — the ctags/LSP-lite approach.
- **D3.js** (vendored) — force-directed graph for the module dependency view
  and the per-symbol call-neighborhood view.

## Backend — `symbols.py`

### Per-language query registry
Map language → tree-sitter query capturing:
- **definitions**: function/method/class/type/struct with `@name`, `@kind`, `@node`
- **calls**: call expressions with `@callee` (bare id or `obj.method` → method name)
- **imports**: import statements with `@module` / `@imported_name`

Languages with queries: python, javascript, typescript, tsx, go, rust, java, c,
cpp, csharp, ruby, php, kotlin, swift, scala, lua. Others skipped gracefully.

### `build_symbol_index(root)` → cached JSON
1. Walk repo (reuse `metrics.py` ignored dirs + binary skip).
2. Per file: parse, extract definitions/calls/imports.
   - Each definition: `{id, module, name, kind, qname, line, end_line, signature, enclosing (parent class id), size_lines}`.
   - Each call: `{callee_name, line, enclosing_symbol_id}`.
   - Each import: `{module_path, imported_names[]}`.
3. Global symbol table: `name → [def_ids]`.
4. **Resolve**:
   - For each call, find a definition whose name matches, visible in scope:
     same-file > imported > global. Record `resolved_def_id` (best guess) or null.
   - Build per-symbol `callees[]` (resolved def ids, deduped) and `callers[]` (reverse).
   - Build module dependency edges: file → files it imports (resolve import
     module names to file paths by basename/stem matching).
5. Output:
   - `modules[]`: `{id, path, language, symbol_ids[], depends_on[], imported_names[]}`
   - `symbols[]`: `{id, module, name, kind, qname, line, end_line, signature, enclosing, size, callees[], callers[], complexity?}`
   - `edges[]`: module dependency edges `{from, to}` for the graph
   - `summary`: counts, languages, most-called symbols, most-connected modules
6. Cache to `data/symbols-<sha8>.json`.

### Actions in `app.py`
- `symbol_index(path="", refresh=False)` — build or return cached.
- `symbol_status(path="")` — cache existence + counts.
- `symbol_neighborhood(symbol_id)` — return a symbol + its callers/callees
  (resolved, with names/modules/lines) for the focused graph view. (Can also
  be computed client-side from the cached index; keep server-side for simplicity
  if the index is large.)

## Frontend — rework `structure.js` → Symbol Explorer

Three panes / modes (toggle in the Structure header):
1. **Graph** (default) — D3 force-directed module dependency graph. Nodes =
   modules (sized by symbol count, colored by language). Edges = imports.
   Click a module → switches to Tree mode scoped to that module. Hover → tooltip
   with file/lang/symbol count. Zoom/pan.
2. **Tree** — module → class → method/function symbol tree. Kind icons
   (ƒ function, C class, M method, T type). Click symbol → jump to line in
   editor + load its details.
3. **Details** (right-side or below) — selected symbol: signature, kind, size,
   callees list (click → navigate), callers list (click → navigate), and a
   mini call-neighborhood graph (D3) of its immediate callers/callees.

Plus: **symbol search** box (fuzzy filter across all symbols), and a
**Build/Refresh** button.

## Files to change
- New: `symbols.py`, `web/symbol-explorer.js`, `web/vendor/d3.min.js`
- Edit: `app.py` (add actions), `web/index.html` (structure-view markup),
  `web/main.js` (wire), `web/app.css` (graph + symbol styles), `web/dom.js`
- Remove/replace: `web/structure.js` content → symbol explorer
- Tests: `tests/test_symbols.py`

## Testing
- Unit tests: extraction (defs/calls/imports) per language, scope resolution,
  caller/callee symmetry, module dependency edges.
- Manual: build index on code-ide (py+js) and omnideck-cli (go); verify graph
  renders, symbol tree navigates, click-to-jump works, callers/callees correct.

## Status: DONE (v1)

- Backend `symbols.py` (tree-sitter, 15 languages, call-graph + dependency edges) + actions
  `symbol_index` / `symbol_status` — implemented, cached, tested.
- Structure tab reworked into Symbol Explorer: dependency graph (D3), symbol tree,
  symbol details with callees/callers, jump-to-line, cross-symbol navigation.
- 53 unit tests passing (13 new in `tests/test_symbols.py`).
- Verified in browser: graph renders (38 nodes/105 edges), tree navigates,
  click-to-jump works, bidirectional call graph resolves across files.

## Status: DONE (v1)

- `symbols.py` fixed: module edges now derived from cross-module calls (not just
  imports) — CLI went 14→142 edges, main app 3576 edges.
- `insights.py` (networkx): Louvain communities, drift report, PageRank,
  betweenness, SCC cycles, transitive dependents.
- New "Architecture Insights" tab: summary cards, cycles, misplaced files,
  subsystems (collapsible), load-bearing/bottleneck/most-depended rankings.
- Actions `insights` / `insights_status` added; 53 tests pass.
- Verified on ~/omnideck (991 modules, Q=0.565, 121 subsystems, 136-module
  cycle detected) and code-ide (Q=0.216, 8 subsystems).

## Out of scope (later)
- Precise semantic resolution (true LSP/SCIP), type-aware overloads, dynamic
  dispatch, cross-repo. The name+scope resolution is intentionally approximate.