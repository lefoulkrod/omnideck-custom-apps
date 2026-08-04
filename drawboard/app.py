"""
Drawboard backend — collaborative drawing whiteboard.
Both the user (via the frontend) and the AI agent (via chat) can add shapes.
"""

import json
import os
import time
import uuid
from custom_apps import action

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
CANVAS_FILE = os.path.join(DATA_DIR, "canvas.json")
SAVED_DIR = os.path.join(DATA_DIR, "saved")


def _ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(SAVED_DIR, exist_ok=True)


def _load_canvas():
    _ensure_data_dir()
    if os.path.exists(CANVAS_FILE):
        try:
            with open(CANVAS_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return []
    return []


def _save_canvas(shapes):
    _ensure_data_dir()
    with open(CANVAS_FILE, "w") as f:
        json.dump(shapes, f, indent=2)


@action
def get_canvas():
    """Return the current canvas state (list of shapes)."""
    return {"shapes": _load_canvas(), "timestamp": time.time()}


@action
def save_canvas(shapes: list):
    """Save the full canvas state (called by frontend on user edits)."""
    _save_canvas(shapes)
    return {"ok": True, "count": len(shapes)}


@action
def add_shapes(shapes: list):
    """
    Append shapes to the canvas. Used by the AI agent to draw.
    Each shape dict can omit id/timestamp/createdBy — they'll be filled in.
    Returns the updated canvas.
    """
    current = _load_canvas()
    now = time.time()
    for s in shapes:
        if "id" not in s:
            s["id"] = str(uuid.uuid4())
        if "timestamp" not in s:
            s["timestamp"] = now
        if "createdBy" not in s:
            s["createdBy"] = "agent"
        current.append(s)
    _save_canvas(current)
    return {"ok": True, "added": len(shapes), "total": len(current), "shapes": current}


@action
def clear_canvas():
    """Remove all shapes from the canvas."""
    _save_canvas([])
    return {"ok": True}


@action
def delete_shapes(ids: list):
    """Remove shapes by their IDs."""
    current = _load_canvas()
    id_set = set(ids)
    remaining = [s for s in current if s.get("id") not in id_set]
    _save_canvas(remaining)
    return {"ok": True, "removed": len(current) - len(remaining), "total": len(remaining)}


@action
def agent_draw(description: str):
    """
    High-level drawing command. The agent describes what to draw in plain text,
    and this action generates the appropriate shapes.

    Supports simple patterns:
    - "box: label" → a rectangle with text
    - "flowchart: A->B->C" → connected boxes with arrows
    - "circle: label" → an ellipse with text
    - "text: content at x,y" → a text element
    - "line: x1,y1 to x2,y2" → a line
    - "arrow: x1,y1 to x2,y2" → an arrow

    For complex diagrams, the agent should call add_shapes directly with
    computed coordinates.
    """
    shapes = []
    desc = description.strip()
    now = time.time()

    if desc.startswith("flowchart:"):
        # Parse "A->B->C" or "A->B, B->C"
        body = desc[len("flowchart:"):].strip()
        # Split on arrows
        parts = body.split("->")
        parts = [p.strip() for p in parts if p.strip()]

        box_w, box_h = 160, 60
        gap = 80
        start_x, start_y = 100, 200

        for i, label in enumerate(parts):
            x = start_x + i * (box_w + gap)
            y = start_y
            shapes.append({
                "type": "rectangle",
                "x": x, "y": y,
                "width": box_w, "height": box_h,
                "stroke": "#1e1e1e",
                "fill": "#ffffff",
                "strokeWidth": 2,
                "text": label,
                "fontSize": 16,
            })
            if i > 0:
                prev_right = x - gap  # right edge of previous box
                shapes.append({
                    "type": "arrow",
                    "points": [[prev_right, y + box_h / 2],
                               [x, y + box_h / 2]],
                    "stroke": "#1e1e1e",
                    "strokeWidth": 2,
                })

    elif desc.startswith("box:"):
        label = desc[len("box:"):].strip()
        shapes.append({
            "type": "rectangle",
            "x": 200, "y": 200,
            "width": 180, "height": 60,
            "stroke": "#1e1e1e",
            "fill": "#ffffff",
            "strokeWidth": 2,
            "text": label,
            "fontSize": 16,
        })

    elif desc.startswith("circle:"):
        label = desc[len("circle:"):].strip()
        shapes.append({
            "type": "ellipse",
            "x": 200, "y": 200,
            "width": 140, "height": 140,
            "stroke": "#1e1e1e",
            "fill": "#ffffff",
            "strokeWidth": 2,
            "text": label,
            "fontSize": 16,
        })

    elif desc.startswith("text:"):
        rest = desc[len("text:"):].strip()
        # "content at x,y"
        if " at " in rest:
            content, coords = rest.rsplit(" at ", 1)
            try:
                x, y = [int(v.strip()) for v in coords.split(",")]
            except ValueError:
                x, y = 200, 200
        else:
            content = rest
            x, y = 200, 200
        shapes.append({
            "type": "text",
            "x": x, "y": y,
            "text": content,
            "stroke": "#1e1e1e",
            "fontSize": 20,
        })

    else:
        # Default: just draw the text
        shapes.append({
            "type": "text",
            "x": 200, "y": 200,
            "text": desc,
            "stroke": "#1e1e1e",
            "fontSize": 20,
        })

    # Add IDs and timestamps
    for s in shapes:
        s["id"] = str(uuid.uuid4())
        s["timestamp"] = now
        s["createdBy"] = "agent"

    current = _load_canvas()
    current.extend(shapes)
    _save_canvas(current)

    return {"ok": True, "added": len(shapes), "shapes": shapes, "total": len(current)}


@action
def export_svg(svg_content: str, filename: str = "drawboard-export.svg"):
    """
    Save an SVG string to the user's home directory and return the
    browser-accessible URL. This avoids insecure blob-download warnings
    that browsers show for HTTP-served pages.
    """
    import os

    home = os.path.expanduser("~")
    safe_name = os.path.basename(filename) or "drawboard-export.svg"
    if not safe_name.endswith(".svg"):
        safe_name += ".svg"
    out_path = os.path.join(home, safe_name)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(svg_content)

    # Return the URL where the file is served by Omnideck
    url = f"/home/omnideck/{safe_name}"
    return {"ok": True, "path": out_path, "url": url, "filename": safe_name}


# ============================================================
# Saved drawings — persist/load named snapshots to data/saved/
# ============================================================

def _safe_filename(name: str) -> str:
    """Sanitize a user-provided name into a safe filename (no extension)."""
    safe = "".join(c for c in name.strip() if c.isalnum() or c in "-_ ")
    safe = safe.strip().replace(" ", "-")
    return safe or "untitled"


@action
def save_drawing(name: str):
    """
    Save the current canvas state as a named snapshot in data/saved/.
    Returns the saved drawing metadata.
    """
    _ensure_data_dir()
    safe = _safe_filename(name)
    filepath = os.path.join(SAVED_DIR, f"{safe}.json")

    current = _load_canvas()
    drawing = {
        "name": safe,
        "shapes": current,
        "shape_count": len(current),
        "saved_at": time.time(),
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(drawing, f, indent=2)

    return {"ok": True, "name": safe, "shape_count": len(current), "saved_at": drawing["saved_at"]}


@action
def load_drawing(name: str):
    """
    Load a saved drawing by name. Replaces the current canvas with
    the saved shapes and returns them.
    """
    _ensure_data_dir()
    safe = _safe_filename(name)
    filepath = os.path.join(SAVED_DIR, f"{safe}.json")

    if not os.path.exists(filepath):
        return {"ok": False, "error": f"No saved drawing named '{safe}'"}

    with open(filepath, "r", encoding="utf-8") as f:
        drawing = json.load(f)

    shapes = drawing.get("shapes", [])
    # Write to the live canvas so it becomes the active state
    _save_canvas(shapes)

    return {
        "ok": True,
        "name": safe,
        "shapes": shapes,
        "shape_count": len(shapes),
        "saved_at": drawing.get("saved_at", 0),
    }


@action
def list_drawings():
    """
    Return a list of all saved drawings with metadata.
    """
    _ensure_data_dir()
    drawings = []
    for entry in os.listdir(SAVED_DIR):
        if not entry.endswith(".json"):
            continue
        filepath = os.path.join(SAVED_DIR, entry)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            drawings.append({
                "name": data.get("name", entry[:-5]),
                "shape_count": data.get("shape_count", len(data.get("shapes", []))),
                "saved_at": data.get("saved_at", 0),
            })
        except (json.JSONDecodeError, IOError):
            continue

    # Sort by most recently saved
    drawings.sort(key=lambda d: d.get("saved_at", 0), reverse=True)
    return {"ok": True, "drawings": drawings}


@action
def delete_drawing(name: str):
    """Delete a saved drawing by name."""
    _ensure_data_dir()
    safe = _safe_filename(name)
    filepath = os.path.join(SAVED_DIR, f"{safe}.json")

    if not os.path.exists(filepath):
        return {"ok": False, "error": f"No saved drawing named '{safe}'"}

    os.remove(filepath)
    return {"ok": True, "name": safe}