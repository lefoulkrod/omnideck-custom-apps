// ============================================================
// Drawboard — Collaborative SVG Drawing App
// ============================================================

const SVG_NS = "http://www.w3.org/2000/svg";
const svg = document.getElementById("svg-canvas");
const viewportGroup = document.getElementById("viewport-group");
const canvasWrap = document.getElementById("canvas-wrap");

// State
let shapes = [];
let selectedIds = new Set();
let currentTool = "select";
let strokeColor = "#1e1e1e";
let fillColor = "transparent";
let strokeWidth = 2;

// View transform (pan/zoom)
let viewX = 0, viewY = 0, viewScale = 1;

// Drawing state
let isDrawing = false;
let isPanning = false;
let isDragging = false;
let drawStart = null;
let currentShape = null;
let dragStart = null;
let panStart = null;
let freehandPoints = [];

// Undo history
let history = [];
const MAX_HISTORY = 50;

// Track which agent shapes have already played their entrance animation
let animatedShapeIds = new Set();

// Sync state
let lastSyncTime = 0;
let isSyncing = false;
let knownShapeIds = new Set();
let pendingSave = false;
let saveTimer = null;

// ============================================================
// Utility
// ============================================================

function uid() {
  return 's_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2000);
}

// ============================================================
// In-app modal helpers (no native alert/confirm/prompt)
// ============================================================

function showConfirm(title, message, okLabel = "Confirm", okClass = "primary") {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-overlay");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-message").textContent = message;
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");
    okBtn.textContent = okLabel;
    okBtn.className = "modal-btn " + okClass;

    overlay.classList.add("show");

    function cleanup(result) {
      overlay.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === overlay) cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
    cancelBtn.focus();
  });
}

function showPrompt(title, message, defaultValue = "") {
  return new Promise((resolve) => {
    const overlay = document.getElementById("prompt-overlay");
    document.getElementById("prompt-title").textContent = title;
    document.getElementById("prompt-message").textContent = message;
    const input = document.getElementById("prompt-input");
    const okBtn = document.getElementById("prompt-ok");
    const cancelBtn = document.getElementById("prompt-cancel");
    input.value = defaultValue;

    overlay.classList.add("show");
    input.focus();
    input.select();

    function cleanup(result) {
      overlay.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onOverlay);
      resolve(result);
    }
    function onOk() { cleanup(input.value); }
    function onCancel() { cleanup(null); }
    function onKey(e) {
      if (e.key === "Enter") { e.preventDefault(); cleanup(input.value); }
      if (e.key === "Escape") { cleanup(null); }
    }
    function onOverlay(e) { if (e.target === overlay) cleanup(null); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onOverlay);
  });
}

// ============================================================
// Save / Load drawings
// ============================================================

async function saveDrawing() {
  if (shapes.length === 0) { toast("Nothing to save"); return; }
  const name = await showPrompt("Save Drawing", "Enter a name for this drawing:", "");
  if (!name || !name.trim()) return;
  try {
    const result = await apiInvoke("save_drawing", { name: name.trim() });
    if (result.ok) {
      toast(`Saved "${result.name}" (${result.shape_count} shapes)`);
    } else {
      toast("Save failed");
    }
  } catch (e) {
    toast("Save failed: " + e.message);
  }
}

async function openLoadDialog() {
  const overlay = document.getElementById("load-overlay");
  const list = document.getElementById("load-dialog-list");
  const closeBtn = document.getElementById("load-dialog-close");

  list.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center">Loading...</div>';
  overlay.classList.add("show");

  try {
    const result = await apiInvoke("list_drawings", {});
    const drawings = result.drawings || [];

    if (drawings.length === 0) {
      list.innerHTML = '<div id="load-dialog-empty">No saved drawings yet</div>';
      return;
    }

    list.innerHTML = "";
    drawings.forEach(d => {
      const item = document.createElement("div");
      item.className = "load-item";

      const date = new Date(d.saved_at * 1000);
      const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      const info = document.createElement("div");
      info.className = "load-item-info";
      info.innerHTML = `<div class="load-item-name">${d.name}</div><div class="load-item-meta">${d.shape_count} shapes · ${dateStr}</div>`;
      item.appendChild(info);

      const delBtn = document.createElement("button");
      delBtn.className = "load-item-delete";
      delBtn.innerHTML = '<i class="bi bi-trash"></i>';
      delBtn.title = "Delete";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirm("Delete Drawing", `Delete "${d.name}"? This cannot be undone.`, "Delete", "danger");
        if (!confirmed) return;
        try {
          await apiInvoke("delete_drawing", { name: d.name });
          toast(`Deleted "${d.name}"`);
          openLoadDialog(); // refresh list
        } catch (err) { toast("Delete failed"); }
      });
      item.appendChild(delBtn);

      item.addEventListener("click", async () => {
        try {
          const loaded = await apiInvoke("load_drawing", { name: d.name });
          if (loaded.ok) {
            shapes = loaded.shapes || [];
            animatedShapeIds = new Set(shapes.map(s => s.id));
            selectedIds.clear();
            renderAll();
            overlay.classList.remove("show");
            toast(`Loaded "${d.name}" (${loaded.shape_count} shapes)`);
          }
        } catch (e) { toast("Load failed"); }
      });

      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = '<div id="load-dialog-empty">Failed to load drawings</div>';
  }
}

function screenToWorld(sx, sy) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (sx - rect.left - viewX) / viewScale,
    y: (sy - rect.top - viewY) / viewScale
  };
}

function updateViewport() {
  viewportGroup.setAttribute("transform", `translate(${viewX} ${viewY}) scale(${viewScale})`);
  document.getElementById("zoom-level").textContent = Math.round(viewScale * 100) + "%";
}

// ============================================================
// Shape Rendering
// ============================================================

function renderShape(s) {
  const g = document.createElementNS(SVG_NS, "g");
  const isAgentNew = s.createdBy === "agent" && !animatedShapeIds.has(s.id);
  if (isAgentNew) animatedShapeIds.add(s.id);
  g.setAttribute("class", "shape" + (selectedIds.has(s.id) ? " selected" : "") + (isAgentNew ? " agent-shape" : ""));
  g.setAttribute("data-id", s.id);

  const sw = s.strokeWidth || 2;
  const stroke = s.stroke || "#1e1e1e";
  const fill = s.fill || "transparent";

  switch (s.type) {
    case "rectangle": {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", s.x);
      rect.setAttribute("y", s.y);
      rect.setAttribute("width", Math.max(1, s.width));
      rect.setAttribute("height", Math.max(1, s.height));
      rect.setAttribute("rx", 4);
      rect.setAttribute("stroke", stroke);
      rect.setAttribute("stroke-width", sw);
      rect.setAttribute("fill", fill);
      g.appendChild(rect);
      if (s.text) addTextToGroup(g, s);
      break;
    }
    case "ellipse": {
      const ell = document.createElementNS(SVG_NS, "ellipse");
      ell.setAttribute("cx", s.x + s.width / 2);
      ell.setAttribute("cy", s.y + s.height / 2);
      ell.setAttribute("rx", Math.max(1, s.width / 2));
      ell.setAttribute("ry", Math.max(1, s.height / 2));
      ell.setAttribute("stroke", stroke);
      ell.setAttribute("stroke-width", sw);
      ell.setAttribute("fill", fill);
      g.appendChild(ell);
      if (s.text) addTextToGroup(g, s);
      break;
    }
    case "diamond": {
      const cx = s.x + s.width / 2;
      const cy = s.y + s.height / 2;
      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("points",
        `${cx},${s.y} ${s.x + s.width},${cy} ${cx},${s.y + s.height} ${s.x},${cy}`);
      poly.setAttribute("stroke", stroke);
      poly.setAttribute("stroke-width", sw);
      poly.setAttribute("fill", fill);
      g.appendChild(poly);
      if (s.text) addTextToGroup(g, s);
      break;
    }
    case "line": {
      const pts = s.points || [[s.x, s.y], [s.x + s.width, s.y + s.height]];
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", pts[0][0]);
      line.setAttribute("y1", pts[0][1]);
      line.setAttribute("x2", pts[1][0]);
      line.setAttribute("y2", pts[1][1]);
      line.setAttribute("stroke", stroke);
      line.setAttribute("stroke-width", sw);
      line.setAttribute("stroke-linecap", "round");
      g.appendChild(line);
      break;
    }
    case "arrow": {
      const pts = s.points || [[s.x, s.y], [s.x + s.width, s.y + s.height]];
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", pts[0][0]);
      line.setAttribute("y1", pts[0][1]);
      line.setAttribute("x2", pts[1][0]);
      line.setAttribute("y2", pts[1][1]);
      line.setAttribute("stroke", stroke);
      line.setAttribute("stroke-width", sw);
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("marker-end", "url(#arrowhead)");
      line.style.color = stroke;
      g.appendChild(line);
      break;
    }
    case "text": {
      const tx = document.createElementNS(SVG_NS, "text");
      tx.setAttribute("x", s.x);
      tx.setAttribute("y", s.y + (s.fontSize || 20));
      tx.setAttribute("fill", stroke);
      tx.setAttribute("font-size", s.fontSize || 20);
      tx.setAttribute("font-family", "Virgil, Segoe UI, sans-serif");
      tx.style.cursor = "text";
      // Support multi-line
      const lines = (s.text || "").split("\n");
      lines.forEach((line, i) => {
        const tspan = document.createElementNS(SVG_NS, "tspan");
        tspan.setAttribute("x", s.x);
        tspan.setAttribute("dy", i === 0 ? 0 : (s.fontSize || 20) * 1.2);
        tspan.textContent = line;
        tx.appendChild(tspan);
      });
      g.appendChild(tx);
      break;
    }
    case "freehand": {
      if (!s.points || s.points.length < 2) break;
      const path = document.createElementNS(SVG_NS, "path");
      let d = `M ${s.points[0][0]} ${s.points[0][1]}`;
      for (let i = 1; i < s.points.length; i++) {
        d += ` L ${s.points[i][0]} ${s.points[i][1]}`;
      }
      path.setAttribute("d", d);
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", sw);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      g.appendChild(path);
      break;
    }
  }

  return g;
}

function addTextToGroup(g, s) {
  if (!s.text) return;
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const fs = s.fontSize || 16;
  const tx = document.createElementNS(SVG_NS, "text");
  tx.setAttribute("x", cx);
  tx.setAttribute("y", cy);
  tx.setAttribute("text-anchor", "middle");
  tx.setAttribute("dominant-baseline", "central");
  tx.setAttribute("fill", s.stroke || "#1e1e1e");
  tx.setAttribute("font-size", fs);
  tx.setAttribute("font-family", "Segoe UI, sans-serif");
  tx.style.pointerEvents = "none";
  const lines = s.text.split("\n");
  lines.forEach((line, i) => {
    const tspan = document.createElementNS(SVG_NS, "tspan");
    tspan.setAttribute("x", cx);
    tspan.setAttribute("dy", i === 0 ? -(lines.length - 1) * fs * 0.6 : fs * 1.2);
    tspan.textContent = line;
    tx.appendChild(tspan);
  });
  g.appendChild(tx);
}

function renderAll() {
  viewportGroup.innerHTML = "";
  shapes.forEach(s => {
    const el = renderShape(s);
    if (el) viewportGroup.appendChild(el);
  });
  renderSelectionHandles();
  document.getElementById("shape-count").textContent = shapes.length + " shapes";
}

function renderSelectionHandles() {
  // Remove old handles
  viewportGroup.querySelectorAll(".handle").forEach(h => h.remove());
  if (selectedIds.size !== 1) return;
  const s = shapes.find(sh => selectedIds.has(sh.id));
  if (!s) return;

  // Bounding box
  let bx, by, bw, bh;
  if (s.type === "line" || s.type === "arrow" || s.type === "freehand") {
    const pts = s.points || [];
    if (pts.length === 0) return;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    bx = Math.min(...xs) - 4; by = Math.min(...ys) - 4;
    bw = Math.max(...xs) - Math.min(...xs) + 8;
    bh = Math.max(...ys) - Math.min(...ys) + 8;
  } else {
    bx = s.x - 4; by = s.y - 4;
    bw = (s.width || 0) + 8; bh = (s.height || 0) + 8;
  }

  const handles = [
    [bx, by], [bx + bw / 2, by], [bx + bw, by],
    [bx + bw, by + bh / 2], [bx + bw, by + bh],
    [bx + bw / 2, by + bh], [bx, by + bh], [bx, by + bh / 2]
  ];
  handles.forEach(([hx, hy]) => {
    const h = document.createElementNS(SVG_NS, "rect");
    h.setAttribute("class", "handle");
    h.setAttribute("x", hx - 4);
    h.setAttribute("y", hy - 4);
    h.setAttribute("width", 8);
    h.setAttribute("height", 8);
    h.setAttribute("rx", 2);
    viewportGroup.appendChild(h);
  });
}

// ============================================================
// Drawing Logic
// ============================================================

function startDraw(wx, wy) {
  isDrawing = true;
  drawStart = { x: wx, y: wy };

  if (currentTool === "freehand") {
    freehandPoints = [[wx, wy]];
    currentShape = {
      id: uid(),
      type: "freehand",
      points: [[wx, wy]],
      stroke: strokeColor,
      strokeWidth: strokeWidth,
      createdBy: "user"
    };
  } else if (currentTool === "text") {
    // Create text via inline editor
    isDrawing = false;
    createTextEditor(wx, wy);
    return;
  } else {
    const type = currentTool;
    currentShape = {
      id: uid(),
      type: type,
      x: wx, y: wy,
      width: 0, height: 0,
      stroke: strokeColor,
      fill: fillColor,
      strokeWidth: strokeWidth,
      createdBy: "user"
    };
    if (type === "line" || type === "arrow") {
      currentShape.points = [[wx, wy], [wx, wy]];
    }
  }
  if (currentShape) shapes.push(currentShape);
  renderAll();
}

function updateDraw(wx, wy) {
  if (!isDrawing || !currentShape) return;

  if (currentShape.type === "freehand") {
    freehandPoints.push([wx, wy]);
    currentShape.points = freehandPoints;
  } else if (currentShape.type === "line" || currentShape.type === "arrow") {
    currentShape.points = [[drawStart.x, drawStart.y], [wx, wy]];
  } else {
    currentShape.x = Math.min(drawStart.x, wx);
    currentShape.y = Math.min(drawStart.y, wy);
    currentShape.width = Math.abs(wx - drawStart.x);
    currentShape.height = Math.abs(wy - drawStart.y);
  }
  renderAll();
}

function endDraw() {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentShape) {
    // Don't keep zero-size shapes (except freehand/text)
    if (currentShape.type !== "freehand" && currentShape.type !== "text") {
      if (currentShape.type === "line" || currentShape.type === "arrow") {
        const pts = currentShape.points;
        if (pts && Math.abs(pts[0][0] - pts[1][0]) < 3 && Math.abs(pts[0][1] - pts[1][1]) < 3) {
          shapes = shapes.filter(s => s.id !== currentShape.id);
        }
      } else if (currentShape.width < 3 && currentShape.height < 3) {
        shapes = shapes.filter(s => s.id !== currentShape.id);
      }
    }
    // Auto-add text to boxes if user double-clicks later
  }

  currentShape = null;
  freehandPoints = [];
  renderAll();
  pushHistory();
  scheduleSave();
}

// ============================================================
// Text Editor
// ============================================================

function createTextEditor(wx, wy) {
  const rect = svg.getBoundingClientRect();
  const sx = wx * viewScale + viewX + rect.left;
  const sy = wy * viewScale + viewY + rect.top;

  const editor = document.createElement("textarea");
  editor.id = "text-editor";
  editor.style.left = sx + "px";
  editor.style.top = sy + "px";
  editor.style.fontSize = (20 * viewScale) + "px";
  editor.style.color = strokeColor;
  editor.rows = 1;
  editor.cols = 10;
  editor.placeholder = "Type...";
  document.body.appendChild(editor);
  editor.focus();

  function finishText() {
    const val = editor.value.trim();
    if (val) {
      shapes.push({
        id: uid(),
        type: "text",
        x: wx,
        y: wy,
        text: val,
        stroke: strokeColor,
        fontSize: 20,
        createdBy: "user"
      });
      renderAll();
      pushHistory();
      scheduleSave();
    }
    editor.remove();
  }

  editor.addEventListener("blur", finishText);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { editor.remove(); }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); editor.blur(); }
  });
  editor.addEventListener("input", () => {
    editor.style.width = "auto";
    editor.style.height = "auto";
    editor.style.width = editor.scrollWidth + "px";
    editor.style.height = editor.scrollHeight + "px";
  });
}

// ============================================================
// Selection & Manipulation
// ============================================================

function hitTest(wx, wy) {
  // Reverse order (top-most first)
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (isPointInShape(s, wx, wy)) return s;
  }
  return null;
}

function isPointInShape(s, x, y) {
  const pad = 5;
  switch (s.type) {
    case "rectangle":
    case "diamond":
    case "ellipse":
      return x >= s.x - pad && x <= s.x + (s.width || 0) + pad &&
             y >= s.y - pad && y <= s.y + (s.height || 0) + pad;
    case "text":
      return x >= s.x - pad && x <= s.x + 200 &&
             y >= s.y - pad && y <= s.y + (s.fontSize || 20) + pad;
    case "line":
    case "arrow": {
      const pts = s.points || [];
      if (pts.length < 2) return false;
      return distToSegment(x, y, pts[0][0], pts[0][1], pts[1][0], pts[1][1]) < 8;
    }
    case "freehand": {
      const pts = s.points || [];
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(x, y, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]) < 8) return true;
      }
      return false;
    }
  }
  return false;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function selectShape(id, additive) {
  if (!additive) selectedIds.clear();
  if (id) selectedIds.add(id);
  renderAll();
}

function startDrag(wx, wy) {
  if (selectedIds.size === 0) return;
  isDragging = true;
  dragStart = { x: wx, y: wy };
  // Store original positions
  dragStart.shapes = shapes
    .filter(s => selectedIds.has(s.id))
    .map(s => ({ id: s.id, x: s.x, y: s.y, points: s.points ? s.points.map(p => [...p]) : null }));
}

function updateDrag(wx, wy) {
  if (!isDragging) return;
  const dx = wx - dragStart.x;
  const dy = wy - dragStart.y;
  dragStart.shapes.forEach(orig => {
    const s = shapes.find(sh => sh.id === orig.id);
    if (!s) return;
    if (s.points) {
      s.points = orig.points.map(p => [p[0] + dx, p[1] + dy]);
    } else {
      s.x = orig.x + dx;
      s.y = orig.y + dy;
    }
  });
  renderAll();
}

function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  pushHistory();
  scheduleSave();
}

function deleteSelected() {
  if (selectedIds.size === 0) return;
  pushHistory();
  shapes = shapes.filter(s => !selectedIds.has(s.id));
  selectedIds.clear();
  renderAll();
  scheduleSave();
}

// ============================================================
// History (Undo)
// ============================================================

function pushHistory() {
  history.push(JSON.parse(JSON.stringify(shapes)));
  if (history.length > MAX_HISTORY) history.shift();
}

function undo() {
  if (history.length === 0) return;
  shapes = history.pop();
  selectedIds.clear();
  renderAll();
  scheduleSave();
}

// ============================================================
// Backend Sync
// ============================================================

// Fallback: direct API calls when not running inside the Omnideck shell
const API_BASE = "/api/custom-apps/drawboard";
async function apiInvoke(action, args) {
  if (window.omnideck && window.omnideck.invoke) {
    try {
      // Race against a timeout — if the shell doesn't respond, fall back to direct fetch
      const result = await Promise.race([
        window.omnideck.invoke(action, args),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))
      ]);
      return result;
    } catch (e) {
      // Fall through to direct fetch
    }
  }
  const resp = await fetch(`${API_BASE}/invoke/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ args: args || {} }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error?.message || "API error");
  return data.result;
}

async function loadCanvas() {
  try {
    const result = await apiInvoke("get_canvas", {});
    if (result && result.shapes) {
      shapes = result.shapes;
      knownShapeIds = new Set(shapes.map(s => s.id));
      renderAll();
    }
  } catch (e) {
    console.log("Load canvas:", e);
  }
}

async function saveCanvas() {
  if (isSyncing) return;
  isSyncing = true;
  document.getElementById("sync-dot").classList.add("syncing");
  document.getElementById("sync-text").textContent = "Saving...";
  try {
    await apiInvoke("save_canvas", { shapes: shapes });
    document.getElementById("sync-text").textContent = "Synced";
  } catch (e) {
    console.log("Save error:", e);
    document.getElementById("sync-text").textContent = "Save failed";
  }
  document.getElementById("sync-dot").classList.remove("syncing");
  isSyncing = false;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCanvas(), 800);
}

async function pollForAgentShapes() {
  try {
    const result = await apiInvoke("get_canvas", {});
    if (!result || !result.shapes) return;

    const backendShapes = result.shapes;
    const backendIds = new Set(backendShapes.map(s => s.id));
    const localIds = new Set(shapes.map(s => s.id));

    // Detect new agent shapes
    const newAgentShapes = backendShapes.filter(s =>
      !localIds.has(s.id) && s.createdBy === "agent"
    );

    // Detect shapes removed from backend (e.g., agent cleared canvas)
    const removedIds = [...localIds].filter(id => !backendIds.has(id));

    if (newAgentShapes.length > 0) {
      shapes = shapes.concat(newAgentShapes);
      renderAll();
      toast(`Agent drew ${newAgentShapes.length} shape(s)`);
    }

    if (removedIds.length > 0 && !isDrawing && !isDragging) {
      // Only remove if not actively editing
      shapes = shapes.filter(s => !removedIds.includes(s.id));
      selectedIds = new Set([...selectedIds].filter(id => !removedIds.includes(id)));
      renderAll();
    }
  } catch (e) {
    // Silent fail on poll
  }
}

// ============================================================
// Export
// ============================================================

async function exportSVG() {
  if (shapes.length === 0) { toast("Nothing to export"); return; }

  // Clone the SVG, inline styles
  const clone = svg.cloneNode(true);
  // Remove handles
  clone.querySelectorAll(".handle").forEach(h => h.remove());
  // Remove selection classes
  clone.querySelectorAll(".selected").forEach(el => el.classList.remove("selected"));

  // Calculate bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  shapes.forEach(s => {
    let x, y, w, h;
    if (s.points) {
      const xs = s.points.map(p => p[0]);
      const ys = s.points.map(p => p[1]);
      x = Math.min(...xs); y = Math.min(...ys);
      w = Math.max(...xs) - x; h = Math.max(...ys) - y;
    } else {
      x = s.x; y = s.y; w = s.width || 0; h = s.height || 0;
    }
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  });

  const pad = 20;
  clone.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`);
  clone.setAttribute("width", maxX - minX + pad * 2);
  clone.setAttribute("height", maxY - minY + pad * 2);

  const data = new XMLSerializer().serializeToString(clone);

  // Save via backend to avoid insecure blob-download warnings
  try {
    const result = await apiInvoke("export_svg", { svg_content: data, filename: "drawboard-export.svg" });
    if (result && result.url) {
      // Open the file URL in a new tab — user can save from there
      window.open(result.url, "_blank");
      toast("Exported — opened in new tab");
    }
  } catch (e) {
    // Fallback to blob download if backend fails
    const blob = new Blob([data], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "drawboard-export.svg";
    a.click();
    URL.revokeObjectURL(url);
    toast("Exported SVG (fallback)");
  }
}

// ============================================================
// Event Handlers
// ============================================================

canvasWrap.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const w = screenToWorld(e.clientX, e.clientY);

  if (currentTool === "pan") {
    isPanning = true;
    panStart = { x: e.clientX - viewX, y: e.clientY - viewY };
    canvasWrap.classList.add("panning");
    return;
  }

  if (currentTool === "select") {
    const hit = hitTest(w.x, w.y);
    if (hit) {
      if (!selectedIds.has(hit.id)) {
        selectShape(hit.id, e.shiftKey);
      }
      startDrag(w.x, w.y);
    } else {
      selectedIds.clear();
      renderAll();
    }
    return;
  }

  // Drawing tools
  startDraw(w.x, w.y);
});

canvasWrap.addEventListener("mousemove", (e) => {
  const w = screenToWorld(e.clientX, e.clientY);
  document.getElementById("cursor-pos").textContent = `${Math.round(w.x)}, ${Math.round(w.y)}`;

  if (isPanning) {
    viewX = e.clientX - panStart.x;
    viewY = e.clientY - panStart.y;
    updateViewport();
    return;
  }

  if (isDragging) { updateDrag(w.x, w.y); return; }
  if (isDrawing) { updateDraw(w.x, w.y); return; }
});

canvasWrap.addEventListener("mouseup", (e) => {
  if (isPanning) {
    isPanning = false;
    canvasWrap.classList.remove("panning");
    return;
  }
  if (isDragging) { endDrag(); return; }
  if (isDrawing) { endDraw(); return; }
});

canvasWrap.addEventListener("dblclick", async (e) => {
  const w = screenToWorld(e.clientX, e.clientY);
  const hit = hitTest(w.x, w.y);
  if (hit && (hit.type === "rectangle" || hit.type === "ellipse" || hit.type === "diamond")) {
    // Edit text in shape via in-app prompt
    const newText = await showPrompt("Edit Label", "Shape text:", hit.text || "");
    if (newText !== null) {
      hit.text = newText;
      renderAll();
      scheduleSave();
    }
  } else if (!hit && currentTool === "select") {
    createTextEditor(w.x, w.y);
  }
});

// Wheel: zoom or pan
canvasWrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    // Zoom
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(5, viewScale * delta));
    // Zoom toward cursor
    const rect = svg.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    viewX = cx - (cx - viewX) * (newScale / viewScale);
    viewY = cy - (cy - viewY) * (newScale / viewScale);
    viewScale = newScale;
    updateViewport();
  } else {
    // Pan
    viewX -= e.deltaX;
    viewY -= e.deltaY;
    updateViewport();
  }
}, { passive: false });

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  // Don't intercept when typing in text editor
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;

  if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
    e.preventDefault();
  }
  if (e.key === "Escape") {
    selectedIds.clear();
    renderAll();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    undo();
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    selectedIds = new Set(shapes.map(s => s.id));
    renderAll();
    e.preventDefault();
  }

  // Tool shortcuts
  const toolKeys = { v: "select", h: "pan", r: "rectangle", o: "ellipse",
    d: "diamond", l: "line", a: "arrow", t: "text", p: "freehand" };
  if (toolKeys[e.key] && !e.ctrlKey && !e.metaKey) {
    setTool(toolKeys[e.key]);
  }
});

// ============================================================
// UI Controls
// ============================================================

function setTool(tool) {
  currentTool = tool;
  document.querySelectorAll(".tool-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
  canvasWrap.className = "tool-" + tool;
  if (tool !== "select") {
    selectedIds.clear();
    renderAll();
  }
}

document.querySelectorAll(".tool-btn").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

// Stroke color
document.querySelectorAll(".color-swatch[data-color]").forEach(sw => {
  sw.addEventListener("click", () => {
    strokeColor = sw.dataset.color;
    document.querySelectorAll(".color-swatch[data-color]").forEach(s => s.classList.remove("active"));
    sw.classList.add("active");
    // Apply to selected
    if (selectedIds.size > 0) {
      shapes.forEach(s => { if (selectedIds.has(s.id)) s.stroke = strokeColor; });
      renderAll();
      scheduleSave();
    }
  });
});

// Fill color
document.querySelectorAll(".color-swatch[data-fill]").forEach(sw => {
  sw.addEventListener("click", () => {
    fillColor = sw.dataset.fill;
    document.querySelectorAll(".color-swatch[data-fill]").forEach(s => s.classList.remove("active"));
    sw.classList.add("active");
    if (selectedIds.size > 0) {
      shapes.forEach(s => { if (selectedIds.has(s.id)) s.fill = fillColor; });
      renderAll();
      scheduleSave();
    }
  });
});

// Stroke width
document.querySelectorAll(".stroke-opt").forEach(opt => {
  opt.addEventListener("click", () => {
    strokeWidth = parseInt(opt.dataset.width);
    document.querySelectorAll(".stroke-opt").forEach(o => o.classList.remove("active"));
    opt.classList.add("active");
    if (selectedIds.size > 0) {
      shapes.forEach(s => { if (selectedIds.has(s.id)) s.strokeWidth = strokeWidth; });
      renderAll();
      scheduleSave();
    }
  });
});

// Zoom controls
document.getElementById("zoom-in").addEventListener("click", () => {
  viewScale = Math.min(5, viewScale * 1.2);
  updateViewport();
});
document.getElementById("zoom-out").addEventListener("click", () => {
  viewScale = Math.max(0.1, viewScale / 1.2);
  updateViewport();
});
document.getElementById("zoom-fit").addEventListener("click", () => {
  viewX = 0; viewY = 0; viewScale = 1;
  updateViewport();
});

// Actions
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-clear").addEventListener("click", async () => {
  if (shapes.length === 0) return;
  const confirmed = await showConfirm("Clear Canvas", "Remove all shapes? This cannot be undone.", "Clear All", "danger");
  if (!confirmed) return;
  pushHistory();
  shapes = [];
  selectedIds.clear();
  renderAll();
  try { await apiInvoke("clear_canvas", {}); } catch(e) {}
  toast("Canvas cleared");
});
document.getElementById("btn-export").addEventListener("click", exportSVG);
document.getElementById("btn-save").addEventListener("click", saveDrawing);
document.getElementById("btn-load").addEventListener("click", openLoadDialog);
document.getElementById("load-dialog-close").addEventListener("click", () => {
  document.getElementById("load-overlay").classList.remove("show");
});
document.getElementById("load-overlay").addEventListener("click", (e) => {
  if (e.target.id === "load-overlay") e.currentTarget.classList.remove("show");
});
document.getElementById("btn-chat").addEventListener("click", async () => {
  // Build a summary of what's currently on the canvas
  const shapeSummary = shapes.map(s => {
    let desc = s.type;
    if (s.text) desc += ` "${s.text}"`;
    if (s.x !== undefined) desc += ` at (${Math.round(s.x)},${Math.round(s.y)})`;
    return desc;
  });
  
  // Fetch saved drawings for context
  let savedDrawings = [];
  try {
    const result = await apiInvoke("list_drawings", {});
    savedDrawings = (result.drawings || []).map(d => d.name);
  } catch (e) {}
  
  window.omnideck.chat.open();
  window.omnideck.chat.compose({
    text: "Draw on my Drawboard canvas. Call the add_shapes action with shape data. Shape types: rectangle, ellipse, diamond, line, arrow, text, freehand. Each shape needs: type, x, y, width, height (for shapes), points (for lines/arrows/freehand as [[x,y],...]), text (for text/labels), stroke, fill, strokeWidth, fontSize. You can also call clear_canvas to start fresh, or save_drawing/load_drawing to manage saved drawings.",
    context: {
      app: "drawboard",
      shapeCount: shapes.length,
      currentShapes: shapeSummary,
      savedDrawings: savedDrawings,
    }
  });
});

// ============================================================
// Init
// ============================================================

updateViewport();
loadCanvas().then(() => {
  // Start polling for agent shapes
  setInterval(pollForAgentShapes, 2000);
});
