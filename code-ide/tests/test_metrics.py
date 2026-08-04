"""Unit tests for the metrics engine."""

import os
import tempfile
from pathlib import Path

import pytest

import metrics as M


# ---- line counting ---------------------------------------------------------

def test_count_lines_python():
    src = "# header\n\nx = 1\ny = 2  # trailing\n"
    res = M.count_lines(src, "python")
    assert res == {"total": 4, "code": 2, "comment": 1, "blank": 1}


def test_count_lines_js_block_comment():
    src = "/* a\n b */\nlet x = 1;\n\n"
    res = M.count_lines(src, "javascript")
    assert res["comment"] == 2
    assert res["code"] == 1
    assert res["blank"] == 1


def test_count_lines_blank_only():
    res = M.count_lines("\n\n\n", "python")
    assert res == {"total": 3, "code": 0, "comment": 0, "blank": 3}


# ---- complexity -------------------------------------------------------------

def test_py_complexity_branches():
    src = "def f(a):\n    if a:\n        return 1\n    for i in range(2):\n        pass\n    return 0\n"
    cc, funcs = M.compute_complexity(src, "python")
    assert len(funcs) == 1
    assert funcs[0]["name"] == "f"
    # base 1 + if + for = 3
    assert funcs[0]["complexity"] == 3
    assert cc == 3


def test_py_complexity_boolop():
    src = "def f(a, b):\n    return a and b or (a and b)\n"
    cc, funcs = M.compute_complexity(src, "python")
    # base 1 + (2 and values -1) + (2 or values -1) + (2 and values -1) = 1+1+1+1 = 4
    assert funcs[0]["complexity"] == 4


def test_py_complexity_comprehension():
    src = "def f(xs):\n    return [x for x in xs if x]\n"
    cc, funcs = M.compute_complexity(src, "python")
    # base 1 + ListComp + (if in comp counts as branch via IfExp? no) -> 2
    assert funcs[0]["complexity"] == 2


def test_py_complexity_syntax_error_returns_empty():
    src = "def f(:\n"
    cc, funcs = M.compute_complexity(src, "python")
    assert funcs == []


def test_heuristic_complexity_js():
    src = "function f() { if (a) {} for (let i=0;i<n;i++) {} switch(x){case 1:} }"
    cc, funcs = M.compute_complexity(src, "javascript")
    # base 1 + if + for + switch + case + && (0) = 5
    assert cc == 5
    assert funcs == []


def test_heuristic_complexity_go():
    src = "if a {}\nfor {}\nswitch x { case 1: case 2: }\nselect {}\n"
    cc, _ = M.compute_complexity(src, "go")
    # base 1 + if + for + switch + 2*case + select = 7
    assert cc == 7


def test_unknown_language_complexity_is_one():
    cc, funcs = M.compute_complexity("anything", "brainfuck")
    assert cc == 1
    assert funcs == []


# ---- readability ------------------------------------------------------------

def test_readability_high_for_clean_code():
    src = (
        "# A well documented function.\n"
        "# Explains what it does.\n"
        "def add(a, b):\n"
        "    # returns the sum\n"
        "    return a + b\n"
    )
    m = {
        "lines": M.count_lines(src, "python"),
        "complexity": 1,
        "functions": [{"name": "add", "line": 3, "length": 3, "complexity": 1}],
        "avg_line_len": 20,
    }
    score = M.readability_score(m)
    assert score >= 70


def test_readability_low_for_dense_code():
    src = "def f(a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z):\n    return a and b or c and d or e and f or g and h or i and j or k and l or m and n or o and p or q and r or s and t or u and v or w and x or y and z\n"
    m = {
        "lines": M.count_lines(src, "python"),
        "complexity": 50,
        "functions": [{"name": "f", "line": 1, "length": 2, "complexity": 50}],
        "avg_line_len": 200,
    }
    score = M.readability_score(m)
    assert score < 40


# ---- duplication -----------------------------------------------------------

def test_find_duplicates_basic():
    block = "alpha = 1\nbeta = 2\ngamma = 3\ndelta = 4\nepsilon = 5\nzeta = 6\n"
    norm = [M._normalize_line(l, "python") for l in block.splitlines()]
    files = [
        {"path": "a.py", "lines": norm},
        {"path": "b.py", "lines": norm},
    ]
    dupes = M.find_duplicates(files)
    assert len(dupes) >= 1
    assert dupes[0]["lines"] >= 6
    paths = {o["path"] for o in dupes[0]["occurrences"]}
    assert paths == {"a.py", "b.py"}


def test_find_duplicates_no_match():
    files = [
        {"path": "a.py", "lines": ["x", "y", "z", "a", "b", "c"]},
        {"path": "b.py", "lines": ["1", "2", "3", "4", "5", "6"]},
    ]
    assert M.find_duplicates(files) == []


# ---- analyze_file / build_index --------------------------------------------

def test_analyze_file_python(tmp_path):
    f = tmp_path / "mod.py"
    f.write_text("def f(x):\n    if x:\n        return 1\n    return 0\n")
    m = M.analyze_file(f, tmp_path)
    assert m["language"] == "python"
    assert m["lines"]["total"] == 4
    assert m["complexity"] == 2
    assert len(m["functions"]) == 1
    assert 0 <= m["readability"] <= 100


def test_analyze_file_skips_non_code(tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("hello\n")
    assert M.analyze_file(f, tmp_path) is None


def test_analyze_file_skips_binary(tmp_path):
    f = tmp_path / "blob.py"
    f.write_bytes(b"\x00\x01\x02 binary")
    assert M.analyze_file(f, tmp_path) is None


def test_build_index_structure(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.py").write_text("x = 1\n")
    (tmp_path / "pkg" / "b.py").write_text("def g():\n    return 1\n")
    (tmp_path / "top.py").write_text("y = 2\n")
    idx = M.build_index(tmp_path)
    assert idx["file_count"] == 3
    assert idx["totals"]["files"] == 3
    tree = idx["tree"]
    dir_names = [d["name"] for d in tree["dirs"]]
    assert "pkg" in dir_names
    pkg = next(d for d in tree["dirs"] if d["name"] == "pkg")
    assert pkg["file_count"] == 2
    assert len(tree["files"]) == 1
    assert tree["files"][0]["name"] == "top.py"


def test_build_index_ignores_dirs(tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "lib.js").write_text("module.exports = 1\n")
    (tmp_path / "src.js").write_text("const x = 1\n")
    idx = M.build_index(tmp_path)
    assert idx["file_count"] == 1
    assert idx["files"][0]["path"] == "src.js"


def test_build_index_hotspots_sorted(tmp_path):
    (tmp_path / "f.py").write_text(
        "def easy():\n    return 1\n"
        "def hard(a,b,c):\n"
        "    if a:\n"
        "        if b:\n"
        "            if c:\n"
        "                for i in range(2):\n"
        "                    while i:\n"
        "                        pass\n"
        "    return 0\n"
    )
    idx = M.build_index(tmp_path)
    assert idx["hotspots"][0]["name"] == "hard"
    assert idx["hotspots"][0]["complexity"] > idx["hotspots"][-1]["complexity"]