import importlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import ModuleType

import pytest


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


@pytest.fixture()
def roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    state = tmp_path / "state"
    files = tmp_path / "home"
    data = tmp_path / "app" / "data"
    state.mkdir()
    files.mkdir()
    monkeypatch.setattr(app, "STATE_ROOT", state)
    monkeypatch.setattr(app, "FILES_ROOT", files)
    monkeypatch.setattr(app, "DATA_DIR", data)
    monkeypatch.setattr(app, "DATABASE_PATH", data / "projects.sqlite3")
    return state, files, data


def add_conversation(
    state: Path,
    conversation_id: str,
    *,
    title: str = "Research chat",
    archived: bool = False,
) -> Path:
    base = state / "conversations" / ("_archived" if archived else "") / conversation_id
    base.mkdir(parents=True)
    events = [
        {
            "type": "user_message",
            "timestamp": "2026-07-01T10:00:00+00:00",
            "agent_id": "root.default.1",
            "depth": 0,
            "content": "Please research garden plans",
        },
        {
            "type": "assistant_message",
            "timestamp": "2026-07-01T10:05:00+00:00",
            "agent_id": "root.default.1",
            "agent_name": "Omnideck",
            "content": "Done",
        },
    ]
    (base / "events.jsonl").write_text(
        "\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8"
    )
    (base / "metadata.json").write_text(
        json.dumps({"title": title, "profile_id": "default"}), encoding="utf-8"
    )
    return base


def add_artifact(
    state: Path,
    files: Path,
    *,
    artifact_id: str = "artifact-1",
    conversation_id: str = "chat-1",
    present: bool = True,
) -> Path:
    path = files / f"{artifact_id}.md"
    if present:
        path.write_text("artifact output", encoding="utf-8")
    index_path = state / "artifacts" / "index.json"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    current = (
        json.loads(index_path.read_text())
        if index_path.exists()
        else {"version": 1, "artifacts": {}}
    )
    current["artifacts"][artifact_id] = {
        "id": artifact_id,
        "conversation_id": conversation_id,
        "path": str(path),
        "filename": path.name,
        "content_type": "text/markdown",
        "agent_name": "Omnideck",
        "created_at": "2026-07-01T10:00:00+00:00",
        "updated_at": "2026-07-01T10:05:00+00:00",
    }
    index_path.write_text(json.dumps(current), encoding="utf-8")
    return path


def create_project(name: str = "Garden") -> dict:
    result = app.create_project(name, "Planning and research", "#10b981", ["home"])
    assert result["success"] is True
    return result["project"]


def test_only_intended_functions_are_actions() -> None:
    expected = {
        "assign_conversation_bundle",
        "assign_items",
        "browse_files",
        "create_project",
        "delete_project",
        "get_dashboard",
        "get_conversation_details",
        "get_inbox",
        "get_project_items",
        "get_storage_report",
        "list_artifacts",
        "list_conversations",
        "list_projects",
        "remove_project_item",
        "update_item_note",
        "update_project",
    }
    discovered = {
        value.__omnideck_action_name__
        for value in vars(app).values()
        if callable(value) and hasattr(value, "__omnideck_action_name__")
    }
    assert discovered == expected


def test_project_state_is_created_only_in_data_directory(
    roots: tuple[Path, Path, Path],
) -> None:
    state, files, data = roots

    project = create_project()

    assert project["name"] == "Garden"
    assert app.DATABASE_PATH.parent == data
    assert app.DATABASE_PATH.is_file()
    assert list(state.iterdir()) == []
    assert list(files.iterdir()) == []


def test_welcome_is_first_run_only_and_stored_in_app_data(
    roots: tuple[Path, Path, Path],
) -> None:
    state, files, data = roots

    first = app.get_dashboard()
    second = app.get_dashboard()

    assert first["first_run"] is True
    assert second["first_run"] is False
    assert app.DATABASE_PATH.is_relative_to(data)
    assert list(state.iterdir()) == []
    assert list(files.iterdir()) == []


def test_existing_project_skips_first_run_welcome(
    roots: tuple[Path, Path, Path],
) -> None:
    create_project()

    assert app.get_dashboard()["first_run"] is False


def test_project_validation_and_update(roots: tuple[Path, Path, Path]) -> None:
    project = create_project()

    result = app.update_project(
        project["id"],
        "Backyard",
        "New description",
        "#ef476f",
        ["Home", "home", "2026"],
    )

    assert result["project"]["name"] == "Backyard"
    assert result["project"]["tags"] == ["Home", "2026"]
    assert app.create_project(" ")["error"] == "Project name cannot be empty."


def test_assign_and_remove_conversation_without_touching_source(
    roots: tuple[Path, Path, Path],
) -> None:
    state, _, _ = roots
    conversation = add_conversation(state, "chat-1")
    original = (conversation / "events.jsonl").read_bytes()
    project = create_project()

    assigned = app.assign_items(
        project["id"], [{"type": "conversation", "id": "chat-1"}]
    )
    project_items = app.get_project_items(project["id"])
    removed = app.remove_project_item(project["id"], "conversation", "chat-1")

    assert assigned == {"success": True, "added": 1, "already_present": 0}
    assert project_items["items"][0]["title"] == "Research chat"
    assert project_items["storage"]["conversation"] == sum(
        path.stat().st_size for path in conversation.iterdir()
    )
    assert removed["source_data_changed"] is False
    assert (conversation / "events.jsonl").read_bytes() == original


def test_conversation_metadata_includes_archive_and_storage(
    roots: tuple[Path, Path, Path],
) -> None:
    state, _, _ = roots
    add_conversation(state, "active-chat")
    add_conversation(state, "old-chat", title="Old notes", archived=True)

    result = app.list_conversations(archive="all")
    archived = next(
        item for item in result["conversations"] if item["id"] == "old-chat"
    )

    assert result["total"] == 2
    assert archived["archived"] is True
    assert archived["turn_count"] == 1
    assert archived["size"] > 0


def test_conversation_details_explain_storage_artifacts_and_spawned_agents(
    roots: tuple[Path, Path, Path],
) -> None:
    state, files, _ = roots
    conversation = add_conversation(state, "chat-1")
    (conversation / "browser_tabs.json").write_text(
        json.dumps({"tabs": ["https://example.com"]}), encoding="utf-8"
    )
    with (conversation / "events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {
                    "type": "agent_started",
                    "timestamp": "2026-07-01T10:06:00+00:00",
                    "agent_id": "root.researcher.2",
                    "agent_name": "Researcher",
                    "profile_name": "research",
                    "depth": 1,
                    "parent_agent_id": "root.default.1",
                    "instruction": "Find the best planting schedule",
                }
            )
            + "\n"
        )
        handle.write(
            json.dumps(
                {
                    "type": "iteration",
                    "timestamp": "2026-07-01T10:07:00+00:00",
                    "agent_id": "root.researcher.2",
                    "agent_name": "Researcher",
                    "depth": 1,
                }
            )
            + "\n"
        )
        handle.write(
            json.dumps(
                {
                    "type": "tool_result",
                    "timestamp": "2026-07-01T10:07:30+00:00",
                    "agent_id": "root.researcher.2",
                    "agent_name": "Researcher",
                    "depth": 1,
                }
            )
            + "\n"
        )
        handle.write(
            json.dumps(
                {
                    "type": "agent_completed",
                    "timestamp": "2026-07-01T10:08:00+00:00",
                    "agent_id": "root.researcher.2",
                    "agent_name": "Researcher",
                    "depth": 1,
                    "status": "completed",
                }
            )
            + "\n"
        )
    first_artifact = add_artifact(
        state, files, artifact_id="present", conversation_id="chat-1"
    )
    first_artifact.write_bytes(b"artifact contents")
    add_artifact(
        state,
        files,
        artifact_id="missing",
        conversation_id="chat-1",
        present=False,
    )

    result = app.get_conversation_details("chat-1")

    assert result["conversation"]["artifact_count"] == 2
    assert result["artifact_summary"] == {
        "count": 2,
        "present_count": 1,
        "missing_count": 1,
        "bytes": len(b"artifact contents"),
    }
    assert result["related_bytes"] == (
        result["storage"]["total"] + result["artifact_summary"]["bytes"]
    )
    assert (
        sum(item["size"] for item in result["storage"]["categories"])
        == result["storage"]["total"]
    )
    assert {item["key"] for item in result["storage"]["categories"]} >= {
        "events",
        "metadata",
        "browser",
    }
    spawned = next(
        item
        for item in result["agent_activity"]["agents"]
        if item["id"] == "root.researcher.2"
    )
    assert len(result["agent_activity"]["agents"]) == 1
    assert spawned["spawned"] is True
    assert spawned["turn_count"] == 1
    assert spawned["tool_result_count"] == 1
    assert spawned["status"] == "completed"
    assert "profile_name" not in spawned
    assert "parent_agent_id" not in spawned
    assert result["agent_activity"]["totals"] == {
        "turns": 1,
        "tool_results": 1,
        "outputs": 0,
    }


def test_conversations_filter_by_artifacts_and_sort_by_total_storage(
    roots: tuple[Path, Path, Path],
) -> None:
    state, files, _ = roots
    add_conversation(state, "with-artifacts", title="With artifacts")
    add_conversation(state, "without-artifacts", title="Without artifacts")
    add_conversation(state, "missing-artifact", title="Missing artifact")
    artifact = add_artifact(
        state,
        files,
        artifact_id="large",
        conversation_id="with-artifacts",
    )
    artifact.write_bytes(b"x" * 4096)
    add_artifact(
        state,
        files,
        artifact_id="missing",
        conversation_id="missing-artifact",
        present=False,
    )

    with_artifacts = app.list_conversations(artifact_filter="with")
    without_artifacts = app.list_conversations(artifact_filter="without")
    missing_artifacts = app.list_conversations(artifact_filter="missing")
    by_total_size = app.list_conversations(sort="total_size")

    assert {item["id"] for item in with_artifacts["conversations"]} == {
        "with-artifacts",
        "missing-artifact",
    }
    assert [item["id"] for item in without_artifacts["conversations"]] == [
        "without-artifacts"
    ]
    assert [item["id"] for item in missing_artifacts["conversations"]] == [
        "missing-artifact"
    ]
    largest = by_total_size["conversations"][0]
    assert largest["id"] == "with-artifacts"
    assert largest["total_size"] == largest["size"] + 4096


def test_assign_conversation_bundle_is_atomic_idempotent_and_non_destructive(
    roots: tuple[Path, Path, Path],
) -> None:
    state, files, _ = roots
    conversation = add_conversation(state, "chat-1")
    present = add_artifact(
        state, files, artifact_id="present", conversation_id="chat-1"
    )
    add_artifact(
        state,
        files,
        artifact_id="missing",
        conversation_id="chat-1",
        present=False,
    )
    conversation_before = (conversation / "events.jsonl").read_bytes()
    artifact_before = present.read_bytes()
    project = create_project()

    first = app.assign_conversation_bundle(project["id"], "chat-1")
    second = app.assign_conversation_bundle(project["id"], "chat-1")
    project_items = app.get_project_items(project["id"])["items"]

    assert first == {
        "success": True,
        "added": 3,
        "conversation_added": True,
        "artifacts_added": 2,
        "artifact_total": 2,
        "already_present": 0,
        "source_data_changed": False,
    }
    assert second["added"] == 0
    assert second["already_present"] == 3
    assert {(item["type"], item["id"]) for item in project_items} == {
        ("conversation", "chat-1"),
        ("artifact", "present"),
        ("artifact", "missing"),
    }
    assert (conversation / "events.jsonl").read_bytes() == conversation_before
    assert present.read_bytes() == artifact_before


def test_corrupt_conversation_does_not_hide_healthy_conversations(
    roots: tuple[Path, Path, Path],
) -> None:
    state, _, _ = roots
    add_conversation(state, "healthy")
    broken = state / "conversations" / "broken"
    broken.mkdir(parents=True)
    (broken / "events.jsonl").write_text(
        '{not-json}\n{"type":"user_message","timestamp":42,"agent_id":7,"content":"Hi"}\n',
        encoding="utf-8",
    )

    result = app.list_conversations()

    assert {item["id"] for item in result["conversations"]} == {"healthy", "broken"}


def test_artifact_status_and_orphan_provenance(roots: tuple[Path, Path, Path]) -> None:
    state, files, _ = roots
    add_conversation(state, "chat-1")
    add_artifact(state, files, artifact_id="present", conversation_id="chat-1")
    add_artifact(
        state, files, artifact_id="missing", conversation_id="gone", present=False
    )

    result = app.list_artifacts()
    by_id = {item["id"]: item for item in result["artifacts"]}

    assert by_id["present"]["status"] == "present"
    assert by_id["present"]["conversation_title"] == "Research chat"
    assert by_id["missing"]["status"] == "missing"
    assert by_id["missing"]["orphaned"] is True


def test_file_browser_rejects_escape_and_hides_dotfiles(
    roots: tuple[Path, Path, Path], tmp_path: Path
) -> None:
    _, files, _ = roots
    (files / "visible.txt").write_text("hello", encoding="utf-8")
    (files / ".secret").write_text("hidden", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    (files / "escape").symlink_to(outside, target_is_directory=True)

    result = app.browse_files()
    escaped = app.browse_files(str(outside))

    assert [item["title"] for item in result["items"]] == ["visible.txt"]
    assert "inside the Omnideck user-files directory" in escaped["error"]


def test_inbox_excludes_assigned_items(roots: tuple[Path, Path, Path]) -> None:
    state, files, _ = roots
    add_conversation(state, "chat-1")
    add_artifact(state, files)
    (files / "loose.txt").write_text("loose", encoding="utf-8")
    project = create_project()
    app.assign_items(project["id"], [{"type": "conversation", "id": "chat-1"}])

    result = app.get_inbox()

    assert result["conversations"] == []
    assert [item["id"] for item in result["artifacts"]] == ["artifact-1"]
    assert any(item["title"] == "loose.txt" for item in result["files"])


def test_project_delete_removes_only_app_owned_links(
    roots: tuple[Path, Path, Path],
) -> None:
    state, _, _ = roots
    conversation = add_conversation(state, "chat-1")
    project = create_project()
    app.assign_items(project["id"], [{"type": "conversation", "id": "chat-1"}])

    result = app.delete_project(project["id"])

    assert result["source_data_changed"] is False
    assert result["removed_assignments"] == 1
    assert conversation.is_dir()
    assert app.list_projects()["projects"] == []


def test_storage_scan_is_read_only_and_finds_exact_duplicates(
    roots: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, files, _ = roots
    first = files / "first.bin"
    second = files / "second.bin"
    duplicate_content = b"same contents" * 90_000
    first.write_bytes(duplicate_content)
    second.write_bytes(duplicate_content)
    hidden_cache = files / ".config"
    hidden_cache.mkdir()
    (hidden_cache / "browser-metrics.bin").write_bytes(duplicate_content)
    toolchain = files / "go"
    toolchain.mkdir()
    (toolchain / "compiler.bin").write_bytes(duplicate_content)
    old_time = 1_600_000_000
    os.utime(first, (old_time, old_time))
    os.utime(second, (old_time, old_time))
    before = {path.name: path.read_bytes() for path in (first, second)}
    monkeypatch.setattr(app, "LARGE_FILE_BYTES", 4)

    report = app.get_storage_report(refresh=True)

    assert report["read_only"] is True
    assert report["summary"]["files"] == 2
    assert report["summary"]["large_files"] == 2
    assert report["summary"]["stale_files"] == 2
    assert report["duplicates"][0]["copies"] == 2
    assert {path.name: path.read_bytes() for path in (first, second)} == before
    assert app.get_storage_report(refresh=False)["cached_at"]
