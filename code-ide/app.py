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
import hashlib

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


def _matches_globs(rel_path: str, name: str, include: str = "", exclude: str = "") -> bool:
    """Check if a path matches include/exclude glob patterns."""
    includes = [part.strip() for part in include.split(',') if part.strip()]
    excludes = [part.strip() for part in exclude.split(',') if part.strip()]
    if includes and not any(fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(name, pat) for pat in includes):
        return False
    if any(fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(name, pat) for pat in excludes):
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
    """Search names or UTF-8 file content beneath a directory.

    Uses ripgrep for content search when available (10-100x faster than
    Python line-by-line reading). Falls back to os.scandir + parallel
    file reading otherwise.
    """
    try:
        root = _safe_path(path) if path else HOME
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}
        if not query.strip():
            return {"results": []}

        query_lower = query.lower()
        limit = max(1, min(int(limit), 1000))
        root_str = str(root)
        root_prefix = root_str + '/'

        if content:
            results = _search_content(
                root, root_str, root_prefix, query, query_lower,
                limit, include, exclude, show_hidden,
            )
        else:
            results = _search_names(
                root, root_str, root_prefix, query_lower,
                limit, include, exclude, show_hidden,
            )

        results.sort(key=lambda r: (not r['is_dir'], r['rel_path'].lower()))
        return {"results": results, "root": root_str, "count": len(results)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Search failed: {e}"}


def _rel_path(entry_path: str, root_str: str, root_prefix: str) -> str:
    """Compute relative path as a string, avoiding Path.relative_to overhead."""
    if entry_path.startswith(root_prefix):
        return entry_path[len(root_prefix):]
    if entry_path == root_str:
        return ''
    return entry_path  # fallback (shouldn't happen with safe paths)





def _search_names(
    root, root_str, root_prefix, query_lower,
    limit, include, exclude, show_hidden,
):
    """Fast name-only search using os.scandir with a manual stack."""
    results = []
    stack = [root_str]
    while stack and len(results) < limit:
        current = stack.pop()
        try:
            entries = os.scandir(current)
        except PermissionError:
            continue
        with entries as it:
            for entry in it:
                name = entry.name
                if not show_hidden and name.startswith('.'):
                    continue
                if name in SEARCH_IGNORED_DIRS:
                    continue
                # Skip symlinks — they could point outside the home directory
                if entry.is_symlink():
                    continue
                if query_lower not in name.lower():
                    continue
                rel = _rel_path(entry.path, root_str, root_prefix)
                if not _matches_globs(rel, name, include, exclude):
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    st = entry.stat()
                    results.append({
                        "name": name,
                        "path": entry.path,
                        "is_dir": is_dir,
                        "size": 0 if is_dir else st.st_size,
                        "modified": st.st_mtime,
                        "rel_path": rel,
                    })
                except OSError:
                    continue
        # Push subdirectories for further traversal
        try:
            entries2 = os.scandir(current)
        except PermissionError:
            continue
        with entries2 as it:
            for entry in it:
                if entry.name.startswith('.'):
                    continue
                if entry.name in SEARCH_IGNORED_DIRS:
                    continue
                if entry.is_symlink():
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                except OSError:
                    continue
    return results


def _search_content(
    root, root_str, root_prefix, query, query_lower,
    limit, include, exclude, show_hidden,
):
    """Content search — uses ripgrep when available, otherwise parallel file reads."""
    # Try ripgrep first — 10-100x faster than Python line-by-line
    rg = shutil.which('rg')
    if rg:
        return _search_content_rg(
            root, root_str, root_prefix, query, query_lower,
            limit, include, exclude, show_hidden,
        )
    # Fallback: parallel file reads
    return _search_content_python(
        root, root_str, root_prefix, query_lower,
        limit, include, exclude, show_hidden,
    )


def _search_content_rg(
    root, root_str, root_prefix, query, query_lower,
    limit, include, exclude, show_hidden,
):
    """Content search via ripgrep."""
    import subprocess
    results = []
    cmd = [
        'rg', '--line-number', '--max-count', '1',
        '--with-filename', '--no-heading',
        '--color', 'never', '-i',
        '--max-filesize', '5M',
    ]
    if show_hidden:
        cmd.append('--hidden')
    if include:
        for pat in include.split(','):
            pat = pat.strip()
            if pat:
                cmd.extend(['--glob', pat])
    if exclude:
        for pat in exclude.split(','):
            pat = pat.strip()
            if pat:
                cmd.extend(['--glob', '!' + pat])
    # Skip common ignored dirs
    for d in SEARCH_IGNORED_DIRS:
        cmd.extend(['--glob', '!' + d])
    cmd.extend(['--', query, root_str])

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return results
    except FileNotFoundError:
        return results

    if proc.returncode not in (0, 1):
        return results  # 1 = no matches, other = error

    for line in proc.stdout.splitlines():
        if len(results) >= limit:
            break
        # Format: "path:line:content"
        colon_idx = line.find(':')
        if colon_idx < 0:
            continue
        file_path = line[:colon_idx]
        rest = line[colon_idx + 1:]
        colon_idx2 = rest.find(':')
        if colon_idx2 < 0:
            continue
        try:
            line_num = int(rest[:colon_idx2])
        except ValueError:
            continue
        match_text = rest[colon_idx2 + 1:].strip()[:240]

        if not file_path.startswith(root_prefix):
            continue
        rel = file_path[len(root_prefix):]
        name = rel.split('/')[-1] if '/' in rel else rel

        try:
            st = os.stat(file_path)
            results.append({
                "name": name,
                "path": file_path,
                "is_dir": False,
                "size": st.st_size,
                "modified": st.st_mtime,
                "rel_path": rel,
                "line": line_num,
                "match": match_text,
            })
        except OSError:
            continue

    return results


def _search_content_python(
    root, root_str, root_prefix, query_lower,
    limit, include, exclude, show_hidden,
):
    """Content search via parallel file reads (fallback when ripgrep unavailable)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # First, collect all candidate files
    candidates = []
    stack = [root_str]
    while stack and len(candidates) < limit * 10:
        current = stack.pop()
        try:
            entries = os.scandir(current)
        except PermissionError:
            continue
        with entries as it:
            for entry in it:
                name = entry.name
                if not show_hidden and name.startswith('.'):
                    continue
                if name in SEARCH_IGNORED_DIRS:
                    continue
                if entry.is_symlink():
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                    elif entry.is_file():
                        rel = _rel_path(entry.path, root_str, root_prefix)
                        if _matches_globs(rel, name, include, exclude):
                            candidates.append((entry.path, name, rel))
                except OSError:
                    continue

    if not candidates:
        return []

    results = []

    def search_file(path, name, rel):
        try:
            st = os.stat(path)
            if st.st_size > MAX_TEXT_FILE_SIZE:
                return None
            with open(path, 'r', encoding='utf-8') as f:
                for num, line in enumerate(f, 1):
                    if query_lower in line.lower():
                        return {
                            "name": name,
                            "path": path,
                            "is_dir": False,
                            "size": st.st_size,
                            "modified": st.st_mtime,
                            "rel_path": rel,
                            "line": num,
                            "match": line.strip()[:240],
                        }
        except (UnicodeDecodeError, PermissionError, OSError):
            pass
        return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(search_file, p, n, r): (p, n, r) for p, n, r in candidates}
        for future in as_completed(futures):
            if len(results) >= limit:
                break
            result = future.result()
            if result:
                results.append(result)

    return results[:limit]


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
        scope = review_mod.workspace_scope(cwd)
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
            # Git resolves upward to the repository root, so this listing can
            # cover more than the selected workspace. Report the relationship
            # rather than leaving the difference invisible.
            "repo_name": scope["repo_name"],
            "scope": scope["scope"],
            "is_repo_root": scope["is_repo_root"],
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


# ===== Code Observatory — metrics index =====
import metrics as metrics_mod
import symbols as symbols_mod
import review as review_mod

METRICS_DIR = Path(__file__).parent / "data"


def _metrics_cache_path(root: Path) -> Path:
    digest = hashlib.sha1(str(root).encode()).hexdigest()[:8]
    return METRICS_DIR / f"metrics-{digest}.json"


def _symbols_cache_path(root: Path) -> Path:
    digest = hashlib.sha1(str(root).encode()).hexdigest()[:8]
    return METRICS_DIR / f"symbols-{digest}.json"


def _newest_source_mtime(root: Path, limit: int = 20000) -> float:
    """Newest modification time under root, ignoring build and vcs folders.

    Scanning mtimes needs no parsing, so it is far cheaper than rebuilding the
    index and lets a cache answer "am I still current?" for itself.
    """
    newest = 0.0
    seen = 0
    stack = [root]
    while stack and seen < limit:
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith('.') or entry.name in SEARCH_IGNORED_DIRS:
                continue
            seen += 1
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                else:
                    newest = max(newest, entry.stat().st_mtime)
            except OSError:
                continue
    return newest


def _load_symbol_index(root: Path, refresh: bool = False) -> dict:
    """Return the symbol index, rebuilding it when the sources have moved on.

    The cache used to be rebuilt only when someone pressed a button, so every
    reader silently worked from whatever the tree looked like the last time
    that happened.
    """
    cache = _symbols_cache_path(root)
    if not refresh and cache.exists():
        try:
            if cache.stat().st_mtime >= _newest_source_mtime(root):
                return json.loads(cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    try:
        index = symbols_mod.build_symbol_index(root)
    except Exception:
        # If the index build fails (e.g. tree-sitter parse error on a large
        # directory), return an empty index so callers can degrade gracefully.
        return {"symbols": [], "modules": [], "file_count": 0, "symbol_count": 0}
    METRICS_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(cache, json.dumps(index))
    return index


@action
def metrics_index(path: str = "", refresh: bool = False) -> dict:
    """Build (or return cached) code metrics index for a repo root."""
    try:
        root = _safe_path(path) if path else HOME
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}
        cache = _metrics_cache_path(root)
        if cache.exists() and not refresh:
            try:
                data = json.loads(cache.read_text(encoding="utf-8"))
                data["cached"] = True
                return data
            except Exception:
                pass  # fall through and rebuild
        index = metrics_mod.build_index(root)
        METRICS_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(cache, json.dumps(index))
        index["cached"] = False
        return index
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to build metrics index: {e}"}


@action
def metrics_status(path: str = "") -> dict:
    """Report whether a cached metrics index exists for a repo root."""
    try:
        root = _safe_path(path) if path else HOME
        cache = _metrics_cache_path(root)
        if not cache.exists():
            return {"exists": False}
        stat = cache.stat()
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        return {
            "exists": True,
            "modified": stat.st_mtime,
            "file_count": data.get("totals", {}).get("files", 0),
            "root": str(root),
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


@action
def symbol_index(path: str = "", refresh: bool = False) -> dict:
    """Return a slim symbol index (modules + edges + summary) for a repo root.

    The full index (with all symbols and call graphs) is cached on disk but is
    too large to return in one action (>1MB cap). Use module_symbols /
    symbol_details / symbol_search to fetch slices on demand.
    """
    try:
        root = _safe_path(path) if path else HOME
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}
        cache = _symbols_cache_path(root)
        if cache.exists() and not refresh:
            try:
                index = json.loads(cache.read_text(encoding="utf-8"))
            except Exception:
                index = symbols_mod.build_symbol_index(root)
                _atomic_write_text(cache, json.dumps(index))
        else:
            index = symbols_mod.build_symbol_index(root)
            METRICS_DIR.mkdir(parents=True, exist_ok=True)
            _atomic_write_text(cache, json.dumps(index))
        # slim projection — omit the heavy per-symbol arrays
        return {
            "root": index.get("root", ""),
            "file_count": index.get("file_count", 0),
            "symbol_count": index.get("symbol_count", 0),
            "call_count": index.get("call_count", 0),
            "unresolved_calls": index.get("unresolved_calls", 0),
            "languages": index.get("languages", []),
            "modules": [
                {
                    "id": m["id"], "path": m["path"], "language": m["language"],
                    "sym_count": len(m["symbols"]),
                }
                for m in index.get("modules", [])
            ],
            "edges": index.get("edges", []),
            "summary": index.get("summary", {}),
            "cached": not refresh,
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to build symbol index: {e}"}


def _load_full_symbol_index(root: Path) -> dict | None:
    """Read the full cached symbol index (with symbols + call graphs)."""
    cache = _symbols_cache_path(root)
    if not cache.exists():
        return None
    try:
        return json.loads(cache.read_text(encoding="utf-8"))
    except Exception:
        return None


@action
def module_symbols(path: str = "", module: str = "") -> dict:
    """Return the symbols for one module (file). Slim: no callees/callers arrays."""
    try:
        root = _safe_path(path) if path else HOME
        index = _load_full_symbol_index(root)
        if index is None:
            return {"error": "No symbol index. Build it first."}
        for m in index.get("modules", []):
            if m["path"] != module:
                continue
            sym_by_id = {s["id"]: s for s in index["symbols"]}
            syms = []
            for sid in m["symbols"]:
                s = sym_by_id.get(sid)
                if not s:
                    continue
                syms.append({
                    "id": s["id"], "name": s["name"], "kind": s["kind"],
                    "line": s["line"], "end_line": s.get("end_line", s["line"]),
                    "enclosing": s.get("enclosing"), "size": s.get("size", 1),
                    "signature": s.get("signature", ""),
                    "callees_count": len(s.get("callees", [])),
                    "callers_count": len(s.get("callers", [])),
                })
            return {"module": module, "symbols": syms}
        return {"error": f"Module not found: {module}"}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to load module symbols: {e}"}


@action
def symbol_details(path: str = "", symbol_id: str = "") -> dict:
    """Return one symbol with its callees/callers resolved to navigable refs."""
    try:
        root = _safe_path(path) if path else HOME
        index = _load_full_symbol_index(root)
        if index is None:
            return {"error": "No symbol index. Build it first."}
        sym_by_id = {s["id"]: s for s in index["symbols"]}
        s = sym_by_id.get(symbol_id)
        if s is None:
            return {"error": f"Symbol not found: {symbol_id}"}
        def resolve(ids):
            out = []
            for sid in ids:
                t = sym_by_id.get(sid)
                if t:
                    out.append({"id": t["id"], "name": t["name"], "kind": t["kind"],
                                "module": t["module"], "line": t["line"]})
            return out
        return {
            "id": s["id"], "name": s["name"], "kind": s["kind"],
            "module": s["module"], "line": s["line"], "end_line": s.get("end_line", s["line"]),
            "signature": s.get("signature", ""), "size": s.get("size", 1),
            "enclosing": s.get("enclosing"),
            "callees": resolve(s.get("callees", [])),
            "callers": resolve(s.get("callers", [])),
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to load symbol details: {e}"}


@action
def symbol_search(path: str = "", query: str = "", limit: int = 200) -> dict:
    """Search symbol names across the repo. Returns slim matches."""
    try:
        root = _safe_path(path) if path else HOME
        if not query.strip():
            return {"results": [], "count": 0}
        index = _load_full_symbol_index(root)
        if index is None:
            return {"error": "No symbol index. Build it first."}
        q = query.lower()
        limit = max(1, min(int(limit), 500))
        results = []
        for s in index["symbols"]:
            if q in s["name"].lower():
                results.append({"id": s["id"], "name": s["name"], "kind": s["kind"],
                                "module": s["module"], "line": s["line"]})
                if len(results) >= limit:
                    break
        return {"results": results, "count": len(results)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Search failed: {e}"}


@action
def entry_points(path: str = "") -> dict:
    """Return symbols with zero callers — the external interface of the codebase.

    Grouped into 'entry_points' (non-test, non-private) and 'tests' (test files).
    Private/unused functions are included in entry_points for visibility.
    """
    try:
        root = _safe_path(path) if path else HOME
        index = _load_full_symbol_index(root)
        if index is None:
            return {"error": "No symbol index. Build it first."}
        # Build caller count per symbol
        caller_count: dict[str, int] = {}
        for s in index["symbols"]:
            for caller_id in s.get("callers", []):
                caller_count[caller_id] = caller_count.get(caller_id, 0) + 1
        # Also count module-level calls (calls with no enclosing function)
        # Those are in the callees dict under __module__<path> keys — but those
        # are caller-side keys, not callee-side. The callers list on each symbol
        # already includes all resolved callers. So zero callers = zero callers.

        entry_points = []
        tests = []
        for s in index["symbols"]:
            if len(s.get("callers", [])) > 0:
                continue
            # Skip __init__, __main__ etc. — they're language plumbing
            if s["name"] in ("__init__", "__main__", "__enter__", "__exit__"):
                continue
            info = {
                "id": s["id"], "name": s["name"], "kind": s["kind"],
                "module": s["module"], "line": s["line"],
                "size": s.get("size", 0),
                "callees_count": len(s.get("callees", [])),
            }
            # Classify: test file?
            is_test = (
                "/test" in s["module"].lower()
                or s["module"].startswith("test")
                or s["name"].startswith("test_")
                or s["name"].endswith("_test")
                or ".test." in s["module"]
            )
            if is_test:
                tests.append(info)
            else:
                entry_points.append(info)

        # Sort: larger functions first (more interesting entry points)
        entry_points.sort(key=lambda s: (-s["size"], s["name"]))
        tests.sort(key=lambda s: (-s["size"], s["name"]))

        return {
            "entry_points": entry_points,
            "tests": tests,
            "total": len(entry_points) + len(tests),
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to find entry points: {e}"}


@action
def call_tree(path: str = "", symbol_id: str = "", max_depth: int = 4) -> dict:
    """Return a recursive callee tree from a given symbol.

    Each node has {id, name, kind, module, line}. Children are callees.
    Visited set prevents infinite loops on cycles. Max depth prevents runaway.
    """
    try:
        root = _safe_path(path) if path else HOME
        index = _load_full_symbol_index(root)
        if index is None:
            return {"error": "No symbol index. Build it first."}
        sym_by_id = {s["id"]: s for s in index["symbols"]}
        visited = set()
        max_depth = max(1, min(int(max_depth), 8))

        def build_node(sid, depth):
            if sid in visited or depth > max_depth:
                return None
            visited.add(sid)
            s = sym_by_id.get(sid)
            if not s:
                return None
            children = []
            for callee_id in s.get("callees", []):
                child = build_node(callee_id, depth + 1)
                if child:
                    children.append(child)
                elif callee_id not in visited:
                    # Unvisited but hit depth limit — show as stub
                    t = sym_by_id.get(callee_id)
                    if t:
                        children.append({
                            "id": t["id"], "name": t["name"], "kind": t["kind"],
                            "module": t["module"], "line": t["line"],
                            "children": [], "truncated": True,
                        })
            return {
                "id": s["id"], "name": s["name"], "kind": s["kind"],
                "module": s["module"], "line": s["line"],
                "size": s.get("size", 0),
                "children": children,
            }

        tree = build_node(symbol_id, 0)
        if tree is None:
            return {"error": f"Symbol not found: {symbol_id}"}
        return {"tree": tree, "visited": len(visited)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Failed to build call tree: {e}"}


@action
def symbol_status(path: str = "") -> dict:
    """Report whether a cached symbol index exists for a repo root."""
    try:
        root = _safe_path(path) if path else HOME
        cache = _symbols_cache_path(root)
        if not cache.exists():
            return {"exists": False}
        stat = cache.stat()
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        return {
            "exists": True,
            "modified": stat.st_mtime,
            "file_count": data.get("file_count", 0),
            "symbol_count": data.get("symbol_count", 0),
            "root": str(root),
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
OLLAMA_BATCH = 64


def _ollama_embedding_fn():
    """Embed via a local Ollama instance, if one is running with a text
    embedding model. Preferred because it needs no extra Python packages."""
    import urllib.request

    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=3) as response:
            tags = json.loads(response.read())
    except Exception:
        return None, ""
    names = [m.get("name", "") for m in tags.get("models", [])]
    model = next((n for n in names if "embed" in n.lower()), "")
    if not model:
        return None, ""

    def embed(texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), OLLAMA_BATCH):
            payload = json.dumps(
                {"model": model, "input": texts[start:start + OLLAMA_BATCH]}
            ).encode()
            request = urllib.request.Request(
                f"{OLLAMA_URL}/api/embed", data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=300) as response:
                vectors += json.loads(response.read())["embeddings"]
        return vectors

    return embed, f"ollama:{model}"


def _embedding_fn() -> tuple:
    """Return (embed callable, description), or (None, "") if nothing is
    available.

    Ollama first because it needs no install, then fastembed, which runs on
    CPU via onnxruntime. Absence is reported to the caller rather than being
    swallowed: a feature that is switched off should not look like one that is
    broken.
    """
    embed, label = _ollama_embedding_fn()
    if embed is not None:
        return embed, label
    try:
        from fastembed import TextEmbedding
        model = TextEmbedding("BAAI/bge-small-en-v1.5")
    except Exception:
        return None, ""
    return (lambda texts: [list(v) for v in model.embed(texts)]), "fastembed:bge-small"


@action
def review(
    path: str = "",
    base: str = "HEAD",
    target: str = "working",
) -> dict:
    """Report what a change reused and which named tests exercise it."""
    try:
        root = _safe_path(path) if path else HOME
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}
        return review_mod.analyze_repo(
            root, base=base, target=target, embed_fn=_embedding_fn()[0],
        )
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Review check failed: {e}"}



WORKSPACE_SCAN_DEPTH = 3
WORKSPACE_SCAN_CAP = 4000


def _score_workspace(name: str, query: str) -> int:
    """Rank a candidate folder against a query. Higher is better, 0 excludes."""
    if not query:
        return 1
    name_lower = name.lower()
    if name_lower == query:
        return 100
    if name_lower.startswith(query):
        return 80
    if query in name_lower:
        return 60
    # subsequence match, so "cide" finds "code-ide"
    position = 0
    for char in query:
        position = name_lower.find(char, position) + 1
        if position == 0:
            return 0
    return 30


@action
def list_workspaces(query: str = "", limit: int = 60) -> dict:
    """Folders under home that can be opened as a workspace.

    Repositories sort first because most of the app's git-aware views need
    one, but a plain directory is still a valid workspace. Directories inside
    a repository are included too: in a monorepo each project is its own
    workspace.
    """
    try:
        query = query.strip().lower()
        results = []
        scanned = 0
        stack = [(HOME, 0)]
        while stack and scanned < WORKSPACE_SCAN_CAP:
            current, depth = stack.pop()
            try:
                entries = list(os.scandir(current))
            except OSError:
                continue
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                if entry.name.startswith('.') or entry.name in SEARCH_IGNORED_DIRS:
                    continue
                scanned += 1
                folder = Path(entry.path)
                score = _score_workspace(entry.name, query)
                if score:
                    results.append({
                        "path": str(folder),
                        "name": entry.name,
                        "parent": str(folder.parent),
                        "is_repo": (folder / ".git").exists(),
                        "score": score,
                    })
                if depth + 1 < WORKSPACE_SCAN_DEPTH:
                    stack.append((folder, depth + 1))

        results.sort(key=lambda r: (-r["score"], not r["is_repo"], r["name"].lower()))
        return {
            "workspaces": results[:limit],
            "count": len(results),
            "truncated": len(results) > limit,
            "home": str(HOME),
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"Could not list workspaces: {e}"}


@action
def review_status(path: str = "") -> dict:
    """Workspace/repository relationship plus refs for the base/target pickers."""
    try:
        root = _safe_path(path) if path else HOME
        scope = review_mod.workspace_scope(root)
        if not scope["is_repo"]:
            return scope
        return {**scope, **review_mod.git_refs(root)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


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
