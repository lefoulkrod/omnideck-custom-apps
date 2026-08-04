"""
Code Observatory — changeset review.

Answers two questions about a change without reading the code:

  1. Reuse — did the change write something the project already had?
  2. Tests — what exercises the new code, and in whose words?

Neither is language specific by design. The duplicated-code half needs no
language support at all; it compares normalized text. The similar-name half
needs only a list of symbol names. The test half needs test-path conventions
plus, for languages where a test is an anonymous callback rather than a named
function, the callback symbols that `symbols.py` now registers.

Anything that could not be checked is reported as unchecked rather than
silently passing, so "nothing found" never looks the same as "did not look".
"""

from __future__ import annotations

import difflib
import re
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path

import metrics as metrics_mod
import symbols as symbols_mod

# Findings shown per section. A list of 296 is not a list anyone reads; the
# rest are reported as a count.
MAX_FINDINGS = 25
# A duplicate must be at least this many meaningful lines to be worth showing.
MIN_DUPE_LINES = 6
# Lines shorter than this are punctuation, closing braces, boilerplate.
MIN_LINE_CHARS = 12
# Name similarity: report only pairs at or above this ratio.
NAME_SIM_MIN = 0.80
# Embedding similarity for duplicate detection: a match must score this high
# AND lead the runner-up by EMBED_GAP_MIN. Absolute score alone does not
# separate signal from noise -- measured on a real repo, good matches and junk
# both land in the 0.65-0.75 band, while a true duplicate leads its runner-up
# by 0.10 or more.
EMBED_SIM_MIN = 0.80
EMBED_GAP_MIN = 0.08
# Semantic search cut-off, in standard deviations above the mean similarity
# for that query. Raw cosine is not comparable across models: the same three
# queries scored 0.71-0.79 with bge-small and 0.49-0.59 with an Ollama model,
TEST_PATH_RE = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs)/"
    r"|(^|/)test_[^/]+$"
    r"|_test\.[a-z]+$"
    r"|\.(test|spec)\.[a-z]+$"
    r"|(^|/)[A-Za-z0-9_]+(Test|Tests|Spec)\.[a-z]+$"
)
TEST_NAME_RE = re.compile(r"^(test|Test|it_|should_|spec_)")


def _git(repo: Path, *args: str) -> str:
    """Run git and return stdout, or "" if it failed. See `_git_checked`."""
    return _git_checked(repo, *args)[0]


def _git_checked(repo: Path, *args: str) -> tuple[str, str]:
    """Run git and return (stdout, error).

    Returning stdout alone loses the difference between "git answered no" and
    "git could not run", which then surfaces to the user as a confident wrong
    answer. Callers that report status must pass the error through.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError:
        return "", "git is not installed or not on PATH"
    except subprocess.TimeoutExpired:
        return "", f"git {' '.join(args)} timed out"
    if proc.returncode != 0:
        return "", (proc.stderr or proc.stdout).strip() or f"git exited {proc.returncode}"
    return proc.stdout.strip(), ""


def workspace_scope(workspace: Path) -> dict:
    """Describe how the selected workspace relates to a git repository.

    Never raises. Callers show this rather than hiding it, because the answer
    changes what an operation means: a workspace can be a whole repository,
    one directory inside a larger one, or not version controlled at all. Git
    commands silently resolve upward to the repository root, so without this
    the user cannot tell which of the three they are looking at.
    """
    root, error = _git_checked(workspace, "rev-parse", "--show-toplevel")
    if not root:
        # "not a repository" and "git refused to run" look identical from the
        # outside, so pass the reason through rather than asserting the first.
        return {
            "is_repo": False,
            "repo_root": "",
            "repo_name": "",
            "scope": "",
            "is_repo_root": False,
            "git_error": error,
            # Echo the path actually inspected. When this disagrees with the
            # folder shown in the Explorer, the workspace is not what it looks.
            "checked_path": str(workspace),
        }
    prefix = _git(workspace, "rev-parse", "--show-prefix").strip("/")
    return {
        "is_repo": True,
        "repo_root": root,
        "repo_name": Path(root).name,
        "scope": prefix or ".",
        "is_repo_root": not prefix,
    }


def repo_scope(workspace: Path) -> tuple[Path, str]:
    """Resolve a workspace directory to (repo root, path within the repo).

    The app operates on a selected workspace, which in a monorepo is one app
    directory rather than the whole repository. Everything downstream has to
    be scoped to it, otherwise the comparison is between a whole-repo base and
    a single-directory target, and every symbol looks new.
    """
    scope = workspace_scope(workspace)
    if not scope["is_repo"]:
        raise ValueError(
            f"This workspace is not a git repository: {workspace}. "
            "Review compares two git states, so pick a workspace inside one."
        )
    return Path(scope["repo_root"]), "" if scope["is_repo_root"] else scope["scope"]


def extract_ref(repo_root: Path, ref: str, dest: Path, prefix: str = "") -> Path:
    """Extract a git ref, or one subtree of it, into dest.

    `git archive <ref>:<prefix>` yields the subtree with paths relative to it,
    which is what makes the extracted base line up with a workspace target.
    Note the tree-ish is resolved from the repo root, so this must not be run
    from inside the subdirectory.
    """
    dest.mkdir(parents=True, exist_ok=True)
    treeish = f"{ref}:{prefix}" if prefix else ref
    proc = subprocess.Popen(
        ["git", "-C", str(repo_root), "archive", treeish], stdout=subprocess.PIPE,
    )
    subprocess.run(["tar", "-xf", "-", "-C", str(dest)], stdin=proc.stdout)
    proc.wait()
    return dest


def git_refs(repo: Path, count: int = 15) -> dict:
    """HEAD sha, dirty flag, and recent commits for the base/target pickers."""
    log = _git(repo, "log", "--oneline", f"-{count}")
    commits = []
    for line in log.split("\n"):
        if not line.strip():
            continue
        parts = line.split(" ", 1)
        commits.append(
            {"sha": parts[0], "message": parts[1] if len(parts) > 1 else ""}
        )
    return {
        "head_sha": _git(repo, "rev-parse", "--short", "HEAD"),
        "is_dirty": bool(_git(repo, "status", "--porcelain").strip()),
        "recent_commits": commits,
    }


def analyze_repo(
    workspace: Path,
    base: str = "HEAD",
    target: str = "working",
    embed_fn=None,
) -> dict:
    """Run the review checks across two git states of one workspace.

    `workspace` is the folder selected in the app, which may be a subdirectory
    of the repository. Both sides of the comparison and the diff stat are
    scoped to it, so a monorepo of independent apps is never compared against
    itself across app boundaries.
    """
    repo_root, prefix = repo_scope(workspace)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        base_root = extract_ref(repo_root, base, tmp_path / "base", prefix)
        base_index = symbols_mod.build_symbol_index(base_root)
        if target == "working":
            target_root = workspace
        else:
            target_root = extract_ref(
                repo_root, target, tmp_path / "target", prefix
            )
        target_index = symbols_mod.build_symbol_index(target_root)
        report = compute_review(
            base_root, target_root, base_index, target_index, embed_fn=embed_fn
        )
    report["base"] = base
    report["target"] = "Working Tree" if target == "working" else target
    # Findings from a past commit point at files as they were then. Opening
    # them against the working tree fails whenever they have since moved or
    # been deleted, so tell the frontend not to offer it.
    report["openable"] = target == "working"
    report["scope"] = prefix or "."
    report["diff_stat"] = _diff_stat(repo_root, base, target, prefix)
    return report


def _diff_stat(repo_root: Path, base: str, target: str, prefix: str = "") -> dict:
    """Files changed plus insertions and deletions, scoped to the workspace.

    Returns totals plus a per-file breakdown grouped by directory so the
    frontend can render a layered view of what changed.
    """
    args = ["diff", "--numstat", base]
    if target != "working":
        args.append(target)
    if prefix:
        args += ["--", prefix]
    files = insertions = deletions = 0
    by_dir: dict[str, list[dict]] = {}
    for line in _git(repo_root, *args).split("\n"):
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ins_str, del_str, filepath = parts[0], parts[1], parts[2]
        ins = int(ins_str) if ins_str.isdigit() else 0
        del_ = int(del_str) if del_str.isdigit() else 0
        files += 1
        insertions += ins
        deletions += del_
        # Group by parent directory
        parent = filepath.rsplit("/", 1)[0] if "/" in filepath else "."
        by_dir.setdefault(parent, []).append({
            "path": filepath,
            "insertions": ins,
            "deletions": del_,
        })
    # Sort dirs and files within each dir
    dirs = []
    for dirpath in sorted(by_dir):
        entries = sorted(by_dir[dirpath], key=lambda e: e["path"])
        dir_ins = sum(e["insertions"] for e in entries)
        dir_del = sum(e["deletions"] for e in entries)
        dirs.append({
            "dir": dirpath,
            "files": len(entries),
            "insertions": dir_ins,
            "deletions": dir_del,
            "entries": entries,
        })
    return {
        "files": files,
        "insertions": insertions,
        "deletions": deletions,
        "dirs": dirs,
    }


def is_test_module(module: str) -> bool:
    """True when a path looks like a test file by convention, in any language."""
    return bool(TEST_PATH_RE.search(module))


def symbol_key(sym: dict) -> tuple[str, str, str]:
    """Identity that survives line shifts.

    Symbol ids embed a line number (`path::name@line`), so diffing on id alone
    reports every symbol below an insertion as both removed and added. The
    enclosing field stores a full id, so its line number has to go too.
    """
    enclosing = (sym.get("enclosing") or "").split("@")[0]
    return (sym["module"], enclosing, sym["name"])


def _language_of(index: dict) -> dict[str, str]:
    return {m["path"]: m["language"] for m in index.get("modules", [])}


def _normalized_lines(text: str, language: str) -> list[str]:
    """Strip comments and formatting so only meaningful code remains."""
    out = []
    for line in text.split("\n"):
        norm = metrics_mod._normalize_line(line, language)
        if norm and len(norm) >= MIN_LINE_CHARS:
            out.append(norm)
    return out


def _read(root: Path, module: str) -> str:
    try:
        return (root / module).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def find_duplicated_code(
    new_symbols: list[dict],
    base_index: dict,
    base_root: Path,
    target_root: Path,
) -> list[dict]:
    """New code whose lines already exist in a file the change did not create.

    Matches are only reported against a *different* file. Without that rule
    every symbol matches its own earlier version and the result is all noise.
    """
    base_langs = {
        path: language for path, language in _language_of(base_index).items()
        if not is_test_module(path)
    }
    windows: dict[int, list[tuple[str, int]]] = defaultdict(list)
    normalized: dict[str, list[str]] = {}
    for path, language in base_langs.items():
        lines = _normalized_lines(_read(base_root, path), language)
        normalized[path] = lines
        for i in range(len(lines) - MIN_DUPE_LINES + 1):
            windows[hash(tuple(lines[i : i + MIN_DUPE_LINES]))].append((path, i))

    hits = []
    for sym in new_symbols:
        if sym.get("size", 0) < MIN_DUPE_LINES:
            continue
        if is_test_module(sym["module"]):
            continue
        language = sym.get("_language")
        if not language:
            continue
        body = _read(target_root, sym["module"]).split("\n")
        lines = _normalized_lines(
            "\n".join(body[sym["line"] - 1 : sym.get("end_line", sym["line"])]),
            language,
        )
        best = None
        for i in range(len(lines) - MIN_DUPE_LINES + 1):
            key = hash(tuple(lines[i : i + MIN_DUPE_LINES]))
            for other_path, j in windows.get(key, []):
                if other_path == sym["module"]:
                    continue
                other = normalized[other_path]
                run = MIN_DUPE_LINES
                while (
                    i + run < len(lines)
                    and j + run < len(other)
                    and lines[i + run] == other[j + run]
                ):
                    run += 1
                if best is None or run > best[0]:
                    best = (run, other_path)
        if best:
            hits.append(
                {
                    "name": sym["name"],
                    "module": sym["module"],
                    "line": sym["line"],
                    "match_lines": best[0],
                    "match_module": best[1],
                }
            )
    hits.sort(key=lambda h: -h["match_lines"])
    return hits


def _name_tokens(name: str) -> set[str]:
    parts = re.split(r"[_\W]|(?<=[a-z0-9])(?=[A-Z])", name)
    return {p.lower() for p in parts if p}


def find_similar_names(
    new_symbols: list[dict], base_symbols: list[dict]
) -> list[dict]:
    """New functions whose names closely resemble one that already exists."""
    existing = [
        s
        for s in base_symbols
        if s["kind"] in ("function", "method") and not is_test_module(s["module"])
    ]
    hits = []
    for sym in new_symbols:
        if sym["kind"] not in ("function", "method") or len(sym["name"]) < 6:
            continue
        tokens = _name_tokens(sym["name"])
        for other in existing:
            if other["name"] == sym["name"] and other["module"] == sym["module"]:
                continue
            if len(other["name"]) < 6:
                continue
            other_tokens = _name_tokens(other["name"])
            overlap = len(tokens & other_tokens) / max(1, len(tokens | other_tokens))
            if overlap < 0.5:
                continue
            ratio = difflib.SequenceMatcher(
                None, sym["name"].lower(), other["name"].lower()
            ).ratio()
            if ratio >= NAME_SIM_MIN:
                hits.append(
                    {
                        "name": sym["name"],
                        "module": sym["module"],
                        "line": sym["line"],
                        "other_name": other["name"],
                        "other_module": other["module"],
                        "other_line": other["line"],
                        "score": round(ratio, 3),
                        "method": "name",
                    }
                )
    hits.sort(key=lambda h: -h["score"])
    seen = set()
    unique = []
    for hit in hits:
        pair = (hit["name"], hit["other_name"])
        if pair in seen:
            continue
        seen.add(pair)
        unique.append(hit)
    return unique


def find_test_linkage(index: dict, targets: list[dict]) -> dict:
    """Which named tests reach each target symbol, one and two hops out.

    A test is a symbol in a test file that is either named like a test or is a
    labelled callback (`it("...")`, `t.Run("...")`), which is how JavaScript,
    Ruby, and Go subtests express one.
    """
    by_id = {s["id"]: s for s in index.get("symbols", [])}
    test_ids = {
        sid
        for sid, s in by_id.items()
        if is_test_module(s["module"])
        and (TEST_NAME_RE.match(s["name"]) or s["kind"] == "callback")
    }

    direct: dict[str, set[str]] = defaultdict(set)
    indirect: dict[str, set[str]] = defaultdict(set)
    for tid in test_ids:
        for callee in by_id[tid].get("callees", []):
            if callee not in by_id or callee in test_ids:
                continue
            direct[callee].add(tid)
            for deeper in by_id[callee].get("callees", []):
                if deeper in by_id and deeper not in test_ids:
                    indirect[deeper].add(tid)

    def describe_tests(ids):
        """Tests carry their own location so they can be opened, not just read."""
        seen, out = set(), []
        for tid in ids:
            test = by_id[tid]
            if test["name"] in seen:
                continue
            seen.add(test["name"])
            out.append({
                "name": test["name"],
                "module": test["module"],
                "line": test["line"],
            })
        return sorted(out, key=lambda t: t["name"])

    covered, uncovered = [], []
    for sym in targets:
        sid = sym["id"]
        tests = describe_tests(direct.get(sid, ()))
        depth = 1
        if not tests:
            tests = describe_tests(indirect.get(sid, ()))
            depth = 2
        entry = {
            "name": sym["name"],
            "module": sym["module"],
            "line": sym["line"],
            "size": sym.get("size", 0),
        }
        if tests:
            covered.append({**entry, "tests": tests, "depth": depth})
        else:
            uncovered.append(entry)
    uncovered.sort(key=lambda s: -s["size"])
    return {
        "test_symbols": len(test_ids),
        "covered": covered,
        "uncovered": uncovered,
    }


def _test_capable_languages(index: dict) -> set[str]:
    """Languages where we actually recognised at least one test in this repo.

    Empirical rather than declared. If a language has test files but produced
    no test symbols, the check cannot speak for it and must say so.
    """
    langs = _language_of(index)
    by_module = defaultdict(list)
    for sym in index.get("symbols", []):
        by_module[sym["module"]].append(sym)
    capable = set()
    for module, syms in by_module.items():
        if not is_test_module(module):
            continue
        if any(TEST_NAME_RE.match(s["name"]) or s["kind"] == "callback" for s in syms):
            capable.add(langs.get(module, "unknown"))
    return capable


def compute_review(
    base_root: Path,
    target_root: Path,
    base_index: dict,
    target_index: dict,
    embed_fn=None,
) -> dict:
    """Compare two trees and report reuse and test findings for what is new.

    `embed_fn` takes a list of strings and returns a list of vectors. When
    supplied, similar-name detection also finds functions that do the same job
    under a different name. When absent the check still runs on spelling alone
    and says so.
    """
    target_langs = _language_of(target_index)
    base_langs = _language_of(base_index)
    base_by_key = {symbol_key(s): s for s in base_index.get("symbols", [])}

    def body_of(root: Path, sym: dict, language: str) -> list[str]:
        lines = _read(root, sym["module"]).split("\n")
        return _normalized_lines(
            "\n".join(lines[sym["line"] - 1: sym.get("end_line", sym["line"])]),
            language,
        )

    new_symbols = []
    changed_symbols = []
    for sym in target_index.get("symbols", []):
        language = target_langs.get(sym["module"], "")
        previous = base_by_key.get(symbol_key(sym))
        enriched = dict(sym)
        enriched["_language"] = language
        if previous is None:
            new_symbols.append(enriched)
            continue
        # A rewritten function deserves the same scrutiny as a new one. Without
        # this, a change that only edits existing code produces a blank report.
        if body_of(target_root, sym, language) != body_of(
            base_root, previous, base_langs.get(previous["module"], language)
        ):
            changed_symbols.append(enriched)

    # Local helpers defined inside another function are an implementation
    # detail of their parent. Listing them as separately untestable units is
    # noise: no test can reach them by name, so they would always be reported
    # as uncovered no matter how well the parent is tested.
    kind_by_id = {s["id"]: s["kind"] for s in target_index.get("symbols", [])}

    def testable(symbols):
        return [
            s for s in symbols
            if s["kind"] in ("function", "method")
            and not is_test_module(s["module"])
            and kind_by_id.get(s.get("enclosing") or "", "")
            not in ("function", "method")
        ]

    new_production = testable(new_symbols)
    changed_production = testable(changed_symbols)

    duplicated = find_duplicated_code(
        new_symbols, base_index, base_root, target_root
    )
    similar = find_similar_names(new_production, base_index.get("symbols", []))
    method = "name"
    if embed_fn is not None:
        # Verify name matches by comparing function bodies with the embedding model.
        # Identical names (score 1.0) may be different functions that happen to
        # share a name — the embedding model can distinguish them by their code.
        if similar:
            new_by_key = {(s["name"], s["module"]): s for s in new_production}
            base_by_key = {(s["name"], s["module"]): s for s in base_index.get("symbols", [])}
            verified = []
            for h in similar:
                key = (h["name"], h["module"])
                other_key = (h["other_name"], h["other_module"])
                sym = new_by_key.get(key)
                other = base_by_key.get(other_key)
                if sym and other and h["name"] == h["other_name"]:
                    # Compare bodies via embedding
                    def _body_text(root, s):
                        try:
                            lines = (root / s["module"]).read_text(
                                encoding="utf-8", errors="replace"
                            ).split("\n")
                            return " ".join(lines[s["line"] - 1: s.get("end_line", s["line"])])[:500]
                        except OSError:
                            return ""
                    texts = [_body_text(target_root, sym), _body_text(base_root, other)]
                    try:
                        vecs = embed_fn(texts)
                        dot = sum(a * b for a, b in zip(vecs[0], vecs[1]))
                        norm = (sum(x*x for x in vecs[0])**0.5 or 1.0) * (sum(x*x for x in vecs[1])**0.5 or 1.0)
                        sim = dot / norm
                        if sim >= EMBED_SIM_MIN:
                            verified.append(h)
                    except Exception:
                        verified.append(h)  # keep on error
                else:
                    verified.append(h)
            similar = verified

        semantic = _find_similar_meaning(
            new_production, base_index.get("symbols", []), embed_fn,
            base_root, target_root,
        )
        known = {(h["name"], h["other_name"]) for h in similar}
        similar = similar + [
            h for h in semantic if (h["name"], h["other_name"]) not in known
        ]
        similar.sort(key=lambda h: -h["score"])
        method = "name+meaning"

    # Include function bodies in each finding so the frontend can show a diff
    if similar:
        all_syms = new_symbols + base_index.get("symbols", [])
        sym_by_key = {(s["name"], s["module"]): s for s in all_syms}
        for h in similar:
            sym = sym_by_key.get((h["name"], h["module"]))
            other = sym_by_key.get((h["other_name"], h["other_module"]))
            if sym and other:
                def _read_body(root, s):
                    try:
                        lines = (root / s["module"]).read_text(
                            encoding="utf-8", errors="replace"
                        ).split("\n")
                        return "\n".join(lines[s["line"] - 1: s.get("end_line", s["line"])])
                    except OSError:
                        return ""
                h["new_body"] = _read_body(target_root, sym)
                h["other_body"] = _read_body(base_root, other)

    # Reuse only asks about new code, but the test question applies just as
    # much to a function that was rewritten.
    tests = find_test_linkage(
        target_index, new_production + changed_production
    )

    changed_langs = {target_langs.get(s["module"], "unknown") for s in new_symbols}
    capable = _test_capable_languages(target_index)
    return {
        "new_symbols": len(new_symbols),
        "new_functions": len(new_production),
        "changed_functions": len(changed_production),
        "reviewed_functions": len(new_production) + len(changed_production),
        "reuse": {
            "duplicated": duplicated[:MAX_FINDINGS],
            "similar": similar[:MAX_FINDINGS],
            "duplicated_total": len(duplicated),
            "similar_total": len(similar),
            "method": method,
        },
        "tests": tests,
        "checked": {
            "languages_in_change": sorted(x for x in changed_langs if x),
            "test_linkage_unavailable_for": sorted(
                x for x in changed_langs if x and x not in capable
            ),
        },
    }


def _find_similar_meaning(
    new_symbols: list[dict], base_symbols: list[dict], embed_fn,
    base_root: Path, target_root: Path,
) -> list[dict]:
    """Nearest existing function by meaning, for names that do not match.

    Only reported when the top match both scores high and clearly leads the
    runner-up. A high score on its own is not evidence: on a real repository
    unrelated functions routinely score 0.68 while a genuine duplicate scores
    0.92 with a wide gap behind it.
    """
    corpus = [
        s
        for s in base_symbols
        if s["kind"] in ("function", "method") and not is_test_module(s["module"])
    ]
    if not corpus or not new_symbols:
        return []

    # File-level cache so each source file is read at most once
    _file_cache: dict[str, list[str]] = {}

    def _read_body(root: Path, module: str, line: int, end_line: int) -> str:
        if module not in _file_cache:
            try:
                _file_cache[module] = (root / module).read_text(
                    encoding="utf-8", errors="replace"
                ).split("\n")
            except OSError:
                _file_cache[module] = []
        lines = _file_cache[module]
        body = " ".join(lines[line - 1 : end_line])[:500]
        return body

    def describe(sym: dict, is_new: bool) -> str:
        root = target_root if is_new else base_root
        body = _read_body(root, sym["module"], sym["line"], sym.get("end_line", sym["line"]))
        signature = " ".join((sym.get("signature") or "").split())[:180]
        return f"{sym['module'].rsplit('/', 1)[-1]} :: {sym['name']} :: {signature} :: {body}"

    try:
        corpus_vecs = embed_fn([describe(s, False) for s in corpus])
        new_vecs = embed_fn([describe(s, True) for s in new_symbols])
    except Exception:
        return []

    def unit(vec):
        norm = sum(x * x for x in vec) ** 0.5 or 1.0
        return [x / norm for x in vec]

    corpus_vecs = [unit(v) for v in corpus_vecs]
    hits = []
    for sym, vec in zip(new_symbols, [unit(v) for v in new_vecs], strict=True):
        scored = sorted(
            (
                (sum(a * b for a, b in zip(vec, cv, strict=True)), other)
                for cv, other in zip(corpus_vecs, corpus, strict=True)
                if other["module"] != sym["module"]
            ),
            key=lambda pair: -pair[0],
        )[:2]
        if len(scored) < 2:
            continue
        (top_score, top), (runner_up, _) = scored
        if top_score < EMBED_SIM_MIN or top_score - runner_up < EMBED_GAP_MIN:
            continue
        hits.append(
            {
                "name": sym["name"],
                "module": sym["module"],
                "line": sym["line"],
                "other_name": top["name"],
                "other_module": top["module"],
                "other_line": top["line"],
                "score": round(top_score, 3),
                "method": "meaning",
            }
        )
    return hits
