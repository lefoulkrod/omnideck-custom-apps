"""Unit tests for the changeset review checks."""

import re
from pathlib import Path

import review as C
import symbols as S


def _write(root, name, content):
    f = root / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(content, encoding="utf-8")
    return f


def _index(root):
    return S.build_symbol_index(root)


# ---- identity ---------------------------------------------------------------

def test_symbol_key_ignores_line_numbers():
    a = {"module": "m.py", "name": "go", "enclosing": "m.py::Cls@10"}
    b = {"module": "m.py", "name": "go", "enclosing": "m.py::Cls@42"}
    assert C.symbol_key(a) == C.symbol_key(b)


def test_symbol_key_separates_same_name_in_different_classes():
    a = {"module": "m.py", "name": "go", "enclosing": "m.py::A@1"}
    b = {"module": "m.py", "name": "go", "enclosing": "m.py::B@1"}
    assert C.symbol_key(a) != C.symbol_key(b)


# ---- test file conventions --------------------------------------------------

def test_is_test_module_covers_common_conventions():
    for path in (
        "tests/test_thing.py",
        "test_thing.py",
        "pkg/thing_test.go",
        "src/__tests__/thing.test.js",
        "src/thing.spec.ts",
        "spec/models/thing_spec.rb",
        "src/main/java/ThingTest.java",
    ):
        assert C.is_test_module(path), path


def test_is_test_module_rejects_production_paths():
    for path in ("src/thing.py", "lib/contest.js", "pkg/latest.go"):
        assert not C.is_test_module(path), path


# ---- duplicated code --------------------------------------------------------

# Long enough that the shared portion still clears MIN_DUPE_LINES after
# trivial lines (continue, bare braces) are stripped out.
BODY = """
def compute(rows):
    total_amount = 0.0
    for row in rows:
        if row.get("skip") is True:
            continue
        total_amount = total_amount + row["amount"] * row["rate"]
        total_amount = round(total_amount, 4)
        if total_amount > 1000000:
            total_amount = 1000000
        row["running_total"] = total_amount
    return round(total_amount, 2)
"""


def test_duplicated_code_found_across_files(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "original.py", BODY)
    _write(target, "original.py", BODY)
    _write(target, "copy.py", BODY.replace("def compute", "def recompute"))
    report = C.compute_review(base, target, _index(base), _index(target))
    hits = report["reuse"]["duplicated"]
    assert any(h["name"] == "recompute" for h in hits)
    assert all(h["match_module"] == "original.py" for h in hits)


def test_duplicated_code_ignores_the_symbols_own_file(tmp_path):
    """A lightly edited function must not match its own earlier version."""
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "mod.py", BODY)
    _write(target, "mod.py", BODY.replace("def compute", "def compute_v2"))
    report = C.compute_review(base, target, _index(base), _index(target))
    assert report["reuse"]["duplicated"] == []


# ---- similar names ----------------------------------------------------------

def test_similar_name_reported(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "old.py", "def html_to_markdown(t):\n    return t\n")
    _write(target, "old.py", "def html_to_markdown(t):\n    return t\n")
    _write(target, "new.py", "def _html_to_markdown(t):\n    return t\n")
    report = C.compute_review(base, target, _index(base), _index(target))
    pairs = {(h["name"], h["other_name"]) for h in report["reuse"]["similar"]}
    assert ("_html_to_markdown", "html_to_markdown") in pairs


def test_unrelated_names_not_reported(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "old.py", "def html_to_markdown(t):\n    return t\n")
    _write(target, "old.py", "def html_to_markdown(t):\n    return t\n")
    _write(target, "new.py", "def schedule_backup(t):\n    return t\n")
    report = C.compute_review(base, target, _index(base), _index(target))
    assert report["reuse"]["similar"] == []


# ---- test linkage -----------------------------------------------------------

def test_linkage_names_python_tests(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "keep.py", "def keep():\n    return 1\n")
    _write(target, "keep.py", "def keep():\n    return 1\n")
    _write(target, "app.py", "def render_body(x):\n    return x\n")
    _write(
        target,
        "tests/test_app.py",
        "from app import render_body\n"
        "def test_render_body_decodes_charset():\n"
        "    assert render_body(1) == 1\n",
    )
    report = C.compute_review(base, target, _index(base), _index(target))
    covered = {
        c["name"]: [t["name"] for t in c["tests"]]
        for c in report["tests"]["covered"]
    }
    assert "test_render_body_decodes_charset" in covered["render_body"]


def test_linkage_names_javascript_callback_tests(tmp_path):
    """JS tests are anonymous callbacks; the label has to carry the name."""
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "keep.js", "export function keep() { return 1; }\n")
    _write(target, "keep.js", "export function keep() { return 1; }\n")
    _write(target, "project.js", "export function projectTurns(ev) { return ev; }\n")
    _write(
        target,
        "__tests__/project.test.js",
        "import { projectTurns } from '../project';\n"
        "describe('projectTurns', () => {\n"
        "  it('groups events into turns', () => { projectTurns([]); });\n"
        "});\n",
    )
    report = C.compute_review(base, target, _index(base), _index(target))
    covered = {
        c["name"]: [t["name"] for t in c["tests"]]
        for c in report["tests"]["covered"]
    }
    assert 'it("groups events into turns")' in covered["projectTurns"]


def test_linkage_names_go_subtests(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "keep.go", "package p\nfunc Keep() int { return 1 }\n")
    _write(target, "keep.go", "package p\nfunc Keep() int { return 1 }\n")
    _write(target, "thing.go", "package p\nfunc ProjectTurns(e []int) []int { return e }\n")
    _write(
        target,
        "thing_test.go",
        'package p\nimport "testing"\n'
        "func TestThing(t *testing.T) {\n"
        '  t.Run("groups events into turns", func(t *testing.T) { ProjectTurns(nil) })\n'
        "}\n",
    )
    report = C.compute_review(base, target, _index(base), _index(target))
    covered = {
        c["name"]: [t["name"] for t in c["tests"]]
        for c in report["tests"]["covered"]
    }
    assert 't.Run("groups events into turns")' in covered["ProjectTurns"]


# ---- workspace scoping -----------------------------------------------------

def _monorepo(tmp_path):
    """A repo holding two independent apps, like a custom-apps monorepo."""
    import subprocess

    repo = tmp_path / "monorepo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.email", "t@example.com"], check=True
    )
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "T"], check=True)
    _write(repo, "app-one/main.py", "def shared_name():\n    return 1\n")
    _write(repo, "app-two/main.py", "def unrelated():\n    return 2\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "init"], check=True)
    return repo


def test_workspace_scope_resolves_prefix(tmp_path):
    repo = _monorepo(tmp_path)
    root, prefix = C.repo_scope(repo / "app-one")
    assert root == repo
    assert prefix == "app-one"


def test_extract_ref_scoped_to_a_subdirectory(tmp_path):
    """The base tree must line up with the workspace, not the whole repo."""
    repo = _monorepo(tmp_path)
    dest = C.extract_ref(repo, "HEAD", tmp_path / "out", "app-one")
    assert (dest / "main.py").exists()
    assert not (dest / "app-one").exists()
    assert not (dest / "app-two").exists()


def test_analyze_repo_ignores_sibling_apps(tmp_path):
    """A new function must not be reported as new just because it is scoped out."""
    repo = _monorepo(tmp_path)
    _write(repo, "app-one/extra.py", "def brand_new_helper():\n    return 3\n")
    report = C.analyze_repo(repo / "app-one")

    assert report["scope"] == "app-one"
    names = {u["name"] for u in report["tests"]["uncovered"]}
    assert names == {"brand_new_helper"}
    # nothing from the sibling app leaks into the comparison corpus
    modules = {h["other_module"] for h in report["reuse"]["similar"]}
    assert not any(m.startswith("app-two") for m in modules)


def test_local_helpers_inside_a_function_are_not_listed(tmp_path):
    """A closure defined inside a function is not a separately testable unit."""
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "keep.py", "def keep():\n    return 1\n")
    _write(target, "keep.py", "def keep():\n    return 1\n")
    _write(
        target,
        "app.py",
        "def outer(rows):\n"
        "    def inner(row):\n"
        "        return row * 2\n"
        "    return [inner(r) for r in rows]\n",
    )
    report = C.compute_review(base, target, _index(base), _index(target))
    reported = {u["name"] for u in report["tests"]["uncovered"]}
    assert "outer" in reported
    assert "inner" not in reported


def test_uncovered_functions_reported_largest_first(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "keep.py", "def keep():\n    return 1\n")
    _write(target, "keep.py", "def keep():\n    return 1\n")
    _write(
        target,
        "app.py",
        "def small():\n    return 1\n\n"
        "def large():\n" + "".join(f"    x{i} = {i}\n" for i in range(12)) + "    return 0\n",
    )
    report = C.compute_review(base, target, _index(base), _index(target))
    uncovered = [u["name"] for u in report["tests"]["uncovered"]]
    assert uncovered[0] == "large"
    assert "small" in uncovered


# ---- honest reporting -------------------------------------------------------

def test_language_without_recognisable_tests_is_reported_unchecked(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "keep.py", "def keep():\n    return 1\n")
    _write(target, "keep.py", "def keep():\n    return 1\n")
    _write(target, "lib.rs", "pub fn compute(a: i32) -> i32 { a }\n")
    report = C.compute_review(base, target, _index(base), _index(target))
    assert "rust" in report["checked"]["test_linkage_unavailable_for"]


def test_language_with_recognisable_tests_is_not_flagged(tmp_path):
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base, "keep.py", "def keep():\n    return 1\n")
    _write(target, "keep.py", "def keep():\n    return 1\n")
    _write(target, "app.py", "def render_body(x):\n    return x\n")
    _write(
        target,
        "tests/test_app.py",
        "from app import render_body\n"
        "def test_render_body():\n"
        "    assert render_body(1) == 1\n",
    )
    report = C.compute_review(base, target, _index(base), _index(target))
    assert "python" not in report["checked"]["test_linkage_unavailable_for"]


# ---- semantic search --------------------------------------------------------

def _fake_embedder(width=512):
    """Fixed-width hashed bag of words, so tests need no model on disk.

    The width is fixed rather than grown from a vocabulary, because the corpus
    and the query are embedded in separate calls and must come back the same
    length.
    """

    def embed(texts):
        rows = []
        for text in texts:
            vec = [0.0] * width
            for word in re.findall(r"[a-z]{3,}", text.lower()):
                vec[hash(word) % width] = 1.0
            rows.append(vec)
        return rows

    return embed



