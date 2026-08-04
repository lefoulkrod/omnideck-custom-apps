"""Unit tests for the symbol index engine."""

from pathlib import Path

import pytest

import symbols as S


def _write(tmp_path, name, content):
    f = tmp_path / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(content, encoding="utf-8")
    return f


# ---- per-language extraction ------------------------------------------------

def test_python_extraction(tmp_path):
    _write(tmp_path, "mod.py", """
import os
from pathlib import Path

class Foo:
    def bar(self, x):
        return self.helper(x)
    def helper(self, y):
        return y * 2

def top(a):
    return Foo().bar(a)
""")
    idx = S.build_symbol_index(tmp_path)
    names = {s["name"] for s in idx["symbols"]}
    assert {"Foo", "bar", "helper", "top"} <= names
    foo = next(s for s in idx["symbols"] if s["name"] == "Foo")
    assert foo["kind"] == "class"
    bar = next(s for s in idx["symbols"] if s["name"] == "bar")
    assert bar["kind"] == "method"
    assert bar["enclosing"] == foo["id"]
    top = next(s for s in idx["symbols"] if s["name"] == "top")
    assert top["kind"] == "function"
    assert top["enclosing"] is None


def test_python_call_resolution(tmp_path):
    _write(tmp_path, "mod.py", """
def g(y):
    return y * 2
def f(x):
    return g(x)
""")
    idx = S.build_symbol_index(tmp_path)
    f = next(s for s in idx["symbols"] if s["name"] == "f")
    g = next(s for s in idx["symbols"] if s["name"] == "g")
    assert g["id"] in f["callees"]
    assert f["id"] in g["callers"]


def test_python_method_call_resolved_by_name(tmp_path):
    _write(tmp_path, "mod.py", """
class A:
    def run(self):
        return self.step()
    def step(self):
        return 1
""")
    idx = S.build_symbol_index(tmp_path)
    run = next(s for s in idx["symbols"] if s["name"] == "run")
    step = next(s for s in idx["symbols"] if s["name"] == "step")
    assert step["id"] in run["callees"]


def test_javascript_extraction(tmp_path):
    _write(tmp_path, "mod.js", """
import { helper } from './util';

export function main(x) {
  return helper(x) + extra(x);
}
export class Widget {
  render() { return this.draw(); }
  draw() { return 1; }
}
const arrow = (n) => n + 1;
""")
    idx = S.build_symbol_index(tmp_path)
    names = {s["name"] for s in idx["symbols"]}
    assert {"main", "Widget", "render", "draw", "arrow"} <= names
    widget = next(s for s in idx["symbols"] if s["name"] == "Widget")
    assert widget["kind"] == "class"
    render = next(s for s in idx["symbols"] if s["name"] == "render")
    assert render["kind"] == "method"
    assert render["enclosing"] == widget["id"]


def test_go_extraction(tmp_path):
    _write(tmp_path, "main.go", """package main
import "fmt"
type Bar struct { x int }
func (b Bar) Method() int { return b.x }
func helper(n int) int { return n + 1 }
func main() { fmt.Println(helper(5)) }
""")
    idx = S.build_symbol_index(tmp_path)
    names = {s["name"] for s in idx["symbols"]}
    assert {"Bar", "Method", "helper", "main"} <= names
    method = next(s for s in idx["symbols"] if s["name"] == "Method")
    assert method["kind"] == "method"
    main = next(s for s in idx["symbols"] if s["name"] == "main")
    # helper is called from main
    helper = next(s for s in idx["symbols"] if s["name"] == "helper")
    assert helper["id"] in main["callees"]


def test_go_dependency_edges(tmp_path):
    _write(tmp_path, "main.go", """package main
import "example.com/proj/cmd"
func main() { cmd.Run() }
""")
    _write(tmp_path, "cmd/root.go", """package cmd
func Run() {}
""")
    idx = S.build_symbol_index(tmp_path)
    edges = {(e["from"], e["to"]) for e in idx["edges"]}
    assert ("main.go", "cmd/root.go") in edges


def test_python_dependency_edges(tmp_path):
    _write(tmp_path, "pkg/a.py", "from pkg.b import thing\ndef x(): return thing()\n")
    _write(tmp_path, "pkg/b.py", "def thing(): return 1\n")
    idx = S.build_symbol_index(tmp_path)
    edges = {(e["from"], e["to"]) for e in idx["edges"]}
    assert ("pkg/a.py", "pkg/b.py") in edges


def test_js_dependency_edges(tmp_path):
    _write(tmp_path, "app.js", "import { x } from './util';\nexport function main(){ return x(); }")
    _write(tmp_path, "util.js", "export function x(){ return 1; }")
    idx = S.build_symbol_index(tmp_path)
    edges = {(e["from"], e["to"]) for e in idx["edges"]}
    assert ("app.js", "util.js") in edges


def test_ignores_vendor_dirs(tmp_path):
    _write(tmp_path, "node_modules/lib.js", "export function f(){ return 1; }")
    _write(tmp_path, "src.js", "export function g(){ return 2; }")
    idx = S.build_symbol_index(tmp_path)
    names = {s["name"] for s in idx["symbols"]}
    assert "f" not in names
    assert "g" in names


def test_summary_counts(tmp_path):
    _write(tmp_path, "m.py", "def a():\n    return b()\ndef b():\n    return 1\n")
    idx = S.build_symbol_index(tmp_path)
    assert idx["symbol_count"] == 2
    assert idx["call_count"] >= 1
    assert idx["summary"]["symbols"] == 2


def test_symbol_id_stable(tmp_path):
    _write(tmp_path, "m.py", "def uniq():\n    return 1\n")
    idx = S.build_symbol_index(tmp_path)
    s = idx["symbols"][0]
    assert s["id"] == "m.py::uniq@1"


def test_signature_extracted(tmp_path):
    _write(tmp_path, "m.py", "def add(a, b, c=0):\n    return a + b + c\n")
    idx = S.build_symbol_index(tmp_path)
    s = idx["symbols"][0]
    assert "add" in s["signature"]
    assert "a" in s["signature"]


def test_unresolved_calls_counted(tmp_path):
    _write(tmp_path, "m.py", "def f():\n    return nonexistent_function()\n")
    idx = S.build_symbol_index(tmp_path)
    assert idx["unresolved_calls"] >= 1


# ---- named callbacks --------------------------------------------------------

def _parse(language, source):
    from tree_sitter_language_pack import get_parser

    return get_parser(language).parse(source.encode())


def _first_literal(node, types):
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type in types:
            return current
        stack.extend(current.named_children)
    return None


def test_string_literal_text_strips_quotes():
    tree = _parse("javascript", "it('groups events', fn)")
    literal = _first_literal(tree.root_node, {"string"})
    assert S._string_literal_text(literal) == "groups events"


def test_string_literal_text_rejects_non_strings():
    tree = _parse("javascript", "it(42, fn)")
    number = _first_literal(tree.root_node, {"number"})
    assert S._string_literal_text(number) is None


def test_callback_label_names_a_javascript_test():
    tree = _parse("javascript", "it('groups events into turns', () => { run(); })")
    literal = _first_literal(tree.root_node, {"arrow_function"})
    assert S._callback_label(literal) == 'it("groups events into turns")'


def test_callback_label_names_a_go_subtest():
    source = 'func T(t *testing.T) { t.Run("groups events", func(t *testing.T) { Run() }) }'
    tree = _parse("go", source)
    literal = _first_literal(tree.root_node, {"func_literal"})
    assert S._callback_label(literal) == 't.Run("groups events")'


def test_callback_label_names_a_ruby_block():
    tree = _parse("ruby", 'it "groups events" do\n  run\nend\n')
    literal = _first_literal(tree.root_node, {"do_block"})
    assert S._callback_label(literal) == 'it("groups events")'


def test_callback_label_skips_unlabelled_closures(tmp_path):
    """useEffect and friends must not become symbols, or the index balloons."""
    tree = _parse("javascript", "useEffect(() => { run(); }, [dep])")
    literal = _first_literal(tree.root_node, {"arrow_function"})
    assert S._callback_label(literal) is None


def test_unlabelled_closures_are_not_registered_as_symbols(tmp_path):
    _write(tmp_path, "c.js", "function C(){ useEffect(() => { helper(); }, []); }\n")
    idx = S.build_symbol_index(tmp_path)
    assert not [s for s in idx["symbols"] if s["kind"] == "callback"]


def test_jsx_component_use_is_a_call_edge(tmp_path):
    _write(tmp_path, "Row.jsx", "export default function Row(){ return null; }\n")
    _write(
        tmp_path,
        "App.jsx",
        "import Row from './Row';\n"
        "export default function App(){ return <div><Row /></div>; }\n",
    )
    idx = S.build_symbol_index(tmp_path)
    by_id = {s["id"]: s for s in idx["symbols"]}
    row = next(s for s in idx["symbols"] if s["name"] == "Row")
    assert "App" in {by_id[c]["name"] for c in row["callers"] if c in by_id}


def test_typescript_arrow_function_is_a_definition(tmp_path):
    _write(tmp_path, "h.ts", "export const handler = async (req) => run(req);\n")
    idx = S.build_symbol_index(tmp_path)
    assert "handler" in {s["name"] for s in idx["symbols"]}