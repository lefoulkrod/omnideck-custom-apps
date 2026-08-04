"""Sticky Wiki — a personal wiki of markdown pages.

Inspired by Andrej Karpathy's LLM Wiki pattern: plain markdown files
stored on disk, browsable and editable through a web UI, with wiki-style
[[links]] between pages.
"""

import os
import re
import json
import time
import hashlib
from pathlib import Path
from datetime import datetime, timezone

from custom_apps import action

# ── paths ──────────────────────────────────────────────────────────────

APP_DIR = Path(__file__).parent.resolve()
DATA_DIR = APP_DIR / "data"
PAGES_DIR = DATA_DIR / "pages"
HISTORY_DIR = DATA_DIR / "history"

PAGES_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_DIR.mkdir(parents=True, exist_ok=True)

INDEX_PATH = DATA_DIR / "index.md"
LOG_PATH = DATA_DIR / "log.md"


# ── helpers ───────────────────────────────────────────────────────────

def slugify(name: str) -> str:
    """Turn a page title into a URL-safe slug."""
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s or "untitled"


def page_path(slug: str) -> Path:
    return PAGES_DIR / f"{slug}.md"


def list_pages() -> list[dict]:
    """Return all pages sorted by last-modified (newest first)."""
    pages = []
    for f in sorted(PAGES_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        slug = f.stem
        title = guess_title(f, slug)
        summary = guess_summary(f)
        pages.append({
            "slug": slug,
            "title": title,
            "summary": summary,
            "updated": datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat(),
            "word_count": count_words(f),
        })
    return pages


def guess_title(path: Path, fallback: str) -> str:
    """Read the first # heading as the title."""
    content = path.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    return m.group(1).strip() if m else fallback.replace("-", " ").title()


def guess_summary(path: Path) -> str:
    """Read the first paragraph after the title as a summary."""
    content = path.read_text(encoding="utf-8", errors="replace")
    # skip frontmatter / title lines
    lines = content.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("# "):
            # look at next non-empty, non-heading line
            for j in range(i + 1, min(i + 10, len(lines))):
                l = lines[j].strip()
                if l and not l.startswith("#") and not l.startswith("---"):
                    return l[:200]
    return ""


def count_words(path: Path) -> int:
    content = path.read_text(encoding="utf-8", errors="replace")
    return len(content.split())


def render_markdown(text: str) -> str:
    """Convert markdown to HTML, handling [[wiki links]], tables, links, etc."""
    # ── protect fenced code blocks from other processing ──
    fenced_blocks = []
    def _save_fenced(m):
        fenced_blocks.append(m.group(0))
        return f"\x00FENCED{len(fenced_blocks)-1}\x00"

    text = re.sub(r"```.*?```", _save_fenced, text, flags=re.DOTALL)

    # ── escape HTML (but not inside fenced placeholders) ──
    def _escape(s):
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    parts = re.split(r"(\x00FENCED\d+\x00)", text)
    text = "".join(
        _escape(p) if not p.startswith("\x00FENCED") else p
        for p in parts
    )

    # ── inline code `code` (before other inline processing) ──
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)

    # ── wiki links [[Page Name]] or [[Page Name|display text]] ──
    def _wiki_link(m):
        target = m.group(1)
        display = m.group(2) if m.group(2) else target
        target_slug = slugify(target)
        exists = page_path(target_slug).exists()
        cls = "wiki-link" if exists else "wiki-link wiki-link-missing"
        return f'<a href="#/page/{target_slug}" class="{cls}">{display}</a>'

    text = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", _wiki_link, text)

    # ── images ![alt](url) ──
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<img src="\2" alt="\1" style="max-width:100%">', text)

    # ── links [text](url) ──
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)

    # ── headings ──
    text = re.sub(r"^### (.+)$", r"<h3>\1</h3>", text, flags=re.MULTILINE)
    text = re.sub(r"^## (.+)$", r"<h2>\1</h2>", text, flags=re.MULTILINE)
    text = re.sub(r"^# (.+)$", r"<h1>\1</h1>", text, flags=re.MULTILINE)

    # ── bold / italic ──
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)

    # ── horizontal rules ──
    text = re.sub(r"^---$", r"<hr>", text, flags=re.MULTILINE)

    # ── blockquotes ──
    lines = text.splitlines()
    in_bq = False
    out = []
    for line in lines:
        bq_match = re.match(r"^>\s?(.*)$", line)
        if bq_match:
            if not in_bq:
                out.append("<blockquote>")
                in_bq = True
            out.append(bq_match.group(1))
        else:
            if in_bq:
                out.append("</blockquote>")
                in_bq = False
            out.append(line)
    if in_bq:
        out.append("</blockquote>")
    text = "\n".join(out)

    # ── tables ──
    table_lines = []
    i = 0
    lines = text.splitlines()
    while i < len(lines):
        if re.match(r"^\|.+\|$", lines[i]) and i + 2 < len(lines) and re.match(r"^\|[-:| ]+\|$", lines[i+1]):
            rows = []
            header_cells = [c.strip() for c in lines[i].strip("|").split("|")]
            rows.append("<thead><tr>" + "".join(f"<th>{c}</th>" for c in header_cells) + "</tr></thead>")
            i += 2
            rows.append("<tbody>")
            while i < len(lines) and re.match(r"^\|.+\|$", lines[i]):
                cells = [c.strip() for c in lines[i].strip("|").split("|")]
                rows.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
                i += 1
            rows.append("</tbody>")
            table_lines.append("<table>" + "".join(rows) + "</table>")
        else:
            table_lines.append(lines[i])
            i += 1
    text = "\n".join(table_lines)

    # ── unordered lists ──
    lines = text.splitlines()
    in_list = False
    out = []
    for line in lines:
        if re.match(r"^\s*[-*]\s+", line):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{re.sub(r'^\s*[-*]\s+', '', line)}</li>")
        else:
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append(line)
    if in_list:
        out.append("</ul>")
    text = "\n".join(out)

    # ── ordered lists ──
    lines = text.splitlines()
    in_list = False
    out = []
    for line in lines:
        if re.match(r"^\s*\d+\.\s+", line):
            if not in_list:
                out.append("<ol>")
                in_list = True
            out.append(f"<li>{re.sub(r'^\s*\d+\.\s+', '', line)}</li>")
        else:
            if in_list:
                out.append("</ol>")
                in_list = False
            out.append(line)
    if in_list:
        out.append("</ol>")
    text = "\n".join(out)

    # ── restore fenced code blocks ──
    def _restore_fenced(m):
        idx = int(m.group(1))
        if idx < len(fenced_blocks):
            raw = fenced_blocks[idx]
            # extract language and content
            m2 = re.match(r"```(\w*)\n(.*?)```", raw, flags=re.DOTALL)
            if m2:
                lang = m2.group(1)
                content = m2.group(2).strip()
                if lang:
                    return f'<pre><code class="language-{lang}">{content}</code></pre>'
                return f"<pre><code>{content}</code></pre>"
        return m.group(0)

    text = re.sub(r"\x00FENCED(\d+)\x00", _restore_fenced, text)

    # ── paragraphs: double newlines become <p> ──
    paragraphs = re.split(r"\n\n+", text)
    text = "".join(
        f"<p>{p.strip()}</p>" if not p.strip().startswith(("<h", "<ul", "<ol", "<pre", "<hr", "<blockquote", "<table", "<p", "<li")) else p
        for p in paragraphs
        if p.strip()
    )

    return text


def save_history(slug: str, content: str):
    """Save a versioned copy of the page content."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    hpath = HISTORY_DIR / slug
    hpath.mkdir(parents=True, exist_ok=True)
    (hpath / f"{ts}.md").write_text(content, encoding="utf-8")


def regenerate_index():
    """Rebuild index.md — a catalog of all pages with summaries."""
    pages = list_pages()
    lines = [
        "# Wiki Index",
        "",
        "Auto-generated catalog of all pages. Updated on every change.",
        "",
        f"_{len(pages)} pages_",
        "",
        "| Page | Summary | Words |",
        "|------|---------|-------|",
    ]
    for p in pages:
        summary = p.get("summary", "")[:80].replace("|", "\\|")
        title = p["title"].replace("|", "\\|")
        lines.append(f"| [[{p['title']}]] | {summary} | {p['word_count']} |")
    lines.append("")
    INDEX_PATH.write_text("\n".join(lines), encoding="utf-8")


def append_log(entry: str):
    """Append a timestamped entry to log.md."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    line = f"\n## [{ts}] {entry}"
    if LOG_PATH.exists():
        existing = LOG_PATH.read_text(encoding="utf-8", errors="replace")
        # keep the header, append new entry at top
        content = existing + line
    else:
        content = f"# Wiki Log\n\nChronological record of changes.\n{line}"
    LOG_PATH.write_text(content, encoding="utf-8")


# ── actions ───────────────────────────────────────────────────────────

@action
def list_all_pages() -> list[dict]:
    """Return all wiki pages with metadata."""
    return list_pages()


@action
def get_page(slug: str) -> dict | None:
    """Get a single page by slug. Returns None if not found."""
    path = page_path(slug)
    if not path.exists():
        return None
    content = path.read_text(encoding="utf-8", errors="replace")
    html = render_markdown(content)
    return {
        "slug": slug,
        "title": guess_title(path, slug),
        "content": content,
        "html": html,
        "updated": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(),
        "word_count": count_words(path),
    }


@action
def create_page(title: str, content: str = "") -> dict:
    """Create a new wiki page. Returns the page info."""
    slug = slugify(title)
    path = page_path(slug)
    if path.exists():
        return {"error": f"Page '{title}' already exists.", "slug": slug}
    # ensure title heading
    if not content.strip().startswith("# "):
        content = f"# {title}\n\n{content}"
    path.write_text(content, encoding="utf-8")
    save_history(slug, content)
    regenerate_index()
    append_log(f"Created page: [[{title}]]")
    return get_page(slug)


@action
def update_page(slug: str, content: str) -> dict:
    """Update an existing page. Returns the updated page info."""
    path = page_path(slug)
    if not path.exists():
        return {"error": f"Page '{slug}' not found."}
    old_content = path.read_text(encoding="utf-8", errors="replace")
    save_history(slug, old_content)
    path.write_text(content, encoding="utf-8")
    regenerate_index()
    # extract title for the log
    title = guess_title(path, slug)
    append_log(f"Updated page: [[{title}]]")
    return get_page(slug)


@action
def delete_page(slug: str) -> dict:
    """Delete a page permanently."""
    path = page_path(slug)
    if not path.exists():
        return {"error": f"Page '{slug}' not found."}
    title = guess_title(path, slug)
    path.unlink()
    regenerate_index()
    append_log(f"Deleted page: {title}")
    return {"deleted": slug}


@action
def search_pages(query: str) -> list[dict]:
    """Full-text search across all wiki pages."""
    results = []
    q = query.lower()
    for f in sorted(PAGES_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        content = f.read_text(encoding="utf-8", errors="replace")
        if q in content.lower():
            slug = f.stem
            title = guess_title(f, slug)
            # find the matching snippet
            idx = content.lower().find(q)
            start = max(0, idx - 60)
            end = min(len(content), idx + len(q) + 60)
            snippet = content[start:end].strip()
            results.append({
                "slug": slug,
                "title": title,
                "snippet": snippet,
                "updated": datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat(),
            })
    return results


@action
def get_page_history(slug: str) -> list[dict]:
    """List all historical versions of a page."""
    hpath = HISTORY_DIR / slug
    if not hpath.exists():
        return []
    versions = []
    for f in sorted(hpath.glob("*.md"), reverse=True):
        ts_str = f.stem  # YYYYMMDDTHHMMSS
        try:
            dt = datetime.strptime(ts_str, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            dt = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
        versions.append({
            "timestamp": dt.isoformat(),
            "size": f.stat().st_size,
        })
    return versions


@action
def get_page_version(slug: str, timestamp: str) -> dict | None:
    """Get a specific historical version of a page."""
    # timestamp is like "20260406T120000"
    hpath = HISTORY_DIR / slug / f"{timestamp}.md"
    if not hpath.exists():
        return None
    content = hpath.read_text(encoding="utf-8", errors="replace")
    return {
        "slug": slug,
        "content": content,
        "html": render_markdown(content),
        "timestamp": timestamp,
    }


@action
def get_backlinks(slug: str) -> list[dict]:
    """Find all pages that link to the given slug."""
    results = []
    target = slugify(slug)
    for f in PAGES_DIR.glob("*.md"):
        content = f.read_text(encoding="utf-8", errors="replace")
        # look for [[Title]] or [[Title|display]] where slug matches
        for m in re.finditer(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", content):
            linked_slug = slugify(m.group(1))
            if linked_slug == target:
                fs = f.stem
                results.append({
                    "slug": fs,
                    "title": guess_title(f, fs),
                })
                break
    return results


@action
def get_graph_data() -> dict:
    """Return nodes and edges for the wiki graph visualization.

    Nodes = all pages. Edges = [[wiki links]] between existing pages.
    """
    nodes = []
    edges = []
    slug_map = {}  # slug -> index in nodes list

    for f in sorted(PAGES_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime):
        slug = f.stem
        title = guess_title(f, slug)
        wc = count_words(f)
        slug_map[slug] = len(nodes)
        nodes.append({
            "id": slug,
            "title": title,
            "word_count": wc,
            "group": 1,
        })

    # Build edges from wiki links — use string IDs for D3 force layout
    for f in PAGES_DIR.glob("*.md"):
        content = f.read_text(encoding="utf-8", errors="replace")
        source_slug = f.stem
        if source_slug not in slug_map:
            continue
        seen_targets = set()
        for m in re.finditer(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", content):
            target_slug = slugify(m.group(1))
            if target_slug in slug_map and target_slug not in seen_targets:
                seen_targets.add(target_slug)
                edges.append({
                    "source": source_slug,
                    "target": target_slug,
                })

    return {"nodes": nodes, "edges": edges}


@action
def get_schema() -> str:
    """Return the SCHEMA.md file contents — agent instructions for this wiki."""
    schema_path = DATA_DIR / "SCHEMA.md"
    if schema_path.exists():
        return schema_path.read_text(encoding="utf-8")
    return "No SCHEMA.md found."


@action
def get_index() -> str:
    """Return the index.md file contents — catalog of all pages."""
    if INDEX_PATH.exists():
        return INDEX_PATH.read_text(encoding="utf-8")
    return "No index.md found. Run rebuild_index() first."


@action
def get_log() -> str:
    """Return the log.md file contents — chronological record."""
    if LOG_PATH.exists():
        return LOG_PATH.read_text(encoding="utf-8")
    return "No log.md found."


@action
def rebuild_index() -> dict:
    """Manually trigger a rebuild of index.md."""
    regenerate_index()
    return {"ok": True, "path": str(INDEX_PATH)}


@action
def get_stats() -> dict:
    """Get wiki statistics."""
    pages = list_pages()
    total_words = sum(p.get("word_count", 0) for p in pages)
    # count total wiki links
    total_links = 0
    broken_links = 0
    for f in PAGES_DIR.glob("*.md"):
        content = f.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", content):
            total_links += 1
            target_slug = slugify(m.group(1))
            if not page_path(target_slug).exists():
                broken_links += 1
    return {
        "page_count": len(pages),
        "total_words": total_words,
        "total_links": total_links,
        "broken_links": broken_links,
    }
