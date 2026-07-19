"""Backend actions for the Omnideck Projects Custom App.

The app treats projects as virtual collections. It reads Omnideck's existing
conversation and artifact stores, but writes its own organization state only
to ``data/projects.sqlite3`` beside this file.
"""

from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
from datetime import UTC, datetime
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
from typing import Any, Iterator
from uuid import uuid4

from custom_apps import action


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
DATABASE_PATH = DATA_DIR / "projects.sqlite3"

MAX_LIST_RESULTS = 500
MAX_SCAN_FILES = 40_000
MAX_DUPLICATE_HASHES = 200
MAX_DUPLICATE_HASH_BYTES = 1024 * 1024 * 1024
LARGE_FILE_BYTES = 25 * 1024 * 1024
STALE_FILE_DAYS = 180
PROJECT_COLORS = {
    "#5b6cf9",
    "#8b5cf6",
    "#d946ef",
    "#ef476f",
    "#f59e0b",
    "#10b981",
    "#06b6d4",
    "#3b82f6",
}
ITEM_TYPES = {"conversation", "artifact", "file", "folder"}
STORAGE_IGNORED_DIR_NAMES = {
    ".cache",
    ".git",
    ".local",
    ".npm",
    ".playwright-browsers",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "node_modules",
    "venv",
}
STORAGE_IGNORED_TOP_LEVEL = {"apps", "go", "node_modules", "omnideck-custom-apps"}
INBOX_IGNORED_NAMES = {"apps", "omnideck-custom-apps", "node_modules"}
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$")


def _discover_runtime_roots() -> tuple[Path, Path]:
    """Locate Omnideck state and user-file roots without hardcoding this app."""
    try:
        from config import load_config

        config = load_config()
        return (
            Path(config.settings.home_dir).expanduser().resolve(),
            Path(config.virtual_computer.home_dir).expanduser().resolve(),
        )
    except Exception:
        # This fallback makes direct local development possible. The normal
        # Custom App runner has Omnideck's installed ``config`` package.
        local_state = Path.home() / ".omnideck" / "state"
        local_files = Path.home() / ".omnideck" / "home"
        state_root = local_state if local_state.is_dir() else Path("/var/lib/omnideck")
        files_root = local_files if local_files.is_dir() else Path.home()
        return state_root.resolve(), files_root.resolve()


STATE_ROOT, FILES_ROOT = _discover_runtime_roots()


@contextmanager
def _database() -> Iterator[sqlite3.Connection]:
    """Open the app-owned database and ensure its schema exists."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '#5b6cf9',
            tags_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_items (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            item_type TEXT NOT NULL CHECK (
                item_type IN ('conversation', 'artifact', 'file', 'folder')
            ),
            item_id TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            added_at TEXT NOT NULL,
            PRIMARY KEY (project_id, item_type, item_id)
        );

        CREATE INDEX IF NOT EXISTS project_items_reference_idx
            ON project_items(item_type, item_id);

        CREATE TABLE IF NOT EXISTS scan_cache (
            cache_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _clamp_limit(limit: int) -> int:
    try:
        return max(1, min(int(limit), MAX_LIST_RESULTS))
    except (TypeError, ValueError):
        return 200


def _normalize_name(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Project name must be text.")
    name = " ".join(value.split()).strip()
    if not name:
        raise ValueError("Project name cannot be empty.")
    if len(name) > 80:
        raise ValueError("Project name must be 80 characters or fewer.")
    return name


def _normalize_description(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Description must be text.")
    description = value.strip()
    if len(description) > 500:
        raise ValueError("Description must be 500 characters or fewer.")
    return description


def _normalize_tags(values: list[str] | None) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError("Tags must be a list.")
    tags: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            raise ValueError("Each tag must be text.")
        tag = " ".join(raw.split()).strip()
        if not tag:
            continue
        if len(tag) > 24:
            raise ValueError("Tags must be 24 characters or fewer.")
        folded = tag.casefold()
        if folded not in seen:
            seen.add(folded)
            tags.append(tag)
        if len(tags) > 8:
            raise ValueError("A project can have at most 8 tags.")
    return tags


def _normalize_color(value: str) -> str:
    return value if value in PROJECT_COLORS else "#5b6cf9"


def _row_to_project(
    row: sqlite3.Row, counts: dict[str, dict[str, int]] | None = None
) -> dict:
    try:
        tags = json.loads(row["tags_json"])
    except (json.JSONDecodeError, TypeError):
        tags = []
    project = {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "color": row["color"],
        "tags": tags if isinstance(tags, list) else [],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    project["counts"] = (counts or {}).get(
        row["id"],
        {"total": 0, "conversation": 0, "artifact": 0, "file": 0, "folder": 0},
    )
    return project


def _project_counts(connection: sqlite3.Connection) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for row in connection.execute(
        "SELECT project_id, item_type, COUNT(*) AS count FROM project_items "
        "GROUP BY project_id, item_type"
    ):
        bucket = counts.setdefault(
            row["project_id"],
            {"total": 0, "conversation": 0, "artifact": 0, "file": 0, "folder": 0},
        )
        bucket[row["item_type"]] = row["count"]
        bucket["total"] += row["count"]
    return counts


def _all_projects(connection: sqlite3.Connection) -> list[dict]:
    counts = _project_counts(connection)
    rows = connection.execute(
        "SELECT * FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE"
    ).fetchall()
    return [_row_to_project(row, counts) for row in rows]


def _project_or_error(connection: sqlite3.Connection, project_id: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    if row is None:
        raise ValueError("Project not found.")
    return row


def _assignment_map(item_type: str | None = None) -> dict[tuple[str, str], list[dict]]:
    with _database() as connection:
        query = (
            "SELECT pi.item_type, pi.item_id, pi.note, pi.added_at, "
            "p.id AS project_id, p.name AS project_name, p.color AS project_color "
            "FROM project_items pi JOIN projects p ON p.id = pi.project_id"
        )
        args: tuple[Any, ...] = ()
        if item_type:
            query += " WHERE pi.item_type = ?"
            args = (item_type,)
        query += " ORDER BY p.name COLLATE NOCASE"
        rows = connection.execute(query, args).fetchall()
    assignments: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        assignments[(row["item_type"], row["item_id"])].append(
            {
                "id": row["project_id"],
                "name": row["project_name"],
                "color": row["project_color"],
                "note": row["note"],
                "added_at": row["added_at"],
            }
        )
    return dict(assignments)


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}


def _directory_size(path: Path, max_files: int = 20_000) -> tuple[int, int, bool]:
    total = 0
    file_count = 0
    complete = True
    try:
        for root, dirs, files in os.walk(path, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(root) / name).is_symlink()]
            for name in files:
                if file_count >= max_files:
                    return total, file_count, False
                file_path = Path(root) / name
                try:
                    if not file_path.is_symlink():
                        total += file_path.stat().st_size
                        file_count += 1
                except OSError:
                    complete = False
    except OSError:
        complete = False
    return total, file_count, complete


def _pretty_path(path: Path) -> str:
    try:
        relative = path.relative_to(FILES_ROOT)
        return "~" if not relative.parts else f"~/{relative.as_posix()}"
    except ValueError:
        return str(path)


def _safe_user_path(raw_path: str, *, must_exist: bool = True) -> Path:
    if not isinstance(raw_path, str):
        raise ValueError("Path must be text.")
    candidate = FILES_ROOT if not raw_path else Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = FILES_ROOT / candidate
    try:
        resolved = candidate.resolve(strict=must_exist)
    except (OSError, RuntimeError) as exc:
        raise ValueError("That path is not available.") from exc
    try:
        resolved.relative_to(FILES_ROOT)
    except ValueError as exc:
        raise ValueError(
            "Paths must stay inside the Omnideck user-files directory."
        ) from exc
    return resolved


def _conversation_roots() -> list[tuple[Path, bool]]:
    root = STATE_ROOT / "conversations"
    return [(root, False), (root / "_archived", True)]


def _conversation_dir(conversation_id: str) -> tuple[Path, bool] | None:
    if not isinstance(conversation_id, str) or not SAFE_ID.fullmatch(conversation_id):
        return None
    for root, archived in _conversation_roots():
        candidate = root / conversation_id
        if (candidate / "events.jsonl").is_file():
            return candidate, archived
    return None


def _conversation_summary(path: Path, archived: bool) -> dict | None:
    events_path = path / "events.jsonl"
    if not events_path.is_file():
        return None
    first_message = ""
    first_timestamp = ""
    last_timestamp = ""
    turn_count = 0
    event_count = 0
    agents: set[str] = set()
    try:
        with events_path.open(encoding="utf-8") as handle:
            for raw_line in handle:
                if not raw_line.strip():
                    continue
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                event_count += 1
                raw_timestamp = event.get("timestamp")
                timestamp = raw_timestamp if isinstance(raw_timestamp, str) else ""
                if timestamp and not first_timestamp:
                    first_timestamp = timestamp
                if timestamp:
                    last_timestamp = timestamp
                agent_name = event.get("agent_name")
                if isinstance(agent_name, str) and agent_name:
                    agents.add(agent_name)
                if event.get("type") != "user_message":
                    continue
                depth = event.get("depth")
                raw_agent_id = event.get("agent_id")
                agent_id = raw_agent_id if isinstance(raw_agent_id, str) else ""
                is_root = (
                    depth == 0 if isinstance(depth, int) else agent_id.count(".") == 2
                )
                if not is_root:
                    continue
                turn_count += 1
                if not first_message:
                    content = event.get("content")
                    if isinstance(content, str):
                        first_message = " ".join(content.split())
    except (OSError, UnicodeDecodeError):
        return None

    metadata = _read_json(path / "metadata.json")
    title = metadata.get("title") if isinstance(metadata.get("title"), str) else ""
    if not title:
        title = first_message[:80] or "Untitled conversation"
    size, file_count, size_complete = _directory_size(path)
    try:
        fallback_time = datetime.fromtimestamp(
            events_path.stat().st_mtime, tz=UTC
        ).isoformat()
    except OSError:
        fallback_time = ""
    started_at = first_timestamp or fallback_time
    last_activity = last_timestamp or fallback_time
    return {
        "type": "conversation",
        "id": path.name,
        "title": title[:120],
        "first_message": first_message[:240],
        "started_at": started_at,
        "last_activity": last_activity,
        "turn_count": turn_count,
        "event_count": event_count,
        "size": size,
        "file_count": file_count,
        "size_complete": size_complete,
        "archived": archived,
        "pinned": bool(metadata.get("pinned", False)),
        "folder_id": metadata.get("folder_id") or None,
        "profile_id": metadata.get("profile_id") or None,
        "agents": sorted(agents),
    }


def _conversation_storage_details(path: Path, max_files: int = 500) -> dict:
    """Describe the files that make up one conversation without reading them."""
    category_labels = {
        "events": "Event history",
        "metadata": "Conversation metadata",
        "browser": "Browser state",
        "terminal": "Terminal state",
        "scratchpad": "Scratchpad",
        "other": "Other sidecars",
    }
    known_categories = {
        "events.jsonl": "events",
        "metadata.json": "metadata",
        "browser_tabs.json": "browser",
        "terminal.json": "terminal",
        "scratchpad.json": "scratchpad",
    }
    files: list[dict] = []
    category_totals: dict[str, dict[str, int]] = defaultdict(
        lambda: {"size": 0, "file_count": 0}
    )
    complete = True
    try:
        for root, dirs, names in os.walk(path, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(root) / name).is_symlink()]
            for name in names:
                if len(files) >= max_files:
                    complete = False
                    break
                file_path = Path(root) / name
                try:
                    if file_path.is_symlink():
                        continue
                    size = file_path.stat().st_size
                    relative_path = file_path.relative_to(path).as_posix()
                except (OSError, ValueError):
                    complete = False
                    continue
                category = known_categories.get(name, "other")
                category_totals[category]["size"] += size
                category_totals[category]["file_count"] += 1
                files.append(
                    {
                        "name": name,
                        "relative_path": relative_path,
                        "size": size,
                        "category": category,
                    }
                )
            if len(files) >= max_files:
                break
    except OSError:
        complete = False

    total = sum(item["size"] for item in files)
    categories = [
        {
            "key": key,
            "label": category_labels[key],
            "size": values["size"],
            "file_count": values["file_count"],
            "percent": round(values["size"] * 100 / total, 1) if total else 0,
        }
        for key, values in category_totals.items()
    ]
    categories.sort(key=lambda item: item["size"], reverse=True)
    files.sort(key=lambda item: item["size"], reverse=True)
    return {
        "total": total,
        "file_count": len(files),
        "complete": complete,
        "categories": categories,
        "files": files,
    }


def _conversation_agent_details(path: Path) -> dict:
    """Summarize explicitly spawned agents without interpreting root-agent turns."""
    agents: dict[str, dict] = {}
    events_path = path / "events.jsonl"
    try:
        handle = events_path.open(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return {
            "agents": [],
            "spawned_count": 0,
            "totals": {"turns": 0, "tool_results": 0, "outputs": 0},
        }

    with handle:
        for raw_line in handle:
            if not raw_line.strip():
                continue
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            event_type = event.get("type") if isinstance(event.get("type"), str) else ""
            raw_agent_id = event.get("agent_id")
            if not isinstance(raw_agent_id, str) or not raw_agent_id:
                continue
            depth = event.get("depth") if isinstance(event.get("depth"), int) else None
            agent = agents.setdefault(
                raw_agent_id,
                {
                    "id": raw_agent_id,
                    "name": "",
                    "spawned": bool(isinstance(depth, int) and depth > 0),
                    "status": "",
                    "started_at": "",
                    "completed_at": "",
                    "turn_count": 0,
                    "tool_result_count": 0,
                    "output_count": 0,
                },
            )
            if isinstance(depth, int) and depth > 0:
                agent["spawned"] = True
            timestamp = event.get("timestamp")
            name = event.get("agent_name")
            if isinstance(name, str) and name:
                agent["name"] = name
            if event_type == "iteration":
                agent["turn_count"] += 1
            elif event_type == "tool_result":
                agent["tool_result_count"] += 1
            elif event_type == "file_output":
                agent["output_count"] += 1
            elif event_type == "agent_started":
                agent["started_at"] = timestamp if isinstance(timestamp, str) else ""
                parent = event.get("parent_agent_id")
                if isinstance(parent, str) and parent:
                    agent["spawned"] = True
            elif event_type == "agent_completed":
                agent["completed_at"] = timestamp if isinstance(timestamp, str) else ""
                status = event.get("status")
                if isinstance(status, str):
                    agent["status"] = status

    result = [agent for agent in agents.values() if agent["spawned"]]
    for agent in result:
        if not agent["name"]:
            agent["name"] = "Spawned agent"
    result.sort(key=lambda item: (item["started_at"], item["id"]))
    return {
        "agents": result,
        "spawned_count": len(result),
        "totals": {
            "turns": sum(item["turn_count"] for item in result),
            "tool_results": sum(item["tool_result_count"] for item in result),
            "outputs": sum(item["output_count"] for item in result),
        },
    }


def _scan_conversations() -> list[dict]:
    conversations: list[dict] = []
    for root, archived in _conversation_roots():
        if not root.is_dir():
            continue
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() or entry.name == "_archived":
                continue
            try:
                summary = _conversation_summary(entry, archived)
            except Exception:
                # One partially written or corrupted conversation should not
                # prevent the rest of the library from loading.
                continue
            if summary:
                conversations.append(summary)
    conversations.sort(key=lambda item: item["last_activity"], reverse=True)
    return conversations


def _load_artifact_index() -> list[dict]:
    raw = _read_json(STATE_ROOT / "artifacts" / "index.json")
    entries = raw.get("artifacts", {})
    if isinstance(entries, dict):
        values = list(entries.values())
    elif isinstance(entries, list):
        values = entries
    else:
        values = []
    return [entry for entry in values if isinstance(entry, dict)]


def _artifact_path(raw_path: Any) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path:
        return None
    path = Path(raw_path)
    if not path.is_absolute():
        path = FILES_ROOT / path
    try:
        resolved = path.resolve(strict=False)
        resolved.relative_to(FILES_ROOT)
        return resolved
    except (OSError, RuntimeError, ValueError):
        return None


def _scan_artifacts(conversations: list[dict] | None = None) -> list[dict]:
    conversations = (
        conversations if conversations is not None else _scan_conversations()
    )
    conversation_titles = {item["id"]: item["title"] for item in conversations}
    artifacts: list[dict] = []
    for entry in _load_artifact_index():
        artifact_id = entry.get("id")
        if not isinstance(artifact_id, str) or not artifact_id:
            continue
        path = _artifact_path(entry.get("path"))
        present = bool(path and path.is_file())
        try:
            stat = path.stat() if present and path else None
        except OSError:
            stat = None
            present = False
        filename = entry.get("filename")
        if not isinstance(filename, str) or not filename:
            filename = path.name if path else "Unknown artifact"
        conversation_id = entry.get("conversation_id")
        conversation_id = conversation_id if isinstance(conversation_id, str) else ""
        artifacts.append(
            {
                "type": "artifact",
                "id": artifact_id,
                "title": filename,
                "filename": filename,
                "path": str(path) if path else str(entry.get("path") or ""),
                "display_path": _pretty_path(path)
                if path
                else str(entry.get("path") or ""),
                "content_type": entry.get("content_type")
                or mimetypes.guess_type(filename)[0]
                or "application/octet-stream",
                "agent_name": entry.get("agent_name") or None,
                "conversation_id": conversation_id,
                "conversation_title": conversation_titles.get(conversation_id),
                "orphaned": bool(
                    conversation_id and conversation_id not in conversation_titles
                ),
                "created_at": entry.get("created_at")
                if isinstance(entry.get("created_at"), str)
                else "",
                "updated_at": entry.get("updated_at")
                if isinstance(entry.get("updated_at"), str)
                else "",
                "status": "present" if present else "missing",
                "size": stat.st_size if stat else 0,
                "modified": stat.st_mtime if stat else None,
            }
        )
    artifacts.sort(key=lambda item: item["updated_at"], reverse=True)
    return artifacts


def _attach_artifact_stats(conversations: list[dict], artifacts: list[dict]) -> None:
    stats: dict[str, dict[str, int]] = defaultdict(
        lambda: {"count": 0, "present": 0, "missing": 0, "bytes": 0}
    )
    for artifact in artifacts:
        conversation_id = artifact.get("conversation_id")
        if not conversation_id:
            continue
        bucket = stats[conversation_id]
        bucket["count"] += 1
        if artifact["status"] == "present":
            bucket["present"] += 1
            bucket["bytes"] += artifact["size"]
        else:
            bucket["missing"] += 1
    for conversation in conversations:
        bucket = stats[conversation["id"]]
        conversation["artifact_count"] = bucket["count"]
        conversation["present_artifact_count"] = bucket["present"]
        conversation["missing_artifact_count"] = bucket["missing"]
        conversation["artifact_bytes"] = bucket["bytes"]
        conversation["total_size"] = conversation.get("size", 0) + bucket["bytes"]


def _file_item(
    path: Path, item_type: str | None = None, *, include_folder_size: bool = False
) -> dict:
    exists = path.exists()
    inferred_type = item_type or ("folder" if exists and path.is_dir() else "file")
    try:
        stat = path.stat() if exists else None
    except OSError:
        stat = None
        exists = False
    size = stat.st_size if stat and inferred_type == "file" else 0
    file_count = 1 if inferred_type == "file" and exists else 0
    size_complete = inferred_type != "folder"
    if exists and inferred_type == "folder" and include_folder_size:
        size, file_count, size_complete = _directory_size(path)
    return {
        "type": inferred_type,
        "id": str(path),
        "title": path.name or str(path),
        "path": str(path),
        "display_path": _pretty_path(path),
        "status": "present" if exists else "missing",
        "size": size,
        "file_count": file_count,
        "size_complete": size_complete,
        "modified": stat.st_mtime if stat else None,
    }


def _matches_query(item: dict, query: str) -> bool:
    if not query:
        return True
    needle = query.casefold()
    fields = (
        item.get("title"),
        item.get("first_message"),
        item.get("display_path"),
        item.get("content_type"),
        item.get("conversation_title"),
    )
    return any(needle in str(value).casefold() for value in fields if value)


def _attach_assignments(
    items: list[dict], item_type: str, assignments: dict | None = None
) -> None:
    assignments = assignments if assignments is not None else _assignment_map(item_type)
    for item in items:
        item["projects"] = assignments.get((item_type, item["id"]), [])


def _filter_assignment(items: list[dict], assignment: str) -> list[dict]:
    if assignment == "unassigned":
        return [item for item in items if not item.get("projects")]
    if assignment.startswith("project:"):
        project_id = assignment.split(":", 1)[1]
        return [
            item
            for item in items
            if any(project["id"] == project_id for project in item.get("projects", []))
        ]
    return items


def _validate_reference(item_type: str, item_id: str) -> str:
    if item_type not in ITEM_TYPES:
        raise ValueError("Unsupported item type.")
    if not isinstance(item_id, str) or not item_id:
        raise ValueError("Item reference is missing.")
    if item_type == "conversation":
        if _conversation_dir(item_id) is None:
            raise ValueError("Conversation not found.")
        return item_id
    if item_type == "artifact":
        if not any(entry.get("id") == item_id for entry in _load_artifact_index()):
            raise ValueError("Artifact not found.")
        return item_id
    path = _safe_user_path(item_id)
    if item_type == "file" and not path.is_file():
        raise ValueError("The selected item is not a file.")
    if item_type == "folder" and not path.is_dir():
        raise ValueError("The selected item is not a folder.")
    return str(path)


def _cache_get(cache_key: str) -> dict | None:
    with _database() as connection:
        row = connection.execute(
            "SELECT payload_json, updated_at FROM scan_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(row["payload_json"])
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    payload["cached_at"] = row["updated_at"]
    return payload


def _cache_set(cache_key: str, payload: dict) -> None:
    updated_at = _now()
    with _database() as connection:
        connection.execute(
            "INSERT INTO scan_cache(cache_key, payload_json, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, "
            "updated_at = excluded.updated_at",
            (cache_key, json.dumps(payload, ensure_ascii=False), updated_at),
        )


@action
def list_projects() -> dict:
    """Return every virtual project and its item counts."""
    with _database() as connection:
        return {"projects": _all_projects(connection)}


@action
def create_project(
    name: str,
    description: str = "",
    color: str = "#5b6cf9",
    tags: list[str] | None = None,
) -> dict:
    """Create an app-owned virtual project."""
    try:
        now = _now()
        project_id = uuid4().hex
        values = (
            project_id,
            _normalize_name(name),
            _normalize_description(description),
            _normalize_color(color),
            json.dumps(_normalize_tags(tags)),
            now,
            now,
        )
        with _database() as connection:
            connection.execute(
                "INSERT INTO projects(id, name, description, color, tags_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                values,
            )
            row = _project_or_error(connection, project_id)
            return {"success": True, "project": _row_to_project(row)}
    except ValueError as exc:
        return {"error": str(exc)}


@action
def update_project(
    project_id: str,
    name: str,
    description: str = "",
    color: str = "#5b6cf9",
    tags: list[str] | None = None,
) -> dict:
    """Update an app-owned project's display information."""
    try:
        with _database() as connection:
            _project_or_error(connection, project_id)
            connection.execute(
                "UPDATE projects SET name = ?, description = ?, color = ?, tags_json = ?, "
                "updated_at = ? WHERE id = ?",
                (
                    _normalize_name(name),
                    _normalize_description(description),
                    _normalize_color(color),
                    json.dumps(_normalize_tags(tags)),
                    _now(),
                    project_id,
                ),
            )
            row = _project_or_error(connection, project_id)
            return {
                "success": True,
                "project": _row_to_project(row, _project_counts(connection)),
            }
    except ValueError as exc:
        return {"error": str(exc)}


@action
def delete_project(project_id: str) -> dict:
    """Delete only a virtual project; source files and Omnideck data are untouched."""
    try:
        with _database() as connection:
            project = _project_or_error(connection, project_id)
            item_count = connection.execute(
                "SELECT COUNT(*) FROM project_items WHERE project_id = ?", (project_id,)
            ).fetchone()[0]
            connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return {
            "success": True,
            "deleted_project": project["name"],
            "removed_assignments": item_count,
            "source_data_changed": False,
        }
    except ValueError as exc:
        return {"error": str(exc)}


@action
def assign_items(project_id: str, items: list[dict]) -> dict:
    """Add conversation, artifact, file, or folder references to a project."""
    try:
        if not isinstance(items, list) or not items:
            raise ValueError("Select at least one item.")
        if len(items) > 200:
            raise ValueError("No more than 200 items can be added at once.")
        validated: list[tuple[str, str]] = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("Each item must be an object.")
            item_type = item.get("type")
            item_id = item.get("id")
            validated.append((item_type, _validate_reference(item_type, item_id)))
        added = 0
        now = _now()
        with _database() as connection:
            _project_or_error(connection, project_id)
            for item_type, item_id in validated:
                cursor = connection.execute(
                    "INSERT OR IGNORE INTO project_items"
                    "(project_id, item_type, item_id, note, added_at) VALUES (?, ?, ?, '', ?)",
                    (project_id, item_type, item_id, now),
                )
                added += cursor.rowcount
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id)
            )
        return {
            "success": True,
            "added": added,
            "already_present": len(validated) - added,
        }
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}


@action
def assign_conversation_bundle(project_id: str, conversation_id: str) -> dict:
    """Add a conversation and every artifact indexed to it in one transaction."""
    try:
        conversation_id = _validate_reference("conversation", conversation_id)
        artifact_ids: list[str] = []
        seen: set[str] = set()
        for entry in _load_artifact_index():
            artifact_id = entry.get("id")
            if (
                entry.get("conversation_id") == conversation_id
                and isinstance(artifact_id, str)
                and artifact_id
                and artifact_id not in seen
            ):
                seen.add(artifact_id)
                artifact_ids.append(artifact_id)

        references = [
            ("conversation", conversation_id),
            *(("artifact", artifact_id) for artifact_id in artifact_ids),
        ]
        now = _now()
        added_by_type = {"conversation": 0, "artifact": 0}
        with _database() as connection:
            _project_or_error(connection, project_id)
            for item_type, item_id in references:
                cursor = connection.execute(
                    "INSERT OR IGNORE INTO project_items"
                    "(project_id, item_type, item_id, note, added_at) "
                    "VALUES (?, ?, ?, '', ?)",
                    (project_id, item_type, item_id, now),
                )
                added_by_type[item_type] += cursor.rowcount
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id)
            )
        added = added_by_type["conversation"] + added_by_type["artifact"]
        return {
            "success": True,
            "added": added,
            "conversation_added": bool(added_by_type["conversation"]),
            "artifacts_added": added_by_type["artifact"],
            "artifact_total": len(artifact_ids),
            "already_present": len(references) - added,
            "source_data_changed": False,
        }
    except (TypeError, ValueError) as exc:
        return {"error": str(exc)}


@action
def remove_project_item(project_id: str, item_type: str, item_id: str) -> dict:
    """Remove a virtual assignment without changing the referenced source item."""
    try:
        if item_type not in ITEM_TYPES:
            raise ValueError("Unsupported item type.")
        with _database() as connection:
            _project_or_error(connection, project_id)
            cursor = connection.execute(
                "DELETE FROM project_items WHERE project_id = ? AND item_type = ? AND item_id = ?",
                (project_id, item_type, item_id),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE id = ?", (_now(), project_id)
            )
        return {
            "success": True,
            "removed": cursor.rowcount,
            "source_data_changed": False,
        }
    except ValueError as exc:
        return {"error": str(exc)}


@action
def update_item_note(
    project_id: str, item_type: str, item_id: str, note: str = ""
) -> dict:
    """Save a project-specific note for one reference."""
    try:
        if not isinstance(note, str) or len(note.strip()) > 1000:
            raise ValueError("Notes must be 1,000 characters or fewer.")
        with _database() as connection:
            _project_or_error(connection, project_id)
            cursor = connection.execute(
                "UPDATE project_items SET note = ? WHERE project_id = ? "
                "AND item_type = ? AND item_id = ?",
                (note.strip(), project_id, item_type, item_id),
            )
            if cursor.rowcount == 0:
                raise ValueError("That item is not in this project.")
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE id = ?", (_now(), project_id)
            )
        return {"success": True, "note": note.strip()}
    except ValueError as exc:
        return {"error": str(exc)}


@action
def list_conversations(
    query: str = "",
    assignment: str = "all",
    archive: str = "all",
    artifact_filter: str = "all",
    sort: str = "activity",
    limit: int = 250,
) -> dict:
    """List active and archived conversations with storage metadata."""
    conversations = _scan_conversations()
    _attach_artifact_stats(conversations, _scan_artifacts(conversations))
    assignments = _assignment_map("conversation")
    _attach_assignments(conversations, "conversation", assignments)
    if archive == "active":
        conversations = [item for item in conversations if not item["archived"]]
    elif archive == "archived":
        conversations = [item for item in conversations if item["archived"]]
    if artifact_filter == "with":
        conversations = [item for item in conversations if item["artifact_count"] > 0]
    elif artifact_filter == "without":
        conversations = [item for item in conversations if item["artifact_count"] == 0]
    elif artifact_filter == "missing":
        conversations = [
            item for item in conversations if item["missing_artifact_count"] > 0
        ]
    conversations = _filter_assignment(conversations, assignment)
    conversations = [
        item for item in conversations if _matches_query(item, query.strip())
    ]
    if sort == "total_size":
        conversations.sort(
            key=lambda item: (item["total_size"], item["last_activity"]),
            reverse=True,
        )
    total = len(conversations)
    conversations = conversations[: _clamp_limit(limit)]
    return {
        "conversations": conversations,
        "total": total,
        "returned": len(conversations),
    }


@action
def get_conversation_details(conversation_id: str) -> dict:
    """Return a lazy-loaded storage, artifact, and agent view for one chat."""
    located = _conversation_dir(conversation_id)
    if located is None:
        return {"error": "Conversation not found."}
    path, archived = located
    conversation = _conversation_summary(path, archived)
    if conversation is None:
        return {"error": "Conversation metadata could not be read."}

    conversations = _scan_conversations()
    artifacts = [
        item
        for item in _scan_artifacts(conversations)
        if item["conversation_id"] == conversation_id
    ]
    assignments = _assignment_map()
    _attach_assignments([conversation], "conversation", assignments)
    _attach_assignments(artifacts, "artifact", assignments)
    _attach_artifact_stats([conversation], artifacts)
    storage = _conversation_storage_details(path)
    agent_activity = _conversation_agent_details(path)
    present_artifacts = [item for item in artifacts if item["status"] == "present"]
    artifact_summary = {
        "count": len(artifacts),
        "present_count": len(present_artifacts),
        "missing_count": len(artifacts) - len(present_artifacts),
        "bytes": sum(item["size"] for item in present_artifacts),
    }
    return {
        "conversation": conversation,
        "storage": storage,
        "agent_activity": agent_activity,
        "artifact_summary": artifact_summary,
        "artifacts": artifacts,
        "related_bytes": storage["total"] + artifact_summary["bytes"],
    }


@action
def list_artifacts(
    query: str = "", assignment: str = "all", status: str = "all", limit: int = 250
) -> dict:
    """List indexed artifacts with live file and conversation status."""
    conversations = _scan_conversations()
    artifacts = _scan_artifacts(conversations)
    assignments = _assignment_map("artifact")
    _attach_assignments(artifacts, "artifact", assignments)
    if status in {"present", "missing"}:
        artifacts = [item for item in artifacts if item["status"] == status]
    elif status == "orphaned":
        artifacts = [item for item in artifacts if item["orphaned"]]
    artifacts = _filter_assignment(artifacts, assignment)
    artifacts = [item for item in artifacts if _matches_query(item, query.strip())]
    total = len(artifacts)
    artifacts = artifacts[: _clamp_limit(limit)]
    return {"artifacts": artifacts, "total": total, "returned": len(artifacts)}


@action
def browse_files(path: str = "", query: str = "", show_hidden: bool = False) -> dict:
    """Browse direct children of a folder inside Omnideck's user-files root."""
    try:
        folder = _safe_user_path(path)
        if not folder.is_dir():
            raise ValueError("That path is not a folder.")
        assignments = _assignment_map()
        items: list[dict] = []
        try:
            entries = list(folder.iterdir())
        except OSError as exc:
            raise ValueError("That folder could not be read.") from exc
        for entry in entries:
            if not show_hidden and entry.name.startswith("."):
                continue
            try:
                resolved = _safe_user_path(str(entry))
                item_type = "folder" if resolved.is_dir() else "file"
                item = _file_item(resolved, item_type)
                item["projects"] = assignments.get((item_type, item["id"]), [])
                if _matches_query(item, query.strip()):
                    items.append(item)
            except (OSError, ValueError):
                continue
        items.sort(
            key=lambda item: (item["type"] != "folder", item["title"].casefold())
        )
        parent = None
        if folder != FILES_ROOT:
            parent = str(folder.parent)
        return {
            "path": str(folder),
            "display_path": _pretty_path(folder),
            "parent": parent,
            "items": items[:MAX_LIST_RESULTS],
            "total": len(items),
            "home": str(FILES_ROOT),
            "show_hidden": bool(show_hidden),
        }
    except ValueError as exc:
        return {"error": str(exc)}


@action
def get_inbox(query: str = "") -> dict:
    """Return unassigned conversations, artifacts, and recent top-level files."""
    needle = query.strip()
    assignments = _assignment_map()
    conversations = _scan_conversations()
    artifacts = _scan_artifacts(conversations)
    _attach_artifact_stats(conversations, artifacts)
    _attach_assignments(conversations, "conversation", assignments)
    conversations = [
        item
        for item in conversations
        if not item["projects"] and _matches_query(item, needle)
    ][:40]
    _attach_assignments(artifacts, "artifact", assignments)
    artifacts = [
        item
        for item in artifacts
        if not item["projects"] and _matches_query(item, needle)
    ][:40]

    files: list[dict] = []
    try:
        entries = list(FILES_ROOT.iterdir())
    except OSError:
        entries = []
    for entry in entries:
        if entry.name.startswith(".") or entry.name in INBOX_IGNORED_NAMES:
            continue
        try:
            resolved = _safe_user_path(str(entry))
            item_type = "folder" if resolved.is_dir() else "file"
            item = _file_item(resolved, item_type)
            item["projects"] = assignments.get((item_type, item["id"]), [])
            if not item["projects"] and _matches_query(item, needle):
                files.append(item)
        except (OSError, ValueError):
            continue
    files.sort(key=lambda item: item.get("modified") or 0, reverse=True)
    return {
        "conversations": conversations,
        "artifacts": artifacts,
        "files": files[:40],
        "counts": {
            "conversations": len(conversations),
            "artifacts": len(artifacts),
            "files": min(len(files), 40),
        },
    }


@action
def get_project_items(project_id: str, query: str = "") -> dict:
    """Hydrate every reference in one project, including missing references."""
    try:
        with _database() as connection:
            project_row = _project_or_error(connection, project_id)
            project = _row_to_project(project_row, _project_counts(connection))
            reference_rows = connection.execute(
                "SELECT item_type, item_id, note, added_at FROM project_items "
                "WHERE project_id = ? ORDER BY added_at DESC",
                (project_id,),
            ).fetchall()
        conversations = {item["id"]: item for item in _scan_conversations()}
        artifacts = {
            item["id"]: item for item in _scan_artifacts(list(conversations.values()))
        }
        _attach_artifact_stats(list(conversations.values()), list(artifacts.values()))
        items: list[dict] = []
        sized_folders = 0
        for row in reference_rows:
            item_type = row["item_type"]
            item_id = row["item_id"]
            if item_type == "conversation":
                item = conversations.get(item_id)
            elif item_type == "artifact":
                item = artifacts.get(item_id)
            else:
                path = Path(item_id)
                include_folder_size = item_type == "folder" and sized_folders < 20
                item = _file_item(
                    path, item_type, include_folder_size=include_folder_size
                )
                if include_folder_size:
                    sized_folders += 1
            if item is None:
                item = {
                    "type": item_type,
                    "id": item_id,
                    "title": "Missing reference",
                    "status": "missing",
                    "size": 0,
                }
            item = dict(item)
            item["project_note"] = row["note"]
            item["added_at"] = row["added_at"]
            item["projects"] = [
                {
                    "id": project["id"],
                    "name": project["name"],
                    "color": project["color"],
                }
            ]
            if _matches_query(item, query.strip()):
                items.append(item)
        by_type = {
            item_type: [item for item in items if item["type"] == item_type]
            for item_type in ITEM_TYPES
        }
        return {
            "project": project,
            "items": items,
            "by_type": by_type,
            "storage": {
                "total": sum(item.get("size") or 0 for item in items),
                "conversation": sum(
                    item.get("size") or 0
                    for item in items
                    if item["type"] == "conversation"
                ),
                "artifact": sum(
                    item.get("size") or 0
                    for item in items
                    if item["type"] == "artifact"
                ),
                "files": sum(
                    item.get("size") or 0
                    for item in items
                    if item["type"] in {"file", "folder"}
                ),
            },
        }
    except ValueError as exc:
        return {"error": str(exc)}


@action
def get_dashboard() -> dict:
    """Return a compact overview for the app's landing page."""
    with _database() as connection:
        projects = _all_projects(connection)
        welcome_seen = connection.execute(
            "SELECT value FROM app_settings WHERE key = 'welcome_seen'"
        ).fetchone()
        first_run = welcome_seen is None and not projects
        if welcome_seen is None:
            connection.execute(
                "INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)",
                ("welcome_seen", "true", _now()),
            )
    assignments = _assignment_map()
    conversations = _scan_conversations()
    artifacts = _scan_artifacts(conversations)
    _attach_artifact_stats(conversations, artifacts)
    _attach_assignments(conversations, "conversation", assignments)
    _attach_assignments(artifacts, "artifact", assignments)
    missing = [item for item in artifacts if item["status"] == "missing"]
    orphaned = [item for item in artifacts if item["orphaned"]]
    unassigned_conversations = [item for item in conversations if not item["projects"]]
    unassigned_artifacts = [item for item in artifacts if not item["projects"]]
    return {
        "first_run": first_run,
        "projects": projects,
        "stats": {
            "projects": len(projects),
            "conversations": len(conversations),
            "conversation_bytes": sum(item["size"] for item in conversations),
            "artifacts": len(artifacts),
            "artifact_bytes": sum(
                item["size"] for item in artifacts if item["status"] == "present"
            ),
            "unassigned": len(unassigned_conversations) + len(unassigned_artifacts),
            "missing_artifacts": len(missing),
            "orphaned_artifacts": len(orphaned),
        },
        "recent": {
            "conversations": conversations[:5],
            "artifacts": artifacts[:5],
        },
        "attention": {
            "unassigned_conversations": len(unassigned_conversations),
            "unassigned_artifacts": len(unassigned_artifacts),
            "missing_artifacts": len(missing),
            "orphaned_artifacts": len(orphaned),
        },
        "roots": {
            "state": str(STATE_ROOT),
            "files": str(FILES_ROOT),
            "app_data": str(DATA_DIR),
        },
        "last_storage_scan": _cache_get("storage-report"),
    }


def _scan_storage() -> dict:
    files: list[dict] = []
    inaccessible = 0
    scanned_directories = 0
    truncated = False
    cutoff = datetime.now(UTC).timestamp() - (STALE_FILE_DAYS * 24 * 60 * 60)
    for root, dirs, names in os.walk(FILES_ROOT, followlinks=False):
        scanned_directories += 1
        root_path = Path(root)
        kept_dirs = []
        for name in dirs:
            path = root_path / name
            ignored = name in STORAGE_IGNORED_DIR_NAMES or path.is_symlink()
            if root_path == FILES_ROOT:
                ignored = (
                    ignored or name.startswith(".") or name in STORAGE_IGNORED_TOP_LEVEL
                )
            if root_path == FILES_ROOT / "gopath" and name == "pkg":
                ignored = True
            if not ignored:
                kept_dirs.append(name)
        dirs[:] = kept_dirs
        for name in names:
            if len(files) >= MAX_SCAN_FILES:
                truncated = True
                dirs[:] = []
                break
            path = root_path / name
            try:
                if path.is_symlink():
                    continue
                stat = path.stat()
            except OSError:
                inaccessible += 1
                continue
            files.append(
                {
                    "path": str(path),
                    "display_path": _pretty_path(path),
                    "name": name,
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                    "stale": stat.st_mtime < cutoff,
                }
            )
        if truncated:
            break

    files.sort(key=lambda item: item["size"], reverse=True)
    size_groups: dict[int, list[dict]] = defaultdict(list)
    for item in files:
        if 1024 * 1024 <= item["size"] <= 250 * 1024 * 1024:
            size_groups[item["size"]].append(item)
    candidates = [group for group in size_groups.values() if len(group) > 1]
    candidates.sort(key=lambda group: group[0]["size"] * len(group), reverse=True)
    duplicate_hashes: dict[tuple[int, str], list[dict]] = defaultdict(list)
    hashes_used = 0
    bytes_hashed = 0
    for group in candidates:
        for item in group:
            if (
                hashes_used >= MAX_DUPLICATE_HASHES
                or bytes_hashed + item["size"] > MAX_DUPLICATE_HASH_BYTES
            ):
                break
            try:
                digest = hashlib.sha256()
                with Path(item["path"]).open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                duplicate_hashes[(item["size"], digest.hexdigest())].append(item)
                hashes_used += 1
                bytes_hashed += item["size"]
            except OSError:
                inaccessible += 1
        if (
            hashes_used >= MAX_DUPLICATE_HASHES
            or bytes_hashed >= MAX_DUPLICATE_HASH_BYTES
        ):
            break
    duplicate_groups = []
    for (size, digest), group in duplicate_hashes.items():
        if len(group) < 2:
            continue
        duplicate_groups.append(
            {
                "size_each": size,
                "copies": len(group),
                "potential_savings": size * (len(group) - 1),
                "fingerprint": digest[:12],
                "files": [item["display_path"] for item in group],
            }
        )
    duplicate_groups.sort(key=lambda item: item["potential_savings"], reverse=True)

    conversations = _scan_conversations()
    artifacts = _scan_artifacts(conversations)
    missing_artifacts = [item for item in artifacts if item["status"] == "missing"]
    orphaned_artifacts = [item for item in artifacts if item["orphaned"]]
    total_bytes = sum(item["size"] for item in files)
    report = {
        "scanned_at": _now(),
        "root": str(FILES_ROOT),
        "summary": {
            "files": len(files),
            "directories": scanned_directories,
            "bytes": total_bytes,
            "large_files": sum(1 for item in files if item["size"] >= LARGE_FILE_BYTES),
            "stale_files": sum(1 for item in files if item["stale"]),
            "duplicate_groups": len(duplicate_groups),
            "duplicate_savings": sum(
                item["potential_savings"] for item in duplicate_groups
            ),
            "missing_artifacts": len(missing_artifacts),
            "orphaned_artifacts": len(orphaned_artifacts),
            "inaccessible": inaccessible,
        },
        "large_files": [item for item in files if item["size"] >= LARGE_FILE_BYTES][
            :30
        ],
        "stale_files": [item for item in files if item["stale"]][:30],
        "duplicates": duplicate_groups[:20],
        "missing_artifacts": missing_artifacts[:30],
        "orphaned_artifacts": orphaned_artifacts[:30],
        "truncated": truncated,
        "scan_limit": MAX_SCAN_FILES,
        "ignored_directories": sorted(
            STORAGE_IGNORED_DIR_NAMES
            | STORAGE_IGNORED_TOP_LEVEL
            | {"hidden top-level folders", "gopath/pkg"}
        ),
        "read_only": True,
    }
    _cache_set("storage-report", report)
    return report


@action
def get_storage_report(refresh: bool = False) -> dict:
    """Return the cached storage report or perform a new read-only scan."""
    if not refresh:
        cached = _cache_get("storage-report")
        if cached is not None:
            return cached
        return {"available": False, "read_only": True}
    return _scan_storage()
