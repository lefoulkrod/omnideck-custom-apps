"""
Code Observatory — symbol index engine.

Uses tree-sitter (via tree_sitter_language_pack) to extract definitions, call
sites, and imports across many languages, then resolves references by name +
scope to build a project-wide call graph and module dependency graph.

Resolution is intentionally approximate (name + scope matching, no type
inference) — the ctags/LSP-lite approach. It is meant for navigating the
*shape* of a codebase, not for precise semantic go-to-definition.
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from pathlib import Path

from tree_sitter_language_pack import get_parser
from tree_sitter import Query, QueryCursor

# ---- Languages we can index ------------------------------------------------

# language -> (definition_query, call_query, import_query)
# Definition captures: @name (str), @kind (str literal), @node (the def node)
# Call captures: @callee (str), @node (call node)
# Import captures: @node (import node); module/Names parsed from node text.

LANG_QUERIES: dict[str, tuple[str, str, str]] = {
    "python": (
        """
        (function_definition name: (identifier) @name) @node
        (class_definition name: (identifier) @name) @node
        """,
        """
        (call function: [(identifier) @callee (attribute attribute: (identifier) @callee)]) @node
        """,
        """
        (import_statement) @node
        (import_from_statement) @node
        """,
    ),
    "javascript": (
        """
        (function_declaration name: (identifier) @name) @node
        (method_definition name: (property_identifier) @name) @node
        (class_declaration name: (identifier) @name) @node
        (variable_declarator name: (identifier) @name value: (arrow_function) @af) @node
        (variable_declarator name: (identifier) @name value: (function_expression) @fe) @node
        """,
        """
        (call_expression function: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node
        (new_expression constructor: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node
        (jsx_opening_element name: (identifier) @callee) @node
        (jsx_self_closing_element name: (identifier) @callee) @node
        """,
        """
        (import_statement) @node
        """,
    ),
    "typescript": (
        """
        (function_declaration name: (identifier) @name) @node
        (method_definition name: (property_identifier) @name) @node
        (class_declaration name: (type_identifier) @name) @node
        (interface_declaration name: (type_identifier) @name) @node
        (method_signature name: (property_identifier) @name) @node
        (variable_declarator name: (identifier) @name value: (arrow_function) @af) @node
        (variable_declarator name: (identifier) @name value: (function_expression) @fe) @node
        """,
        """
        (call_expression function: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node
        (new_expression constructor: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node
        """,
        """
        (import_statement) @node
        """,
    ),
    "tsx": (
        """
        (function_declaration name: (identifier) @name) @node
        (method_definition name: (property_identifier) @name) @node
        (class_declaration name: (type_identifier) @name) @node
        (interface_declaration name: (type_identifier) @name) @node
        (variable_declarator name: (identifier) @name value: (arrow_function) @af) @node
        """,
        """
        (call_expression function: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node
        (new_expression constructor: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node
        (jsx_opening_element name: (identifier) @callee) @node
        (jsx_self_closing_element name: (identifier) @callee) @node
        """,
        """
        (import_statement) @node
        """,
    ),
    "go": (
        """
        (function_declaration name: (identifier) @name) @node
        (method_declaration name: (field_identifier) @name) @node
        (type_spec name: (type_identifier) @name) @node
        """,
        """
        (call_expression function: [(identifier) @callee (selector_expression field: (field_identifier) @callee)]) @node
        """,
        """
        (import_declaration) @node
        """,
    ),
    "rust": (
        """
        (function_item name: (identifier) @name) @node
        (struct_item name: (type_identifier) @name) @node
        (enum_item name: (type_identifier) @name) @node
        (trait_item name: (type_identifier) @name) @node
        (impl_item type: (type_identifier) @name) @node
        """,
        """
        (call_expression function: [(identifier) @callee (field_expression field: (field_identifier) @callee)]) @node
        """,
        """
        (use_declaration) @node
        """,
    ),
    "java": (
        """
        (method_declaration name: (identifier) @name) @node
        (class_declaration name: (identifier) @name) @node
        (interface_declaration name: (identifier) @name) @node
        (constructor_declaration name: (identifier) @name) @node
        """,
        """
        (method_invocation name: (identifier) @callee) @node
        (object_creation_expression type: [(type_identifier) @callee (scoped_type_identifier name: (type_identifier) @callee)]) @node
        """,
        """
        (import_declaration) @node
        """,
    ),
    "c": (
        """
        (function_definition declarator: (identifier) @name) @node
        (function_definition declarator: (function_declarator declarator: [(identifier) @name (pointer_declarator declarator: (identifier) @name)]) @node2) @node
        (struct_specifier name: (type_identifier) @name) @node
        (type_definition declarator: (type_identifier) @name) @node
        """,
        """
        (call_expression function: [(identifier) @callee (field_expression field: (field_identifier) @callee)]) @node
        """,
        """
        (preproc_include) @node
        """,
    ),
    "cpp": (
        """
        (function_definition declarator: (function_declarator declarator: [(identifier) @name (field_identifier) @name (qualified_identifier name: (identifier) @name)]) @node
        (class_specifier name: (type_identifier) @name) @node
        (struct_specifier name: (type_identifier) @name) @node
        """,
        """
        (call_expression function: [(identifier) @callee (field_expression field: (field_identifier) @callee) (qualified_identifier name: (identifier) @callee)]) @node
        """,
        """
        (preproc_include) @node
        """,
    ),
    "ruby": (
        """
        (method name: [(identifier) @name (constant) @name]) @node
        (class name: (constant) @name) @node
        (module name: (constant) @name) @node
        (singleton_method name: (identifier) @name) @node
        """,
        """
        (call method: (identifier) @callee) @node
        """,
        """
        (call method: (identifier) @callee) @impnode
        """,
    ),
    "php": (
        """
        (function_definition name: (name) @name) @node
        (method_declaration name: (name) @name) @node
        (class_declaration name: (name) @name) @node
        """,
        """
        (function_call_expression function: [(name) @callee (member_access_expression member: (name) @callee)]) @node
        """,
        """
        (namespace_use_clause) @node
        """,
    ),
    "kotlin": (
        """
        (function_declaration name: (simple_identifier) @name) @node
        (class_declaration name: (type_identifier) @name) @node
        (object_declaration name: (type_identifier) @name) @node
        """,
        """
        (call_expression function: [(simple_identifier) @callee (navigation_expression suffix: (navigation_suffix member: (simple_identifier) @callee)]) @node
        """,
        """
        (import_header) @node
        """,
    ),
    "swift": (
        """
        (function_declaration name: (simple_identifier) @name) @node
        (class_declaration name: (type_identifier) @name) @node
        (struct_declaration name: (type_identifier) @name) @node
        (protocol_declaration name: (type_identifier) @name) @node
        """,
        """
        (call_expression function: [(simple_identifier) @callee (navigation_expression suffix: (navigation_expression member: (simple_identifier) @callee)]) @node
        """,
        """
        (import_declaration) @node
        """,
    ),
    "scala": (
        """
        (function_definition name: (identifier) @name) @node
        (class_definition name: (identifier) @name) @node
        (object_definition name: (identifier) @name) @node
        (trait_definition name: (identifier) @name) @node
        """,
        """
        (call_expression function: [(identifier) @callee (field_expression field: (identifier) @callee)]) @node
        """,
        """
        (import_declaration) @node
        """,
    ),
    "lua": (
        """
        (function_declaration name: [(identifier) @name (dot_index_expression field: (identifier) @name)]) @node
        (function_definition name: [(identifier) @name (dot_index_expression field: (identifier) @name)]) @node
        """,
        """
        (function_call name: [(identifier) @callee (dot_index_expression field: (identifier) @callee)]) @node
        """,
        """
        (function_call name: (identifier) @callee) @impnode
        """,
    ),
}

# Map file extension -> language for symbol indexing
# ---- Named callbacks -------------------------------------------------------
#
# Many languages express a named unit of work as an anonymous function literal
# passed to a call that also carries a string label:
#
#   javascript   it("groups events into turns", () => { ... })
#   ruby         it "groups events into turns" do ... end
#   go           t.Run("groups events into turns", func(t *testing.T) { ... })
#
# Without this, the literal is not a definition, so calls made inside it have
# no enclosing symbol and vanish from the call graph. Registering it as a
# symbol named after the call and its label fixes that with one general rule.
#
# Only literals that sit alongside a string argument are registered. Unlabelled
# closures (useEffect, .map, promise chains) are deliberately left alone: their
# calls then attribute to the nearest named enclosing function, which is what
# you want, and the index does not balloon.
#
# language -> node types that are anonymous function literals
LANG_FUNC_LITERALS: dict[str, set[str]] = {
    "javascript": {"arrow_function", "function_expression"},
    "typescript": {"arrow_function", "function_expression"},
    "tsx": {"arrow_function", "function_expression"},
    "python": {"lambda"},
    "go": {"func_literal"},
    "ruby": {"do_block", "block"},
    "rust": {"closure_expression"},
    "java": {"lambda_expression"},
    "csharp": {"lambda_expression", "anonymous_method_expression"},
    "kotlin": {"lambda_literal"},
    "php": {"anonymous_function_creation_expression", "arrow_function"},
    "swift": {"lambda_literal"},
    "scala": {"lambda_expression"},
}

MAX_CALLBACK_SYMBOLS = 500

SYM_LANG_BY_EXT = {
    ".py": "python",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "tsx",
    ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby", ".php": "php", ".swift": "swift",
    ".scala": "scala", ".lua": "lua",
}

IGNORED_DIRS = {
    ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", "node_modules",
    "dist", "build", ".next", ".cache", ".tox", ".mypy_cache", ".ruff_cache",
    ".pytest_cache", "egg-info", ".eggs", "vendor", "third_party",
    "THIRD_PARTY_LICENSES", "target", "out", "codemirror",
}

MAX_FILE_BYTES = 512 * 1024
MAX_FILES = 6000

# Kinds we report per node type (fallback when no explicit @kind).
_NODE_KIND = {
    "function_definition": "function", "function_declaration": "function",
    "function_item": "function",
    "method_definition": "method", "method_declaration": "method",
    "method": "method", "method_invocation": "method",
    "method_signature": "method", "singleton_method": "method",
    "class_definition": "class", "class_declaration": "class",
    "class_specifier": "class", "struct_specifier": "struct",
    "class": "class", "object_declaration": "object",
    "object_definition": "object",
    "interface_declaration": "interface", "trait_definition": "trait",
    "trait_item": "trait", "protocol_declaration": "protocol",
    "enum_item": "enum", "type_spec": "type", "type_definition": "typedef",
    "struct_declaration": "struct",
    "impl_item": "impl", "module": "module",
    "variable_declarator": "function",  # arrow/function var
}


def _is_ignored_dir(name: str) -> bool:
    return name in IGNORED_DIRS or name.startswith(".")


def _run_query(parser, query_src: str, root_node):
    """Run a query and return a list of capture dicts: {name: [nodes]}."""
    if not query_src.strip():
        return []
    q = Query(parser.language, query_src)
    cur = QueryCursor(q)
    return cur.matches(root_node)


def _first_text(node) -> str:
    if node is None:
        return ""
    if node.text:
        return node.text.decode("utf-8", "replace")
    return ""


def _signature(node, full_text: str) -> str:
    """Best-effort one-line signature: from start of node to first '{' or end of first line."""
    if node is None:
        return ""
    start = node.start_byte
    # find first '{' or newline within the node's first ~200 bytes
    snippet = full_text[start:start + 200]
    for ch in ("{", "\n"):
        idx = snippet.find(ch)
        if idx != -1:
            snippet = snippet[:idx]
            break
    return " ".join(snippet.split())[:160]


def _enclosing_kind(node_type: str) -> str:
    return _NODE_KIND.get(node_type, node_type)


def _is_call_node(node_type: str) -> bool:
    """True for the call/invocation node of any supported grammar."""
    return "call" in node_type or "invocation" in node_type


def _string_literal_text(node) -> str | None:
    """Return the unquoted text of a string node, or None if it is not one."""
    if "string" not in node.type or node.type.endswith("_content"):
        return None
    raw = _first_text(node)
    if len(raw) >= 2 and raw[0] in "\"'`" and raw[-1] == raw[0]:
        raw = raw[1:-1]
    return " ".join(raw.split())[:80]


def _callback_label(literal_node) -> str | None:
    """Name a function literal from the call that carries it.

    Walks up a few levels to the enclosing call, then looks for a sibling
    string argument. Returns e.g. `it("groups events into turns")`, or None
    when the literal has no string label.
    """
    call = literal_node.parent
    for _ in range(3):
        if call is None:
            return None
        if _is_call_node(call.type):
            break
        call = call.parent
    else:
        return None
    if call is None or not _is_call_node(call.type):
        return None

    callee = None
    for field in ("function", "method", "name"):
        child = call.child_by_field_name(field)
        if child is not None:
            callee = _first_text(child)
            break
    if not callee:
        return None
    callee = " ".join(callee.split())[:60]

    # first string argument anywhere directly under the call (or its arg list)
    scopes = [call]
    args = call.child_by_field_name("arguments")
    if args is not None:
        scopes.append(args)
    for scope in scopes:
        for child in scope.named_children:
            label = _string_literal_text(child)
            if label:
                return f'{callee}("{label}")'
    return None


def extract_file(path: Path, root: Path, language: str) -> dict | None:
    """Extract symbols, calls, and imports from one file."""
    queries = LANG_QUERIES.get(language)
    if not queries:
        return None
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw[:4096]:
        return None
    if len(raw) > MAX_FILE_BYTES:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    try:
        parser = get_parser(language)
    except Exception:
        return None
    try:
        tree = parser.parse(raw)
    except Exception:
        return None
    defq, callq, impq = queries
    rel = path.relative_to(root).as_posix()

    # ---- definitions ----
    symbols = []
    # track node -> symbol index for enclosing computation
    node_to_idx: dict = {}

    def add_symbol(node, name, kind):
        if not name:
            return None
        idx = len(symbols)
        sym = {
            "id": f"{rel}::{name}@{node.start_point[0]+1}",
            "module": rel,
            "name": name,
            "kind": kind or _enclosing_kind(node.type),
            "line": node.start_point[0] + 1,
            "end_line": node.end_point[0] + 1,
            "size": max(1, node.end_point[0] - node.start_point[0] + 1),
            "signature": _signature(node, text),
            "enclosing": None,
        }
        symbols.append(sym)
        node_to_idx[node] = idx
        return idx

    for _, caps in _run_query(parser, defq, tree.root_node):
        names = caps.get("name", [])
        nodes = caps.get("node", [])
        for i, name_node in enumerate(names):
            node = nodes[i] if i < len(nodes) else name_node
            add_symbol(node, _first_text(name_node), None)

    # ---- named callbacks (see LANG_FUNC_LITERALS) ----
    literal_types = LANG_FUNC_LITERALS.get(language)
    if literal_types:
        added = 0
        stack = [tree.root_node]
        while stack and added < MAX_CALLBACK_SYMBOLS:
            node = stack.pop()
            if node.type in literal_types:
                label = _callback_label(node)
                if label and node not in node_to_idx:
                    add_symbol(node, label, "callback")
                    added += 1
            stack.extend(node.named_children)

    # compute enclosing: a symbol's enclosing parent is the smallest def node
    # that contains it (other than itself). Use start/end byte ranges.
    def find_enclosing(node):
        best = None
        best_size = None
        for n, idx in node_to_idx.items():
            if n is node:
                continue
            if n.start_byte <= node.start_byte and node.end_byte <= n.end_byte:
                span = n.end_byte - n.start_byte
                if best is None or span < best_size:
                    best = idx
                    best_size = span
        return best

    for n, idx in list(node_to_idx.items()):
        enc = find_enclosing(n)
        if enc is not None and enc != idx:
            symbols[idx]["enclosing"] = symbols[enc]["id"]
            # method inside a class -> kind method
            if symbols[idx]["kind"] == "function" and symbols[enc]["kind"] in ("class", "struct", "impl", "object", "trait", "interface"):
                symbols[idx]["kind"] = "method"

    # ---- calls ----
    calls = []
    for _, caps in _run_query(parser, callq, tree.root_node):
        callees = caps.get("callee", [])
        nodes = caps.get("node", [])
        for i, callee_node in enumerate(callees):
            node = nodes[i] if i < len(nodes) else callee_node
            calls.append({
                "callee": _first_text(callee_node),
                "line": node.start_point[0] + 1,
                "enclosing": _enclosing_symbol_for_call(node, node_to_idx, symbols),
            })

    # ---- imports ----
    imports = []
    for _, caps in _run_query(parser, impq, tree.root_node):
        nodes = caps.get("node", []) or caps.get("impnode", [])
        for node in nodes:
            imports.append(_parse_import(node, text, language))

    return {
        "path": rel,
        "language": language,
        "symbols": symbols,
        "calls": calls,
        "imports": imports,
    }


def _enclosing_symbol_for_call(call_node, node_to_idx, symbols):
    """Find the smallest definition node containing this call."""
    best = None
    best_size = None
    for n, idx in node_to_idx.items():
        if n.start_byte <= call_node.start_byte and call_node.end_byte <= n.end_byte:
            span = n.end_byte - n.start_byte
            if best is None or span < best_size:
                best = idx
                best_size = span
    return symbols[best]["id"] if best is not None else None


def _parse_import(node, text: str, language: str) -> dict:
    """Parse an import node into {module, names[]}."""
    raw = _first_text(node)
    module = ""
    names = []
    if language == "python":
        if raw.startswith("import "):
            rest = raw[7:].split(" as ")[0].strip()
            module = rest
            names = [rest.split(".")[-1]]
        elif raw.startswith("from "):
            m = re.match(r"from\s+([\w.]+)\s+import\s+(.+)", raw)
            if m:
                module = m.group(1)
                imported = m.group(2).strip().rstrip(";")
                if imported == "*":
                    names = ["*"]
                else:
                    names = [n.strip().split(" as ")[0].strip() for n in imported.split(",") if n.strip()]
    elif language in ("javascript", "typescript", "tsx"):
        # import x from './mod' ; import { a, b } from './mod' ; import './mod'
        m = re.search(r"from\s+['\"]([^'\"]+)['\"]", raw)
        if m:
            module = m.group(1)
        else:
            m2 = re.search(r"import\s+['\"]([^'\"]+)['\"]", raw)
            if m2:
                module = m2.group(1)
        nm = re.search(r"import\s+(?:({[^}]*})|(\w+))\s+from", raw)
        if nm:
            grp = nm.group(1)
            if grp:
                names = [n.strip() for n in grp.strip("{}").split(",") if n.strip()]
            elif nm.group(2):
                names = [nm.group(2)]
    elif language == "go":
        m = re.search(r'"([^"]+)"', raw)
        if m:
            module = m.group(1)
            names = [module.split("/")[-1]]
    elif language in ("java", "kotlin", "swift", "scala"):
        m = re.match(r"\s*import\s+([\w.]+)", raw)
        if m:
            module = m.group(1)
            names = [module.split(".")[-1]]
    elif language == "rust":
        m = re.match(r"\s*use\s+([\w:]+)", raw)
        if m:
            module = m.group(1)
            names = [module.split("::")[-1]]
    elif language in ("c", "cpp"):
        m = re.search(r'#include\s+[<"]([^>"]+)[>"]', raw)
        if m:
            module = m.group(1)
            names = [Path(module).stem]
    else:
        module = raw.strip()[:80]
    return {"module": module, "names": names, "raw": raw[:120]}


# ---- Index build -----------------------------------------------------------

def build_symbol_index(root: Path) -> dict:
    """Walk a repo and build the symbol + call-graph + dependency index."""
    files = []
    file_count = 0
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not _is_ignored_dir(d))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            ext = Path(name).suffix.lower()
            language = SYM_LANG_BY_EXT.get(ext)
            if not language:
                continue
            full = Path(current) / name
            data = extract_file(full, root, language)
            if data is None:
                continue
            files.append(data)
            file_count += 1
            if file_count >= MAX_FILES:
                break
        if file_count >= MAX_FILES:
            break

    # ---- global symbol table: name -> [symbol dicts] ----
    by_name: dict[str, list[dict]] = defaultdict(list)
    # module -> set of imported simple names (in-scope)
    module_imported_names: dict[str, set[str]] = defaultdict(set)
    # module -> list of import module strings
    module_imports: dict[str, list[str]] = defaultdict(list)
    for f in files:
        for s in f["symbols"]:
            by_name[s["name"]].append(s)
        for imp in f["imports"]:
            module_imports[f["path"]].append(imp["module"])
            for n in imp["names"]:
                if n and n != "*":
                    module_imported_names[f["path"]].add(n)

    # symbol id -> symbol dict (for cross-module call edge derivation)
    sym_by_id: dict[str, dict] = {}
    for f in files:
        for s in f["symbols"]:
            sym_by_id[s["id"]] = s

    # ---- resolve calls ----
    # For each call, resolve callee name to a symbol id.
    # priority: same-file def > imported-name (global by name) > global by name.
    # callers[callee_id] = set of caller ids; callees[caller_id] = set of callee ids
    callees: dict[str, set[str]] = defaultdict(set)
    callers: dict[str, set[str]] = defaultdict(set)
    unresolved = 0
    resolved = 0
    for f in files:
        path = f["path"]
        local_defs: dict[str, dict] = {}
        for s in f["symbols"]:
            local_defs.setdefault(s["name"], s)
        for c in f["calls"]:
            name = c["callee"]
            if not name:
                continue
            target = None
            if name in local_defs:
                target = local_defs[name]
            else:
                # global by name (covers imported + everything); pick the first
                # non-method if possible to prefer top-level functions.
                cands = by_name.get(name, [])
                if cands:
                    target = next((s for s in cands if s["kind"] in ("function", "method")), cands[0])
            if target is not None:
                resolved += 1
                caller_id = c["enclosing"]
                callee_id = target["id"]
                if caller_id:
                    callees[caller_id].add(callee_id)
                    callers[callee_id].add(caller_id)
                else:
                    # call at module top level (no enclosing function)
                    callees[f"__module__{path}"].add(callee_id)
            else:
                unresolved += 1

    # ---- module dependency edges ----
    # Resolve import module strings to file paths in the repo.
    all_paths = {f["path"] for f in files}
    # build lookup by stem and by dotted path
    by_stem: dict[str, str] = {}
    by_dotted: dict[str, str] = {}
    for p in all_paths:
        stem = Path(p).stem
        by_stem.setdefault(stem, p)
        # python dotted: pkg/mod.py -> pkg.mod
        dotted = p[:-3].replace("/", ".") if p.endswith(".py") else None
        if dotted:
            by_dotted.setdefault(dotted, p)
    # directory -> files (for Go-style package imports)
    dir_to_files: dict[str, list[str]] = defaultdict(list)
    for p in all_paths:
        d = str(Path(p).parent)
        dir_to_files[d].append(p)
    edges = set()

    def resolve_import(src, mod, lang):
        """Return set of target file paths for an import module string."""
        if not mod:
            return set()
        targets = set()
        # python dotted module
        if mod in by_dotted:
            targets.add(by_dotted[mod])
        # exact path
        if mod in all_paths:
            targets.add(mod)
        # stem match (js relative: ./mod -> mod)
        base = mod.rstrip("/").split("/")[-1]
        base = re.sub(r"\.(js|ts|tsx|jsx|mjs|cjs)$", "", base) or base
        if base in by_stem:
            targets.add(by_stem[base])
        # go-style package import: "github.com/x/pkg/sub" -> dir "pkg/sub" or "sub"
        if lang == "go":
            # try matching the last 1-3 path segments against repo dirs
            parts = mod.split("/")
            for nseg in (3, 2, 1):
                if len(parts) >= nseg:
                    cand = "/".join(parts[-nseg:])
                    if cand in dir_to_files:
                        targets.update(dir_to_files[cand])
        return {t for t in targets if t and t != src}

    for f in files:
        src = f["path"]
        for mod in module_imports[src]:
            for t in resolve_import(src, mod, f["language"]):
                edges.add((src, t))

    # cross-module call edges: a call from a symbol in module A to a symbol in
    # module B implies A depends on B. This is a denser, more accurate coupling
    # signal than import statements alone (which miss e.g. Go package calls).
    for s in sym_by_id.values():
        for callee_id in callees.get(s["id"], set()):
            t = sym_by_id.get(callee_id)
            if t and t["module"] != s["module"]:
                edges.add((s["module"], t["module"]))

    # ---- assemble output ----
    symbols_out = []
    for f in files:
        for s in f["symbols"]:
            sid = s["id"]
            s["callees"] = sorted(callees.get(sid, []))
            s["callers"] = sorted(callers.get(sid, []))
            symbols_out.append(s)

    modules_out = []
    for f in files:
        sym_ids = [s["id"] for s in f["symbols"]]
        deps = sorted({t for (s, t) in edges if s == f["path"]})
        modules_out.append({
            "id": f["path"],
            "path": f["path"],
            "language": f["language"],
            "symbols": sym_ids,
            "depends_on": deps,
            "imported_names": sorted(module_imported_names[f["path"]]),
        })

    # summary
    lang_counts: dict[str, int] = defaultdict(int)
    for f in files:
        lang_counts[f["language"]] += 1
    most_called = sorted(
        ((sid, len(cs)) for sid, cs in callers.items() if not sid.startswith("__module__")),
        key=lambda x: -x[1],
    )[:25]

    return {
        "root": str(root),
        "file_count": len(files),
        "symbol_count": len(symbols_out),
        "call_count": resolved,
        "unresolved_calls": unresolved,
        "languages": [{"language": k, "files": v} for k, v in sorted(lang_counts.items(), key=lambda kv: -kv[1])],
        "modules": modules_out,
        "symbols": symbols_out,
        "edges": [{"from": s, "to": t} for (s, t) in sorted(edges)],
        "summary": {
            "files": len(files),
            "symbols": len(symbols_out),
            "edges": len(edges),
            "resolved_calls": resolved,
            "unresolved_calls": unresolved,
            "most_called": [{"id": sid, "callers": n} for sid, n in most_called],
        },
    }