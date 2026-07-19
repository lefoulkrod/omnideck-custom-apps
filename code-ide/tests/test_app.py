import importlib
import importlib.util
from pathlib import Path
import sys
from types import ModuleType

import pytest


# The decorator package is supplied by Omnideck's Custom Apps container. Keep
# local unit tests independent of that container while preserving its discovery
# contract exactly.
if importlib.util.find_spec("custom_apps") is None:
    custom_apps = ModuleType("custom_apps")

    def action(function=None, /, *, name=None):
        def decorate(target):
            target.__omnideck_action_name__ = name or target.__name__
            return target

        return decorate(function) if function is not None else decorate

    custom_apps.action = action
    sys.modules["custom_apps"] = custom_apps

app = importlib.import_module("app")


def test_only_public_backend_actions_are_decorated() -> None:
    expected = {
        "create_file",
        "create_folder",
        "delete_path",
        "format_content",
        "get_home",
        "git_diff",
        "git_status",
        "list_dir",
        "list_dir_with_hidden",
        "load_state",
        "read_file",
        "rename_path",
        "replace_in_files",
        "run_command",
        "save_state",
        "search_files",
        "stat_file",
        "stat_files",
        "write_file",
    }
    discovered = {
        value.__omnideck_action_name__
        for value in vars(app).values()
        if callable(value) and hasattr(value, "__omnideck_action_name__")
    }

    assert discovered == expected
    assert not hasattr(app, "actions")


@pytest.fixture()
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".hidden-home"
    home.mkdir()
    monkeypatch.setattr(app, "HOME", home.resolve())
    monkeypatch.setattr(app, "STATE_FILE", home / ".state" / "state.json")
    return home


def test_safe_path_rejects_outside_home_and_symlink(isolated_home: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    link = isolated_home / "escape"
    link.symlink_to(outside, target_is_directory=True)

    with pytest.raises(PermissionError):
        app._safe_path(str(outside))
    with pytest.raises(PermissionError):
        app._safe_path(str(link))


def test_atomic_write_detects_disk_conflict(isolated_home: Path) -> None:
    target = isolated_home / "example.txt"
    target.write_text("one", encoding="utf-8")
    original_mtime = target.stat().st_mtime
    target.write_text("external", encoding="utf-8")

    result = app.write_file(str(target), "editor", expected_modified=original_mtime)

    assert result["conflict"] is True
    assert target.read_text(encoding="utf-8") == "external"


def test_delete_refuses_home_directory(isolated_home: Path) -> None:
    result = app.delete_path(str(isolated_home))

    assert "Refusing" in result["error"]
    assert isolated_home.exists()


def test_delete_removes_internal_symlink_not_its_target(isolated_home: Path) -> None:
    target = isolated_home / "target"
    target.mkdir()
    (target / "keep.txt").write_text("keep", encoding="utf-8")
    link = isolated_home / "link"
    link.symlink_to(target, target_is_directory=True)

    result = app.delete_path(str(link))

    assert result["success"] is True
    assert not link.exists()
    assert (target / "keep.txt").exists()


@pytest.mark.parametrize("name", ["../move", "nested/name", ".", "..", ""])
def test_rename_rejects_non_basename(isolated_home: Path, name: str) -> None:
    target = isolated_home / "old.txt"
    target.write_text("content", encoding="utf-8")

    result = app.rename_path(str(target), name)

    assert "error" in result
    assert target.exists()


def test_search_works_when_root_itself_is_hidden(isolated_home: Path) -> None:
    workspace = isolated_home / ".workspace"
    workspace.mkdir()
    (workspace / "app.py").write_text("print('hello')", encoding="utf-8")

    result = app.search_files(str(workspace), "app.py")

    assert [item["name"] for item in result["results"]] == ["app.py"]


def test_search_does_not_follow_file_symlink_outside_home(
    isolated_home: Path, tmp_path: Path,
) -> None:
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("unique-secret", encoding="utf-8")
    (isolated_home / "linked-secret.txt").symlink_to(outside)

    result = app.search_files(str(isolated_home), "unique-secret", content=True)

    assert result["results"] == []


def test_content_search_honors_include_and_noise_exclusions(isolated_home: Path) -> None:
    workspace = isolated_home / "project"
    workspace.mkdir()
    (workspace / "keep.py").write_text("needle here", encoding="utf-8")
    (workspace / "skip.txt").write_text("needle here", encoding="utf-8")
    modules = workspace / "node_modules"
    modules.mkdir()
    (modules / "hidden.py").write_text("needle here", encoding="utf-8")

    result = app.search_files(str(workspace), "needle", content=True, include="*.py")

    assert [(item["name"], item["line"]) for item in result["results"]] == [("keep.py", 1)]


def test_replace_in_files_changes_literal_matches(isolated_home: Path) -> None:
    target = isolated_home / "example.js"
    target.write_text("old old", encoding="utf-8")

    result = app.replace_in_files(str(isolated_home), "old", "new", include="*.js")

    assert result["replacements"] == 2
    assert target.read_text(encoding="utf-8") == "new new"


def test_terminal_cd_returns_new_working_directory(isolated_home: Path) -> None:
    child = isolated_home / "child"
    child.mkdir()

    result = app.run_command("cd child", str(isolated_home))

    assert result["exit_code"] == 0
    assert result["cwd"] == str(child)


def test_stat_files_batches_open_tab_metadata(isolated_home: Path) -> None:
    first = isolated_home / "first.txt"
    first.write_text("one", encoding="utf-8")
    missing = isolated_home / "missing.txt"

    result = app.stat_files([str(first), str(missing)])

    assert result["items"][str(first)]["exists"] is True
    assert result["items"][str(missing)]["exists"] is False


def test_state_write_rejects_invalid_json(isolated_home: Path) -> None:
    result = app.save_state("not json")

    assert "error" in result
    assert not app.STATE_FILE.exists()


def test_json_formatter() -> None:
    result = app.format_content('{"a":1}', "JSON")

    assert result["content"] == '{\n  "a": 1\n}\n'
