"""
Code IDE — Backend
A VS Code-inspired file editor backend.
Browse folders, open files, edit and save them.
"""

from pathlib import Path
import fnmatch
import json
import os
import shlex
import shutil
import signal
import subprocess
import tempfile

from custom_apps import action

HOME = Path.home()

MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024
SEARCH_IGNORED_DIRS = {
    '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__',
    'node_modules', 'dist', 'build', '.next', '.cache',
}

# Restrict browsing to home directory for safety
def _safe_path(p: str) -> Path:
    """Resolve a path and ensure it's within the home directory."""
    if not p:
        return HOME
    full = Path(p).expanduser().resolve()
    try:
        full.relative_to(HOME)
    except ValueError:
        # Allow the home dir itself
        if full == HOME:
            return full
        raise PermissionError(f"Path '{p}' is outside the home directory")
    return full


def _safe_operation_path(p: str) -> Path:
    """Validate symlink containment but retain the lexical path for rename/delete."""
    if not p:
        return HOME
    lexical = Path(os.path.abspath(Path(p).expanduser()))
    resolved = lexical.resolve()
    try:
        lexical.relative_to(HOME)
        resolved.relative_to(HOME)
    except ValueError as exc:
        raise PermissionError(f"Path '{p}' is outside the home directory") from exc
    return lexical


def _valid_name(name: str) -> str:
    """Validate a file/folder name without allowing path traversal or moves."""
    if not isinstance(name, str):
        raise ValueError("Name must be text")
    name = name.strip()
    if not name or name in {'.', '..'} or '/' in name or '\\' in name or '\x00' in name:
        raise ValueError("Name must be a single file or folder name")
    return name


def _atomic_write_text(target: Path, content: str) -> None:
    """Write UTF-8 text beside the target and atomically replace it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    previous_mode = target.stat().st_mode if target.exists() else None
    handle = tempfile.NamedTemporaryFile(
        mode='w', encoding='utf-8', dir=target.parent,
        prefix=f'.{target.name}.', suffix='.tmp', delete=False,
    )
    tmp_path = Path(handle.name)
    try:
        with handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if previous_mode is not None:
            os.chmod(tmp_path, previous_mode)
        os.replace(tmp_path, target)
    finally:
        tmp_path.unlink(missing_ok=True)


def _matches_globs(relative: Path, include: str = "", exclude: str = "") -> bool:
    rel = relative.as_posix()
    name = relative.name
    includes = [part.strip() for part in include.split(',') if part.strip()]
    excludes = [part.strip() for part in exclude.split(',') if part.strip()]
    if includes and not any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(name, pat) for pat in includes):
        return False
    if any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(name, pat) for pat in excludes):
        return False
    return True


@action
def list_dir(path: str = "") -> dict:
    """List contents of a directory. Returns files and folders with metadata."""
    try:
        target = _safe_path(path)
        if not target.exists():
            return {"error": f"Path does not exist: {path}"}
        if not target.is_dir():
            return {"error": f"Not a directory: {path}"}

        items = []
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            # Skip hidden files unless explicitly in a hidden dir
            if entry.name.startswith('.'):
                continue
            try:
                _safe_path(str(entry))
                stat = entry.stat()
                items.append({
                    "name": entry.name,
                    "path": str(entry),
                    "is_dir": entry.is_dir(),
                    "size": stat.st_size if entry.is_file() else 0,
                    "modified": stat.st_mtime,
                })
            except (PermissionError, OSError):
                continue

        return {
            "path": str(target),
            "name": target.name or str(target),
            "parent": str(target.parent) if target != HOME else None,
            "items": items,
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to list directory: {e}"}


@action
def list_dir_with_hidden(path: str = "") -> dict:
    """List directory contents including hidden files."""
    try:
        target = _safe_path(path)
        if not target.exists():
            return {"error": f"Path does not exist: {path}"}
        if not target.is_dir():
            return {"error": f"Not a directory: {path}"}

        items = []
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            try:
                _safe_path(str(entry))
                stat = entry.stat()
                items.append({
                    "name": entry.name,
                    "path": str(entry),
                    "is_dir": entry.is_dir(),
                    "size": stat.st_size if entry.is_file() else 0,
                    "modified": stat.st_mtime,
                })
            except (PermissionError, OSError):
                continue

        return {
            "path": str(target),
            "name": target.name or str(target),
            "parent": str(target.parent) if target != HOME else None,
            "items": items,
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to list directory: {e}"}


@action
def read_file(path: str) -> dict:
    """Read a file's contents."""
    try:
        target = _safe_path(path)
        if not target.exists():
            return {"error": f"File does not exist: {path}"}
        if not target.is_file():
            return {"error": f"Not a file: {path}"}

        # Check file size — don't read huge files
        size = target.stat().st_size
        if size > MAX_TEXT_FILE_SIZE:
            return {"error": f"File too large ({size} bytes). Max 5MB."}

        # Try to read as text
        try:
            content = target.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            return {"error": "Binary file — cannot display as text."}

        return {
            "path": str(target),
            "name": target.name,
            "content": content,
            "size": size,
            "modified": target.stat().st_mtime,
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to read file: {e}"}


@action
def write_file(path: str, content: str = "", expected_modified: float | None = None) -> dict:
    """Write content to a file (save)."""
    try:
        target = _safe_path(path)
        if target.exists() and not target.is_file():
            return {"error": f"Not a file: {path}"}
        if len(content.encode('utf-8')) > MAX_TEXT_FILE_SIZE:
            return {"error": "File too large. Max 5MB."}
        if expected_modified is not None:
            if not target.exists():
                return {"error": "File was deleted on disk", "conflict": True}
            actual_modified = target.stat().st_mtime
            if actual_modified != expected_modified:
                return {
                    "error": "File changed on disk. Reload it or explicitly overwrite it.",
                    "conflict": True,
                    "modified": actual_modified,
                }
        _atomic_write_text(target, content)
        stat = target.stat()
        return {
            "path": str(target),
            "name": target.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "success": True,
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to write file: {e}"}


@action
def create_file(path: str, content: str = "") -> dict:
    """Create a new file."""
    try:
        target = _safe_path(path)
        if target.exists():
            return {"error": f"File already exists: {path}"}
        if len(content.encode('utf-8')) > MAX_TEXT_FILE_SIZE:
            return {"error": "File too large. Max 5MB."}
        _atomic_write_text(target, content)
        return {"path": str(target), "name": target.name, "success": True}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to create file: {e}"}


@action
def create_folder(path: str) -> dict:
    """Create a new folder."""
    try:
        target = _safe_path(path)
        if target.exists():
            return {"error": f"Path already exists: {path}"}
        target.mkdir(parents=True, exist_ok=True)
        return {"path": str(target), "name": target.name, "success": True}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to create folder: {e}"}


@action
def delete_path(path: str) -> dict:
    """Delete a file or folder."""
    try:
        target = _safe_operation_path(path)
        if target == HOME:
            return {"error": "Refusing to delete the home directory"}
        if not target.exists():
            return {"error": f"Path does not exist: {path}"}
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
        return {"path": str(target), "success": True}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to delete: {e}"}


@action
def rename_path(old_path: str, new_name: str) -> dict:
    """Rename a file or folder."""
    try:
        target = _safe_operation_path(old_path)
        if not target.exists():
            return {"error": f"Path does not exist: {old_path}"}
        new_name = _valid_name(new_name)
        new_path = target.parent / new_name
        new_path = _safe_path(str(new_path))
        if new_path.exists():
            return {"error": f"Path already exists: {new_path}"}
        target.rename(new_path)
        return {"old_path": str(target), "new_path": str(new_path), "success": True}
    except (PermissionError, ValueError) as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to rename: {e}"}


@action
def stat_file(path: str) -> dict:
    """Get file metadata (mtime, size) without reading content. Lightweight for polling."""
    try:
        target = _safe_path(path)
        if not target.exists():
            return {"path": str(target), "exists": False}
        stat = target.stat()
        return {
            "path": str(target),
            "exists": True,
            "is_dir": target.is_dir(),
            "size": stat.st_size,
            "modified": stat.st_mtime,
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to stat file: {e}"}


@action
def stat_files(paths: list[str] | None = None) -> dict:
    """Batch file metadata checks to avoid one Custom App action per open tab."""
    if not isinstance(paths, list):
        return {"error": "paths must be a list"}
    if len(paths) > 500:
        return {"error": "Too many paths (max 500)"}
    return {"items": {path: stat_file(path) for path in paths if isinstance(path, str)}}


@action
def get_home() -> dict:
    """Get the home directory path."""
    return {"home": str(HOME)}


@action
def search_files(
    path: str = "", query: str = "", limit: int = 200,
    content: bool = False, include: str = "", exclude: str = "",
    show_hidden: bool = False,
) -> dict:
    """Search names or UTF-8 file content beneath a directory."""
    try:
        root = _safe_path(path) if path else HOME
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}
        if not query.strip():
            return {"results": []}

        query_lower = query.lower()
        results = []
        limit = max(1, min(int(limit), 1000))
        for current, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [
                name for name in dirnames
                if (show_hidden or not name.startswith('.')) and name not in SEARCH_IGNORED_DIRS
            ]
            current_path = Path(current)
            entries = filenames if content else dirnames + filenames
            for name in entries:
                if name.startswith('.') and not show_hidden:
                    continue
                entry = current_path / name
                try:
                    _safe_path(str(entry))
                except PermissionError:
                    continue
                relative = entry.relative_to(root)
                if not _matches_globs(relative, include, exclude):
                    continue
                match_line = None
                match_text = None
                matched = query_lower in name.lower()
                if content:
                    if not entry.is_file():
                        continue
                    try:
                        if entry.stat().st_size > MAX_TEXT_FILE_SIZE:
                            continue
                        with entry.open('r', encoding='utf-8') as handle:
                            for number, line in enumerate(handle, 1):
                                if query_lower in line.lower():
                                    matched = True
                                    match_line = number
                                    match_text = line.strip()[:240]
                                    break
                    except (UnicodeDecodeError, PermissionError, OSError):
                        continue
                if not matched:
                    continue
                try:
                    stat = entry.stat()
                    result = {
                        "name": entry.name,
                        "path": str(entry),
                        "is_dir": entry.is_dir(),
                        "size": stat.st_size if entry.is_file() else 0,
                        "modified": stat.st_mtime,
                        "rel_path": str(relative),
                    }
                    if match_line is not None:
                        result["line"] = match_line
                        result["match"] = match_text
                    results.append(result)
                    if len(results) >= limit:
                        break
                except (PermissionError, OSError):
                    continue
            if len(results) >= limit:
                break

        # Sort: dirs first, then files, alphabetical
        results.sort(key=lambda r: (not r['is_dir'], r['rel_path'].lower()))
        return {"results": results, "root": str(root), "count": len(results)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Search failed: {e}"}


@action
def replace_in_files(
    path: str = "", query: str = "", replacement: str = "",
    include: str = "", exclude: str = "", limit: int = 200,
    show_hidden: bool = False,
) -> dict:
    """Replace literal text in matching UTF-8 files, returning changed paths."""
    try:
        if not query:
            return {"error": "Search text cannot be empty"}
        found = search_files(path, query, limit, True, include, exclude, show_hidden)
        if found.get("error"):
            return found
        changed = []
        replacements = 0
        for item in found.get("results", []):
            target = _safe_path(item["path"])
            original = target.read_text(encoding='utf-8')
            count = original.count(query)
            if count:
                _atomic_write_text(target, original.replace(query, replacement))
                changed.append(str(target))
                replacements += count
        return {
            "success": True,
            "files_changed": len(changed),
            "replacements": replacements,
            "paths": changed,
        }
    except Exception as e:
        return {"error": f"Replace failed: {e}"}


# ===== State persistence =====
STATE_FILE = Path(__file__).parent / "data" / "state.json"


@action
def save_state(data: str = "") -> dict:
    """Save app state to a JSON file."""
    try:
        # Reject corrupt state before replacing the last known-good snapshot.
        json.loads(data)
        _atomic_write_text(STATE_FILE, data)
        return {"success": True}
    except Exception as e:
        return {"error": f"Failed to save state: {e}"}


@action
def load_state() -> dict:
    """Load app state from a JSON file."""
    try:
        if STATE_FILE.exists():
            return {"data": STATE_FILE.read_text(encoding='utf-8')}
        return {"data": None}
    except Exception as e:
        return {"error": f"Failed to load state: {e}"}


@action
def run_command(command: str, cwd: str = "") -> dict:
    """Run a shell command and return stdout, stderr, and exit code."""
    if not command or not command.strip():
        return {"error": "No command provided"}

    # Resolve working directory
    if cwd:
        try:
            work_dir = _safe_path(cwd)
            if not work_dir.is_dir():
                return {"error": f"Working directory does not exist: {cwd}"}
        except PermissionError as e:
            return {"error": str(e)}
    else:
        work_dir = HOME

    try:
        # Each Custom App action runs in a fresh process. Handle a standalone
        # `cd` here so the frontend can persist the returned cwd between calls.
        try:
            parts = shlex.split(command.strip())
        except ValueError as exc:
            return {"error": f"Invalid command: {exc}"}
        if parts and parts[0] == 'cd' and len(parts) <= 2:
            destination = HOME if len(parts) == 1 else Path(parts[1]).expanduser()
            if not destination.is_absolute():
                destination = work_dir / destination
            destination = _safe_path(str(destination))
            if not destination.is_dir():
                return {"error": f"Directory does not exist: {parts[-1]}"}
            return {
                "stdout": "", "stderr": "", "exit_code": 0,
                "cwd": str(destination), "truncated": False,
            }

        # Ensure common bin dirs are in PATH so tools like python3, omnideck, etc. work
        env = os.environ.copy()
        extra_paths = [
            str(HOME / ".local" / "bin"),
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        env["PATH"] = os.pathsep.join(extra_paths) + os.pathsep + env.get("PATH", "")
        env.setdefault("HOME", str(HOME))
        env.setdefault("TERM", "xterm-256color")

        # Run with a 30-second timeout
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=str(work_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            stdout, stderr = proc.communicate()
            return {
                "stdout": stdout[:100_000],
                "stderr": stderr[:100_000],
                "exit_code": -1,
                "cwd": str(work_dir),
                "timeout": True,
            }

        # Truncate very large output
        max_len = 100_000  # 100KB per stream
        truncated = False
        if len(stdout) > max_len:
            stdout = stdout[:max_len] + "\n... [output truncated]"
            truncated = True
        if len(stderr) > max_len:
            stderr = stderr[:max_len] + "\n... [output truncated]"
            truncated = True

        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": proc.returncode,
            "cwd": str(work_dir),
            "truncated": truncated,
        }
    except Exception as e:
        return {"error": f"Failed to run command: {e}"}


def _git_repository_root(cwd: Path) -> Path:
    proc = subprocess.run(
        ['git', '-C', str(cwd), 'rev-parse', '--show-toplevel'],
        capture_output=True, text=True, timeout=5,
    )
    if proc.returncode != 0:
        raise ValueError(proc.stderr.strip() or "Not a Git repository")
    return _safe_path(proc.stdout.strip())


def _decode_git_content(content: bytes) -> str | None:
    """Decode a Git blob for the editor, returning None for binary content."""
    if b'\x00' in content:
        return None
    try:
        return content.decode('utf-8')
    except UnicodeDecodeError:
        return None


@action
def git_status(path: str = "") -> dict:
    """Return concise, rename-safe source-control status for a repository."""
    try:
        cwd = _safe_path(path) if path else HOME
        root = _git_repository_root(cwd)
        proc = subprocess.run(
            ['git', '-C', str(root), 'status', '--porcelain=v1', '--branch', '-z'],
            capture_output=True, timeout=10,
        )
        if proc.returncode != 0:
            message = proc.stderr.decode('utf-8', errors='replace').strip()
            return {"error": message or "Not a Git repository"}

        records = proc.stdout.decode('utf-8', errors='replace').split('\x00')
        branch = ''
        index = 0
        if records and records[0].startswith('## '):
            branch = records[0][3:]
            index = 1

        files = []
        while index < len(records):
            record = records[index]
            index += 1
            if len(record) < 4:
                continue
            status = record[:2]
            file_path = record[3:]
            original_path = ''
            if 'R' in status or 'C' in status:
                if index < len(records):
                    original_path = records[index]
                    index += 1
            files.append({
                "status": status,
                "path": file_path,
                "original_path": original_path,
            })
        return {
            "root": str(root),
            "branch": branch,
            "files": files,
            "count": len(files),
        }
    except Exception as e:
        return {"error": f"Git status failed: {e}"}


@action
def git_diff(
    path: str = "", file_path: str = "", original_path: str = "",
) -> dict:
    """Return unified and editor-ready HEAD-to-working-tree diff data."""
    try:
        cwd = _safe_path(path) if path else HOME
        root = _git_repository_root(cwd)
        has_head = subprocess.run(
            ['git', '-C', str(root), 'rev-parse', '--verify', 'HEAD'],
            capture_output=True, timeout=5,
        ).returncode == 0

        target = None
        target_relative = None
        original_relative = None
        if file_path:
            target = _safe_path(file_path)
            try:
                target_relative = target.relative_to(root)
            except ValueError as exc:
                raise PermissionError("Diff target is outside the Git repository") from exc
            if original_path:
                original_target = _safe_path(original_path)
                try:
                    original_relative = original_target.relative_to(root)
                except ValueError as exc:
                    raise PermissionError(
                        "Original diff target is outside the Git repository"
                    ) from exc
            else:
                original_relative = target_relative

        diff = ''
        if has_head:
            command = ['git', '-C', str(root), 'diff', 'HEAD', '--']
            if original_relative is not None and original_relative != target_relative:
                command.append(original_relative.as_posix())
            if target_relative is not None:
                command.append(target_relative.as_posix())
            proc = subprocess.run(
                command, capture_output=True, text=True, errors='replace', timeout=10,
            )
            if proc.returncode != 0:
                return {"error": proc.stderr.strip() or "Could not read Git diff"}
            diff = proc.stdout
            if len(diff) > 500_000:
                diff = diff[:500_000] + "\n... [diff truncated]"

        if target is None:
            return {"diff": diff}

        original_bytes = b''
        if has_head and original_relative is not None:
            original_proc = subprocess.run(
                ['git', '-C', str(root), 'show', f'HEAD:{original_relative.as_posix()}'],
                capture_output=True, timeout=10,
            )
            if original_proc.returncode == 0:
                original_bytes = original_proc.stdout

        modified_bytes = b''
        modified_time = 0
        if target.exists() and target.is_file():
            if target.stat().st_size > MAX_TEXT_FILE_SIZE:
                return {
                    "diff": diff,
                    "path": target_relative.as_posix(),
                    "error": "File too large to display in the diff editor.",
                }
            modified_bytes = target.read_bytes()
            modified_time = target.stat().st_mtime

        if len(original_bytes) > MAX_TEXT_FILE_SIZE:
            return {
                "diff": diff,
                "path": target_relative.as_posix(),
                "error": "HEAD version is too large to display in the diff editor.",
            }

        original = _decode_git_content(original_bytes)
        modified = _decode_git_content(modified_bytes)
        binary = original is None or modified is None
        return {
            "diff": diff,
            "path": target_relative.as_posix(),
            "original_path": original_relative.as_posix(),
            "original": '' if binary else original,
            "modified": '' if binary else modified,
            "modified_time": modified_time,
            "binary": binary,
            "deleted": not target.exists(),
        }
    except Exception as e:
        return {"error": f"Git diff failed: {e}"}


@action
def format_content(content: str = "", language: str = "") -> dict:
    """Format editor content with a built-in or installed formatter."""
    language = language.lower()
    if language in {'json', 'application/json'}:
        try:
            parsed = json.loads(content)
            return {"content": json.dumps(parsed, indent=2, ensure_ascii=False) + "\n"}
        except (TypeError, ValueError) as exc:
            return {"error": f"Invalid JSON: {exc}"}

    commands = {
        'python': (['ruff', 'format', '-'], ['black', '-q', '-']),
        'javascript': (['prettier', '--parser', 'babel'],),
        'typescript': (['prettier', '--parser', 'typescript'],),
        'html': (['prettier', '--parser', 'html'],),
        'css': (['prettier', '--parser', 'css'],),
        'markdown': (['prettier', '--parser', 'markdown'],),
        'yaml': (['prettier', '--parser', 'yaml'],),
    }
    candidates = commands.get(language, ())
    for command in candidates:
        if not shutil.which(command[0]):
            continue
        try:
            proc = subprocess.run(
                command, input=content, capture_output=True, text=True, timeout=20,
            )
        except subprocess.TimeoutExpired:
            return {"error": "Formatter timed out"}
        if proc.returncode == 0:
            return {"content": proc.stdout}
        return {"error": proc.stderr.strip() or "Formatter failed"}
    return {"error": f"No formatter is installed for {language or 'this file type'}"}
