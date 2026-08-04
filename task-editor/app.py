"""Task Editor — Omnideck Custom App backend.

Provides actions for listing, creating, updating, deleting, and reordering
tasks within routines, plus listing agent profiles.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from custom_apps import action

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_BASE_DIR = Path("/var/lib/omnideck")
_ROUTINES_DIR = _BASE_DIR / "routines"
_PROFILES_DIR = _BASE_DIR / "agent_profiles"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def _routine_path(routine_id: str) -> Path:
    return _ROUTINES_DIR / f"{routine_id}.json"


def _new_id() -> str:
    return uuid.uuid4().hex


def _load_routine(routine_id: str) -> dict | None:
    return _read_json(_routine_path(routine_id))


def _save_routine(routine_id: str, data: dict) -> None:
    _write_json(_routine_path(routine_id), data)


def _load_profiles() -> list[dict]:
    profiles = []
    if not _PROFILES_DIR.exists():
        return profiles
    for p in sorted(_PROFILES_DIR.glob("*.json")):
        data = _read_json(p)
        if data:
            profiles.append(data)
    return profiles


def _profile_id_to_name() -> dict[str, str]:
    result = {}
    for p in _load_profiles():
        result[p.get("id", "")] = p.get("name", p.get("id", ""))
    return result


# ---------------------------------------------------------------------------
# Actions — Routines
# ---------------------------------------------------------------------------

@action
def list_routines() -> dict:
    """List all routines with summary info."""
    routines = []
    if not _ROUTINES_DIR.exists():
        return {"routines": []}
    for p in sorted(_ROUTINES_DIR.glob("*.json")):
        data = _read_json(p)
        if not data:
            continue
        task_count = len(data.get("tasks", []))
        routines.append({
            "id": data.get("id", ""),
            "description": data.get("description", ""),
            "status": data.get("status", "active"),
            "cron": data.get("cron"),
            "timezone": data.get("timezone", "UTC"),
            "created_at": data.get("created_at", ""),
            "last_run_spawned_at": data.get("last_run_spawned_at"),
            "task_count": task_count,
        })
    # Sort by created_at descending
    routines.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return {"routines": routines}


@action
def get_routine(routine_id: str) -> dict:
    """Get full routine detail including all tasks and agent profile names."""
    data = _load_routine(routine_id)
    if not data:
        return {"error": "Routine not found"}
    names = _profile_id_to_name()
    tasks = []
    for t in data.get("tasks", []):
        task = dict(t)
        pid = task.get("agent_profile")
        if pid:
            task["agent_profile_name"] = names.get(pid, pid)
        tasks.append(task)
    return {
        "routine": {
            "id": data.get("id", ""),
            "description": data.get("description", ""),
            "status": data.get("status", "active"),
            "cron": data.get("cron"),
            "timezone": data.get("timezone", "UTC"),
            "created_at": data.get("created_at", ""),
            "last_run_spawned_at": data.get("last_run_spawned_at"),
        },
        "tasks": tasks,
    }


@action
def update_routine(routine_id: str, description: str | None = None,
                   cron: str | None = None, timezone: str | None = None,
                   status: str | None = None) -> dict:
    """Update routine metadata. Pass None for fields to leave unchanged."""
    data = _load_routine(routine_id)
    if not data:
        return {"error": "Routine not found"}
    if description is not None:
        data["description"] = description
    if cron is not None:
        data["cron"] = cron if cron else None
    if timezone is not None:
        data["timezone"] = timezone
    if status is not None:
        data["status"] = status
    _save_routine(routine_id, data)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Actions — Tasks
# ---------------------------------------------------------------------------

@action
def add_task(routine_id: str, description: str, instruction: str,
             agent_profile: str = "", depends_on: list[str] | None = None,
             max_retries: int = 3) -> dict:
    """Add a new task to a routine. Tasks are appended to the end of the list."""
    data = _load_routine(routine_id)
    if not data:
        return {"error": "Routine not found"}
    if not description or not description.strip():
        return {"error": "Description is required"}
    if not instruction or not instruction.strip():
        return {"error": "Instruction is required"}

    task_id = _new_id()
    task = {
        "id": task_id,
        "routine_id": routine_id,
        "description": description.strip(),
        "instruction": instruction.strip(),
        "agent_profile": agent_profile if agent_profile else None,
        "depends_on": depends_on or [],
        "max_retries": max_retries,
    }
    data.setdefault("tasks", []).append(task)
    _save_routine(routine_id, data)

    names = _profile_id_to_name()
    if agent_profile:
        task["agent_profile_name"] = names.get(agent_profile, agent_profile)
    return {"ok": True, "task": task}


@action
def update_task(routine_id: str, task_id: str,
                description: str | None = None,
                instruction: str | None = None,
                agent_profile: str | None = None,
                depends_on: list[str] | None = None,
                max_retries: int | None = None) -> dict:
    """Update an existing task. Pass None for fields to leave unchanged."""
    data = _load_routine(routine_id)
    if not data:
        return {"error": "Routine not found"}

    for t in data.get("tasks", []):
        if t.get("id") == task_id:
            if description is not None:
                t["description"] = description.strip()
            if instruction is not None:
                t["instruction"] = instruction.strip()
            if agent_profile is not None:
                t["agent_profile"] = agent_profile if agent_profile else None
            if depends_on is not None:
                t["depends_on"] = depends_on
            if max_retries is not None:
                t["max_retries"] = max_retries
            _save_routine(routine_id, data)

            names = _profile_id_to_name()
            result = dict(t)
            pid = result.get("agent_profile")
            if pid:
                result["agent_profile_name"] = names.get(pid, pid)
            return {"ok": True, "task": result}

    return {"error": "Task not found"}


@action
def delete_task(routine_id: str, task_id: str) -> dict:
    """Remove a task from a routine. Also removes it from other tasks' depends_on."""
    data = _load_routine(routine_id)
    if not data:
        return {"error": "Routine not found"}

    tasks = data.get("tasks", [])
    new_tasks = [t for t in tasks if t.get("id") != task_id]
    if len(new_tasks) == len(tasks):
        return {"error": "Task not found"}

    # Remove deleted task ID from any depends_on lists
    for t in new_tasks:
        t["depends_on"] = [d for d in t.get("depends_on", []) if d != task_id]

    data["tasks"] = new_tasks
    _save_routine(routine_id, data)
    return {"ok": True}


@action
def reorder_tasks(routine_id: str, task_ids: list[str]) -> dict:
    """Reorder tasks within a routine. Pass an ordered list of task IDs."""
    data = _load_routine(routine_id)
    if not data:
        return {"error": "Routine not found"}

    tasks = data.get("tasks", [])
    task_map = {t.get("id"): t for t in tasks}

    # Validate all IDs are present
    for tid in task_ids:
        if tid not in task_map:
            return {"error": f"Task ID {tid} not found in routine"}

    # Validate we have all tasks
    if len(task_ids) != len(tasks):
        return {"error": f"Expected {len(tasks)} task IDs, got {len(task_ids)}"}

    # Reorder
    data["tasks"] = [task_map[tid] for tid in task_ids]
    _save_routine(routine_id, data)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Actions — Agent Profiles
# ---------------------------------------------------------------------------

@action
def list_profiles() -> dict:
    """List all available agent profiles."""
    profiles = _load_profiles()
    result = []
    for p in profiles:
        result.append({
            "id": p.get("id", ""),
            "name": p.get("name", p.get("id", "")),
            "description": p.get("description", ""),
            "model": p.get("model", ""),
            "enabled": p.get("enabled", True),
        })
    # Sort by name
    result.sort(key=lambda p: p["name"].lower())
    return {"profiles": result}
