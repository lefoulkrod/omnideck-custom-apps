"""
Code Observatory — metrics engine.

Pure-stdlib code metrics: lines, cyclomatic complexity, duplication, and a
readability score. Python files get AST-accurate per-function complexity; other
languages use a keyword/operator heuristic. Designed to run inside a Custom App
action (fresh process, ~120s budget) so it stays fast and dependency-free.
"""

from __future__ import annotations

import ast
import hashlib
import os
import re
from collections import defaultdict
from pathlib import Path

# ---- Language map ----------------------------------------------------------

LANG_BY_EXT = {
    ".py": "python",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript",
    ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".rb": "ruby", ".php": "php", ".swift": "swift",
    ".scala": "scala", ".clj": "clojure",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".sql": "sql", ".lua": "lua", ".pl": "perl",
    ".html": "html", ".htm": "html", ".xml": "xml", ".svg": "xml",
    ".css": "css", ".scss": "css", ".less": "css",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".md": "markdown", ".markdown": "markdown",
}

# Extensions worth indexing for code metrics (excludes pure data/config).
CODE_EXTS = {
    ".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".go", ".rs",
    ".java", ".kt", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".cs",
    ".rb", ".php", ".swift", ".scala", ".clj", ".sh", ".bash", ".zsh",
    ".sql", ".lua", ".pl",
}

IGNORED_DIRS = {
    ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", "node_modules",
    "dist", "build", ".next", ".cache", ".tox", ".mypy_cache", ".ruff_cache",
    ".pytest_cache", "egg-info", ".eggs", "vendor", "third_party",
    "THIRD_PARTY_LICENSES", "target", "out", "codemirror",
}

MAX_FILE_BYTES = 512 * 1024
MAX_FILES = 6000
MIN_DUPE_BLOCK = 6


def _is_ignored_dir(name: str) -> bool:
    return name in IGNORED_DIRS or name.startswith(".")


# ---- Line counting ---------------------------------------------------------

_COMMENT_PREFIX = {
    "python": "#", "shell": "#", "ruby": "#", "perl": "#",
    "yaml": "#", "toml": "#", "ini": "#",
    "js": "//", "typescript": "//", "go": "//", "rust": "//", "java": "//",
    "c": "//", "cpp": "//", "csharp": "//", "swift": "//", "kotlin": "//",
    "scala": "//", "php": "//", "css": "/*", "less": "/*", "scss": "/*",
    "sql": "--", "lua": "--", "haskell": "--",
    "html": "<!--", "xml": "<!--",
    "markdown": "<!--",
}


_BLOCK_COMMENT_LANGS = {
    "javascript", "typescript", "go", "rust", "java", "c", "cpp", "csharp",
    "swift", "kotlin", "scala", "php", "css", "less", "scss",
}
_HTML_COMMENT_LANGS = {"html", "xml", "markdown"}


def count_lines(text: str, language: str) -> dict:
    """Count total/code/comment/blank lines for a source file."""
    lines = text.splitlines()
    total = len(lines)
    code = comment = blank = 0
    line_prefix = _COMMENT_PREFIX.get(language)
    has_block = language in _BLOCK_COMMENT_LANGS
    has_html_block = language in _HTML_COMMENT_LANGS
    in_block = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            blank += 1
            continue
        is_comment = False
        # ongoing block comment
        if in_block:
            is_comment = True
            if has_block and "*/" in stripped:
                in_block = False
            elif has_html_block and "-->" in stripped:
                in_block = False
        else:
            if line_prefix and stripped.startswith(line_prefix):
                is_comment = True
            elif has_block and stripped.startswith("/*"):
                is_comment = True
                if "*/" not in stripped[2:]:
                    in_block = True
            elif has_html_block and stripped.startswith("<!--"):
                is_comment = True
                if "-->" not in stripped[4:]:
                    in_block = True
        if is_comment:
            comment += 1
        else:
            code += 1
    return {"total": total, "code": code, "comment": comment, "blank": blank}


# ---- Complexity ------------------------------------------------------------

# AST nodes that add a branch to cyclomatic complexity.
_PY_BRANCH_NODES = (
    ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler,
    ast.With, ast.AsyncWith, ast.Assert, ast.IfExp,
    ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp,
)


def _py_function_complexity(node: ast.AST) -> int:
    """Cyclomatic complexity of a function body (base 1)."""
    complexity = 1
    for child in ast.walk(node):
        if isinstance(child, _PY_BRANCH_NODES):
            complexity += 1
        elif isinstance(child, ast.BoolOp):
            complexity += len(child.values) - 1
        elif isinstance(child, (ast.Match,)):
            complexity += 1
            for case in getattr(child, "cases", []):
                complexity += 1
    return complexity


def _py_functions(source: str) -> list[dict]:
    """Return per-function complexity for a Python source string."""
    funcs = []
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return funcs
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            end = getattr(node, "end_lineno", node.lineno)
            funcs.append({
                "name": node.name,
                "line": node.lineno,
                "length": max(1, end - node.lineno + 1),
                "complexity": _py_function_complexity(node),
            })
    return funcs


# Keyword/operator heuristic for non-Python languages.
_KEYWORD_PATTERNS: dict[str, list[re.Pattern]] = {}


def _kw_pattern(words: list[str]) -> list[re.Pattern]:
    return [re.compile(r"\b" + w + r"\b") for w in words]


_KW = {
    "javascript": _kw_pattern(["if", "for", "while", "case", "catch", "switch",
                               "try"]),
    "typescript": _kw_pattern(["if", "for", "while", "case", "catch", "switch",
                               "try"]),
    "go": _kw_pattern(["if", "for", "switch", "case", "select"]),
    "rust": _kw_pattern(["if", "for", "while", "loop", "match", "case"]),
    "java": _kw_pattern(["if", "for", "while", "case", "catch", "switch", "try"]),
    "c": _kw_pattern(["if", "for", "while", "case", "switch"]),
    "cpp": _kw_pattern(["if", "for", "while", "case", "switch", "catch"]),
    "csharp": _kw_pattern(["if", "for", "while", "case", "catch", "switch", "try"]),
    "ruby": _kw_pattern(["if", "elsif", "for", "while", "until", "case", "when",
                         "rescue"]),
    "php": _kw_pattern(["if", "elseif", "for", "while", "case", "catch", "switch"]),
    "shell": _kw_pattern(["if", "elif", "for", "while", "until", "case", "select"]),
    "swift": _kw_pattern(["if", "for", "while", "case", "catch", "switch", "guard"]),
    "kotlin": _kw_pattern(["if", "for", "while", "when", "case", "catch", "try"]),
    "scala": _kw_pattern(["if", "for", "while", "match", "case", "catch", "try"]),
    "lua": _kw_pattern(["if", "elseif", "for", "while"]),
    "sql": _kw_pattern(["case", "when", "if", "loop", "while"]),
    "perl": _kw_pattern(["if", "elsif", "for", "foreach", "while", "until",
                         "unless"]),
}


def _heuristic_complexity(text: str, language: str) -> int:
    patterns = _KW.get(language)
    if not patterns:
        return 1
    complexity = 1
    for pat in patterns:
        complexity += len(pat.findall(text))
    # boolean operators add branches too
    complexity += text.count("&&") + text.count("||")
    # ternaries
    complexity += text.count("?") if language in ("javascript", "typescript") else 0
    return complexity


def compute_complexity(text: str, language: str) -> tuple[int, list[dict]]:
    """Return (file_complexity, functions)."""
    if language == "python":
        funcs = _py_functions(text)
        total = sum(f["complexity"] for f in funcs) if funcs else 1
        if not funcs:
            total = _py_function_complexity(ast.parse(text)) if _parses(text) else 1
        return total, funcs
    return _heuristic_complexity(text, language), []


def _parses(text: str) -> bool:
    try:
        ast.parse(text)
        return True
    except SyntaxError:
        return False


# ---- Readability -----------------------------------------------------------

def readability_score(metrics: dict) -> int:
    """0–100 readability score. Higher is more readable."""
    code = max(1, metrics["lines"]["code"])
    comment = metrics["lines"]["comment"]
    comment_ratio = comment / code  # 0..~1

    avg_line_len = metrics.get("avg_line_len", 40)
    # ideal ~40 chars
    len_penalty = max(0, (avg_line_len - 80) / 80) + max(0, (40 - avg_line_len) / 80) * 0.2

    # function length penalty
    funcs = metrics.get("functions") or []
    avg_func_len = (sum(f["length"] for f in funcs) / len(funcs)) if funcs else 0
    func_penalty = max(0, (avg_func_len - 40) / 60)

    # per-function complexity penalty (a few huge functions hurt readability)
    avg_func_cc = (sum(f["complexity"] for f in funcs) / len(funcs)) if funcs else 0
    func_cc_penalty = max(0, (avg_func_cc - 10) / 20)

    # complexity density: complexity per 100 code lines (only meaningful for
    # non-trivial files; small files would otherwise be unfairly penalized)
    comp_density = (metrics["complexity"] / (code / 100)) if code >= 50 else 0
    comp_penalty = max(0, (comp_density - 10) / 20)

    score = 100
    score -= (1 - min(comment_ratio, 0.35) / 0.35) * 25   # comment ratio: up to 25 pts
    score -= min(len_penalty, 1) * 20                      # line length: up to 20 pts
    score -= min(func_penalty, 1) * 20                      # function length: up to 20 pts
    score -= min(func_cc_penalty, 1) * 20                    # function complexity: up to 20 pts
    score -= min(comp_penalty, 1) * 15                      # complexity density: up to 15 pts
    return max(0, min(100, round(score)))


# ---- Duplication -----------------------------------------------------------

def _normalize_line(line: str, language: str) -> str:
    """Normalize a line for duplication comparison."""
    s = line.strip()
    if not s:
        return ""
    # strip line comments
    prefix = _COMMENT_PREFIX.get(language)
    if prefix and prefix not in ("/*", "<!--"):
        if s.startswith(prefix):
            return ""
    # collapse whitespace
    return re.sub(r"\s+", " ", s)


def find_duplicates(files: list[dict], block_size: int = MIN_DUPE_BLOCK) -> list[dict]:
    """Find duplicate code blocks across files.

    `files` is a list of {path, lines: [normalized...], raw: [original...]}.
    Returns duplicate groups: [{lines, occurrences: [{path, start, end}]}].
    """
    # Map a normalized block hash → list of (path, start_line_index)
    block_map: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for f in files:
        norm = f["lines"]
        if len(norm) < block_size:
            continue
        for i in range(len(norm) - block_size + 1):
            if not any(norm[i:i + block_size]):
                continue
            h = hashlib.md5(
                "\n".join(norm[i:i + block_size]).encode("utf-8", "replace")
            ).hexdigest()
            block_map[h].append((f["path"], i))

    # Build groups, merging overlapping occurrences within the same file.
    raw_groups = []
    for h, occs in block_map.items():
        if len(occs) < 2:
            continue
        # group by file to dedupe overlapping blocks in the same file
        by_file: dict[str, list[int]] = defaultdict(list)
        for path, idx in occs:
            by_file[path].append(idx)
        occurrences = []
        for path, idxs in by_file.items():
            idxs.sort()
            # merge consecutive/overlapping blocks
            merged = []
            cur_start = idxs[0]
            cur_end = idxs[0] + block_size
            for idx in idxs[1:]:
                if idx <= cur_end:
                    cur_end = max(cur_end, idx + block_size)
                else:
                    merged.append((cur_start, cur_end))
                    cur_start = idx
                    cur_end = idx + block_size
            merged.append((cur_start, cur_end))
            for s, e in merged:
                occurrences.append({"path": path, "start": s + 1, "end": e})
        if len(occurrences) < 2:
            continue
        # representative line count = first occurrence span (inclusive)
        span = occurrences[0]["end"] - occurrences[0]["start"] + 1
        raw_groups.append({"lines": span, "occurrences": occurrences})

    # Deduplicate groups that are supersets of others (same occurrences, bigger).
    raw_groups.sort(key=lambda g: -g["lines"])
    seen_spans: set[tuple] = set()
    groups = []
    for g in raw_groups:
        key = tuple(sorted((o["path"], o["start"], o["end"]) for o in g["occurrences"]))
        if key in seen_spans:
            continue
        seen_spans.add(key)
        groups.append(g)
        if len(groups) >= 200:
            break
    return groups


# ---- Per-file analysis -----------------------------------------------------

def analyze_file(path: Path, root: Path) -> dict | None:
    ext = path.suffix.lower()
    language = LANG_BY_EXT.get(ext, "")
    if ext not in CODE_EXTS:
        return None
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > MAX_FILE_BYTES:
        return None
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw[:4096]:
        return None  # binary
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None

    lines = count_lines(text, language)
    complexity, functions = compute_complexity(text, language)
    line_lens = [len(l) for l in text.splitlines() if l.strip()]
    avg_line_len = round(sum(line_lens) / len(line_lens), 1) if line_lens else 0

    rel = path.relative_to(root).as_posix()
    metrics = {
        "path": rel,
        "language": language,
        "size": size,
        "lines": lines,
        "complexity": complexity,
        "functions": functions,
        "avg_line_len": avg_line_len,
    }
    metrics["readability"] = readability_score(metrics)
    return metrics


# ---- Index build -----------------------------------------------------------

def build_index(root: Path) -> dict:
    """Walk a repo root and build the full metrics index."""
    files_metrics = []
    dupe_inputs = []
    file_count = 0

    for current, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not _is_ignored_dir(d))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            ext = Path(name).suffix.lower()
            if ext not in CODE_EXTS:
                continue
            full = Path(current) / name
            m = analyze_file(full, root)
            if m is None:
                continue
            files_metrics.append(m)
            file_count += 1
            if file_count >= MAX_FILES:
                break
            # collect normalized lines for duplication
            try:
                text = full.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            norm = [_normalize_line(l, m["language"]) for l in text.splitlines()]
            dupe_inputs.append({"path": m["path"], "lines": norm})
        if file_count >= MAX_FILES:
            break

    dupes = find_duplicates(dupe_inputs)

    # Aggregates
    total_loc = sum(f["lines"]["total"] for f in files_metrics)
    total_code = sum(f["lines"]["code"] for f in files_metrics)
    total_comment = sum(f["lines"]["comment"] for f in files_metrics)
    total_blank = sum(f["lines"]["blank"] for f in files_metrics)
    total_complexity = sum(f["complexity"] for f in files_metrics)
    dupe_lines = sum(g["lines"] * len(g["occurrences"]) for g in dupes)
    dup_pct = round(100 * dupe_lines / max(1, total_code), 1)

    # Hotspots: flatten functions across files
    hotspots = []
    for f in files_metrics:
        for fn in f.get("functions") or []:
            hotspots.append({
                "file": f["path"],
                "name": fn["name"],
                "line": fn["line"],
                "length": fn["length"],
                "complexity": fn["complexity"],
            })
    hotspots.sort(key=lambda h: -h["complexity"])
    top_hotspots = hotspots[:40]

    largest = sorted(files_metrics, key=lambda f: -f["lines"]["total"])[:40]
    least_readable = sorted(files_metrics, key=lambda f: f["readability"])[:40]
    most_complex_files = sorted(files_metrics, key=lambda f: -f["complexity"])[:40]

    # Language breakdown
    by_lang: dict[str, dict] = defaultdict(lambda: {"files": 0, "code": 0, "complexity": 0})
    for f in files_metrics:
        d = by_lang[f["language"]]
        d["files"] += 1
        d["code"] += f["lines"]["code"]
        d["complexity"] += f["complexity"]

    # Directory tree (for structure view)
    tree = _build_tree(files_metrics)

    return {
        "root": str(root),
        "file_count": len(files_metrics),
        "totals": {
            "files": len(files_metrics),
            "lines": total_loc,
            "code": total_code,
            "comment": total_comment,
            "blank": total_blank,
            "complexity": total_complexity,
            "avg_complexity": round(total_complexity / max(1, len(files_metrics)), 2),
            "duplication_pct": dup_pct,
            "dup_blocks": len(dupes),
            "dupe_lines": dupe_lines,
        },
        "languages": [
            {"language": k, **v} for k, v in sorted(by_lang.items(), key=lambda kv: -kv[1]["code"])
        ],
        "hotspots": top_hotspots,
        "largest_files": [
            {"path": f["path"], "lines": f["lines"]["total"], "complexity": f["complexity"]}
            for f in largest
        ],
        "most_complex_files": [
            {"path": f["path"], "complexity": f["complexity"], "lines": f["lines"]["total"]}
            for f in most_complex_files
        ],
        "least_readable": [
            {"path": f["path"], "readability": f["readability"], "lines": f["lines"]["total"]}
            for f in least_readable
        ],
        "duplicates": dupes[:100],
        "tree": tree,
        "files": files_metrics,
    }


def _build_tree(files: list[dict]) -> dict:
    """Build a nested directory tree from flat file metrics."""
    root: dict = {"name": "", "path": "", "dirs": {}, "files": []}
    for f in files:
        parts = f["path"].split("/")
        node = root
        for part in parts[:-1]:
            if part not in node["dirs"]:
                node["dirs"][part] = {
                    "name": part, "path": "", "dirs": {}, "files": [],
                }
            node = node["dirs"][part]
        node["files"].append({
            "name": parts[-1],
            "path": f["path"],
            "language": f["language"],
            "lines": f["lines"]["total"],
            "complexity": f["complexity"],
            "readability": f["readability"],
        })
    return _finalize_tree(root, "")


def _finalize_tree(node: dict, prefix: str) -> dict:
    """Compute aggregate metrics per dir and assign paths; sort entries."""
    node["path"] = prefix
    dir_children = []
    for name, child in node["dirs"].items():
        child_path = f"{prefix}/{name}" if prefix else name
        finalized = _finalize_tree(child, child_path)
        dir_children.append(finalized)
    dir_children.sort(key=lambda d: d["name"])
    node["dirs"] = dir_children
    node["files"].sort(key=lambda f: f["name"])
    # aggregates
    dir_lines = sum(d["lines"] for d in dir_children)
    dir_complexity = sum(d["complexity"] for d in dir_children)
    file_lines = sum(f["lines"] for f in node["files"])
    file_complexity = sum(f["complexity"] for f in node["files"])
    node["lines"] = dir_lines + file_lines
    node["complexity"] = dir_complexity + file_complexity
    node["file_count"] = sum(d["file_count"] for d in dir_children) + len(node["files"])
    return node