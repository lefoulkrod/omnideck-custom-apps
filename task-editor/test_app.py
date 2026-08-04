"""Unit tests for the Task Editor custom app.

Tests all Python actions against a temporary routines directory to avoid
modifying real data.
"""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Add omnideck to path for custom_apps
sys.path.insert(0, "/home/omnideck/omnideck")

import app as task_app


def setup_test_env():
    """Create a temp routines dir and monkey-patch the app to use it."""
    tmpdir = tempfile.mkdtemp(prefix="task_editor_test_")
    routines_dir = Path(tmpdir) / "routines"
    routines_dir.mkdir()
    profiles_dir = Path(tmpdir) / "profiles"
    profiles_dir.mkdir()

    # Create test profiles
    for pid, name, model in [
        ("computron", "Omnideck", "glm-5.2:cloud"),
        ("code_expert", "Code Expert", "deepseek-v4-pro:cloud"),
        ("research_agent", "Research Agent", "glm-5.2:cloud"),
    ]:
        (profiles_dir / f"{pid}.json").write_text(json.dumps({
            "id": pid, "name": name, "description": "test", "model": model, "enabled": True
        }))

    # Monkey-patch paths
    task_app._ROUTINES_DIR = routines_dir
    task_app._PROFILES_DIR = profiles_dir

    # Create a test routine
    routine = {
        "id": "test-routine-1",
        "description": "Test Routine",
        "status": "active",
        "cron": "0 10 * * *",
        "timezone": "America/Chicago",
        "created_at": "2026-07-19T23:00:00.000000+00:00",
        "tasks": [
            {
                "id": "task-1",
                "routine_id": "test-routine-1",
                "description": "First task",
                "instruction": "Do the first thing",
                "agent_profile": "computron",
                "depends_on": [],
                "max_retries": 3,
            },
            {
                "id": "task-2",
                "routine_id": "test-routine-1",
                "description": "Second task",
                "instruction": "Do the second thing",
                "agent_profile": "code_expert",
                "depends_on": ["task-1"],
                "max_retries": 3,
            },
        ],
    }
    (routines_dir / "test-routine-1.json").write_text(json.dumps(routine, indent=2))
    return tmpdir


def cleanup(tmpdir):
    shutil.rmtree(tmpdir, ignore_errors=True)


def test_list_routines():
    tmpdir = setup_test_env()
    try:
        result = task_app.list_routines()
        assert "routines" in result
        assert len(result["routines"]) == 1
        r = result["routines"][0]
        assert r["id"] == "test-routine-1"
        assert r["task_count"] == 2
        assert r["status"] == "active"
        assert r["cron"] == "0 10 * * *"
        print("  ✓ list_routines")
    finally:
        cleanup(tmpdir)


def test_get_routine():
    tmpdir = setup_test_env()
    try:
        result = task_app.get_routine("test-routine-1")
        assert "routine" in result
        assert result["routine"]["id"] == "test-routine-1"
        assert len(result["tasks"]) == 2
        assert result["tasks"][0]["description"] == "First task"
        assert result["tasks"][0]["agent_profile_name"] == "Omnideck"
        assert result["tasks"][1]["agent_profile_name"] == "Code Expert"
        print("  ✓ get_routine")
    finally:
        cleanup(tmpdir)


def test_get_routine_not_found():
    tmpdir = setup_test_env()
    try:
        result = task_app.get_routine("nonexistent")
        assert "error" in result
        print("  ✓ get_routine (not found)")
    finally:
        cleanup(tmpdir)


def test_add_task():
    tmpdir = setup_test_env()
    try:
        result = task_app.add_task(
            "test-routine-1", "New task", "Do something new", "research_agent"
        )
        assert result["ok"] is True
        assert "task" in result
        assert result["task"]["description"] == "New task"
        assert result["task"]["agent_profile"] == "research_agent"
        assert result["task"]["agent_profile_name"] == "Research Agent"

        # Verify it was appended
        routine = task_app.get_routine("test-routine-1")
        assert len(routine["tasks"]) == 3
        assert routine["tasks"][2]["description"] == "New task"
        print("  ✓ add_task")
    finally:
        cleanup(tmpdir)


def test_add_task_validation():
    tmpdir = setup_test_env()
    try:
        # Empty description
        r = task_app.add_task("test-routine-1", "", "instruction")
        assert "error" in r
        assert "Description" in r["error"]

        # Empty instruction
        r = task_app.add_task("test-routine-1", "desc", "")
        assert "error" in r
        assert "Instruction" in r["error"]

        # Nonexistent routine
        r = task_app.add_task("nonexistent", "desc", "instruction")
        assert "error" in r
        print("  ✓ add_task (validation)")
    finally:
        cleanup(tmpdir)


def test_update_task():
    tmpdir = setup_test_env()
    try:
        result = task_app.update_task(
            "test-routine-1", "task-1",
            description="Updated description",
            agent_profile="research_agent",
            max_retries=5,
        )
        assert result["ok"] is True
        assert result["task"]["description"] == "Updated description"
        assert result["task"]["agent_profile"] == "research_agent"
        assert result["task"]["agent_profile_name"] == "Research Agent"
        assert result["task"]["max_retries"] == 5
        print("  ✓ update_task")
    finally:
        cleanup(tmpdir)


def test_update_task_partial():
    tmpdir = setup_test_env()
    try:
        # Only update description, leave other fields unchanged
        result = task_app.update_task(
            "test-routine-1", "task-1",
            description="Only desc changed",
        )
        assert result["ok"] is True
        assert result["task"]["description"] == "Only desc changed"
        assert result["task"]["agent_profile"] == "computron"  # unchanged
        assert result["task"]["instruction"] == "Do the first thing"  # unchanged
        print("  ✓ update_task (partial)")
    finally:
        cleanup(tmpdir)


def test_update_task_not_found():
    tmpdir = setup_test_env()
    try:
        result = task_app.update_task("test-routine-1", "nonexistent", description="x")
        assert "error" in result
        print("  ✓ update_task (not found)")
    finally:
        cleanup(tmpdir)


def test_delete_task():
    tmpdir = setup_test_env()
    try:
        # Delete task-1, which task-2 depends on
        result = task_app.delete_task("test-routine-1", "task-1")
        assert result["ok"] is True

        # Verify task is gone
        routine = task_app.get_routine("test-routine-1")
        assert len(routine["tasks"]) == 1
        assert routine["tasks"][0]["id"] == "task-2"

        # Verify depends_on was cleaned up
        assert routine["tasks"][0]["depends_on"] == []
        print("  ✓ delete_task (with dep cleanup)")
    finally:
        cleanup(tmpdir)


def test_delete_task_not_found():
    tmpdir = setup_test_env()
    try:
        result = task_app.delete_task("test-routine-1", "nonexistent")
        assert "error" in result
        print("  ✓ delete_task (not found)")
    finally:
        cleanup(tmpdir)


def test_reorder_tasks():
    tmpdir = setup_test_env()
    try:
        # Reverse the order
        result = task_app.reorder_tasks("test-routine-1", ["task-2", "task-1"])
        assert result["ok"] is True

        routine = task_app.get_routine("test-routine-1")
        assert routine["tasks"][0]["id"] == "task-2"
        assert routine["tasks"][1]["id"] == "task-1"
        print("  ✓ reorder_tasks")
    finally:
        cleanup(tmpdir)


def test_reorder_tasks_wrong_count():
    tmpdir = setup_test_env()
    try:
        result = task_app.reorder_tasks("test-routine-1", ["task-1"])
        assert "error" in result
        print("  ✓ reorder_tasks (wrong count)")
    finally:
        cleanup(tmpdir)


def test_reorder_tasks_bad_id():
    tmpdir = setup_test_env()
    try:
        result = task_app.reorder_tasks("test-routine-1", ["task-1", "bad-id"])
        assert "error" in result
        print("  ✓ reorder_tasks (bad ID)")
    finally:
        cleanup(tmpdir)


def test_list_profiles():
    tmpdir = setup_test_env()
    try:
        result = task_app.list_profiles()
        assert "profiles" in result
        assert len(result["profiles"]) == 3
        # Should be sorted by name
        names = [p["name"] for p in result["profiles"]]
        assert names == sorted(names, key=str.lower)
        print("  ✓ list_profiles")
    finally:
        cleanup(tmpdir)


def test_update_routine():
    tmpdir = setup_test_env()
    try:
        result = task_app.update_routine(
            "test-routine-1",
            description="Updated routine description",
            status="paused",
        )
        assert result["ok"] is True

        routine = task_app.get_routine("test-routine-1")
        assert routine["routine"]["description"] == "Updated routine description"
        assert routine["routine"]["status"] == "paused"
        print("  ✓ update_routine")
    finally:
        cleanup(tmpdir)


def test_atomic_write():
    """Verify that writes are atomic (no .tmp files left behind)."""
    tmpdir = setup_test_env()
    try:
        task_app.add_task("test-routine-1", "test", "test instruction")
        routines_dir = task_app._ROUTINES_DIR
        tmp_files = list(routines_dir.glob("*.tmp"))
        assert len(tmp_files) == 0, f"Found leftover .tmp files: {tmp_files}"
        print("  ✓ atomic_write (no .tmp files)")
    finally:
        cleanup(tmpdir)


if __name__ == "__main__":
    tests = [
        test_list_routines,
        test_get_routine,
        test_get_routine_not_found,
        test_add_task,
        test_add_task_validation,
        test_update_task,
        test_update_task_partial,
        test_update_task_not_found,
        test_delete_task,
        test_delete_task_not_found,
        test_reorder_tasks,
        test_reorder_tasks_wrong_count,
        test_reorder_tasks_bad_id,
        test_list_profiles,
        test_update_routine,
        test_atomic_write,
    ]

    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"  ✗ {test.__name__}: {e}")
            failed += 1

    print(f"\n{'='*40}")
    print(f"Results: {passed} passed, {failed} failed")
    sys.exit(1 if failed > 0 else 0)
