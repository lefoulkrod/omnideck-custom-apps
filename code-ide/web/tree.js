/* ===== File Tree — VS Code-style ===== */

import { state } from './state.js';
import { dom } from './dom.js';
import { api } from './api.js';
import { getFileIcon } from './icons.js';
import { renderBreadcrumb } from './breadcrumb.js';

// ===== Directory loading =====

export async function loadDir(path) {
  const action = state.showHidden ? 'list_dir_with_hidden' : 'list_dir';
  const result = await api(action, { path });
  if (result.error) {
    dom.treeContainer.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'loading';
    error.style.color = 'var(--danger)';
    error.textContent = result.error;
    dom.treeContainer.appendChild(error);
    return null;
  }
  state.treeData[path] = { items: result.items, loaded: true };
  return result;
}

// ===== Navigation =====

export async function navigateTo(path, goHomeFn) {
  state.currentDir = path;
  state.selectedDir = path;
  state.selectedPath = path;
  renderBreadcrumb(path, goHomeFn, (p) => navigateTo(p, goHomeFn));
  updateWorkspaceName(path);
  dom.treeContainer.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
  const result = await loadDir(path);
  if (result) renderTree();
}

export async function openFolderAsRoot(path, updatePromptFn, saveStateFn, goHomeFn) {
  state.rootDir = path;
  state.currentDir = path;
  state.selectedDir = path;
  state.selectedPath = path;
  state.expandedDirs.clear();
  state.treeData = {};
  renderBreadcrumb(path, goHomeFn, (p) => navigateTo(p, goHomeFn));
  updateWorkspaceName(path);
  dom.treeContainer.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
  const result = await loadDir(path);
  if (result) renderTree();
  saveStateFn();
}

export function goHome(navigateToFn, updatePromptFn, saveStateFn) {
  state.rootDir = state.homePath;
  state.currentDir = state.homePath;
  state.selectedDir = state.homePath;
  state.selectedPath = state.homePath;
  state.expandedDirs.clear();
  state.treeData = {};
  navigateToFn(state.homePath);
  saveStateFn();
}

function updateWorkspaceName(path) {
  const wsName = document.getElementById('workspace-name');
  if (wsName) {
    wsName.textContent = path === state.homePath ? 'Explorer' : path.substring(path.lastIndexOf('/') + 1);
  }
}

// ===== Tree rendering — fully recursive =====
//
// renderTree() rebuilds the entire visible tree from state.treeData.
// It renders the root dir's items, then recursively renders children
// of any expanded folder. All data must already be in state.treeData
// (loaded via loadDir). If a folder is expanded but its data isn't
// loaded, it's skipped (shouldn't happen in normal flow).

export function renderTree() {
  const scrollTop = dom.treeContainer.scrollTop;
  dom.treeContainer.innerHTML = '';
  const data = state.treeData[state.currentDir];
  if (!data || !data.items) return;
  renderItems(dom.treeContainer, data.items, 0);
  dom.treeContainer.scrollTop = scrollTop;
}

// Render a list of items at a given depth, recursively expanding folders
function renderItems(container, items, depth) {
  for (const item of items) {
    const row = createTreeRow(item, depth);
    container.appendChild(row);

    // If this is an expanded folder, render its children right after
    if (item.is_dir && state.expandedDirs.has(item.path)) {
      const childData = state.treeData[item.path];
      if (childData && childData.items) {
        renderItems(container, childData.items, depth + 1);
      }
      // If no data loaded, skip — the folder shows as expanded but empty
      // (this shouldn't happen since we loadDir before expanding)
    }
  }
}

// Create a single tree row element
function createTreeRow(item, depth) {
  const row = document.createElement('div');
  row.className = 'tree-item';
  if (state.selectedPath === item.path) {
    row.classList.add('selected');
  }
  row.dataset.path = item.path;
  row.dataset.isdir = item.is_dir;
  row.dataset.depth = depth;
  row.style.paddingLeft = (depth * 16 + 4) + 'px';

  // Chevron
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  if (item.is_dir) {
    chevron.innerHTML = '<i class="bi bi-chevron-right"></i>';
    if (state.expandedDirs.has(item.path)) {
      chevron.classList.add('expanded');
    }
  } else {
    chevron.classList.add('invisible');
  }
  row.appendChild(chevron);

  // Icon
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  if (item.is_dir) {
    const isOpen = state.expandedDirs.has(item.path);
    icon.innerHTML = `<i class="bi ${isOpen ? 'bi-folder2-open' : 'bi-folder'} icon-folder"></i>`;
  } else {
    const fi = getFileIcon(item.name);
    icon.innerHTML = `<i class="bi ${fi.icon} ${fi.cls}"></i>`;
  }
  row.appendChild(icon);

  // Name
  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;
  row.appendChild(name);

  // Hover actions
  const actions = document.createElement('span');
  actions.className = 'item-actions';
  if (item.is_dir) {
    const newFileBtn = document.createElement('button');
    newFileBtn.className = 'mini-btn';
    newFileBtn.title = 'New File';
    newFileBtn.innerHTML = '<i class="bi bi-file-earmark-plus"></i>';
    newFileBtn.onclick = (e) => { e.stopPropagation(); treeDeps.openNewFileModal(item.path); };
    actions.appendChild(newFileBtn);

    const newFolderBtn = document.createElement('button');
    newFolderBtn.className = 'mini-btn';
    newFolderBtn.title = 'New Folder';
    newFolderBtn.innerHTML = '<i class="bi bi-folder-plus"></i>';
    newFolderBtn.onclick = (e) => { e.stopPropagation(); treeDeps.openNewFolderModal(item.path); };
    actions.appendChild(newFolderBtn);
  }
  const delBtn = document.createElement('button');
  delBtn.className = 'mini-btn';
  delBtn.title = 'Delete';
  delBtn.innerHTML = '<i class="bi bi-trash"></i>';
  delBtn.onclick = (e) => { e.stopPropagation(); treeDeps.confirmDelete(item); };
  actions.appendChild(delBtn);
  row.appendChild(actions);

  // Click handler
  row.onclick = () => {
    state.selectedPath = item.path;
    if (item.is_dir) {
      // Select this folder
      state.selectedDir = item.path;
      document.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
      row.classList.add('selected');
      toggleDir(item, depth);
    } else {
      state.selectedDir = parentPath(item.path);
      document.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
      row.classList.add('selected');
      treeDeps.openFile(item.path, item.name);
    }
  };

  // Right-click context menu
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    treeDeps.showContextMenu(e.clientX, e.clientY, item);
  };

  return row;
}

// ===== Expand / Collapse =====
//
// Instead of manipulating DOM elements directly, we just update
// state.expandedDirs and re-render the whole tree. This is simpler
// and always correct. The scroll position is preserved by renderTree().

export async function toggleDir(item, depth) {
  const path = item.path;

  if (state.expandedDirs.has(path)) {
    // Collapse — just remove from expanded set and re-render
    state.expandedDirs.delete(path);
    renderTree();
  } else {
    // Expand — load data if needed, then re-render
    state.expandedDirs.add(path);
    if (!state.treeData[path]) {
      await loadDir(path);
    }
    renderTree();
  }
  treeDeps.saveState();
}

export function collapseAllDirs() {
  state.expandedDirs.clear();
  renderTree();
  treeDeps.saveState();
}

export async function toggleHiddenFiles() {
  state.showHidden = !state.showHidden;
  state.treeData = {};
  const dirs = [state.currentDir, ...state.expandedDirs];
  await Promise.all([...new Set(dirs)].map(dir => loadDir(dir)));
  renderTree();
  treeDeps.saveState();
  return state.showHidden;
}

export async function revealPath(path) {
  if (!path || !path.startsWith(state.rootDir + '/')) return false;
  if (!path.startsWith(state.currentDir + '/')) {
    state.currentDir = state.rootDir;
    if (!state.treeData[state.currentDir]) await loadDir(state.currentDir);
    updateWorkspaceName(state.currentDir);
  }
  const parent = parentPath(path);
  const relative = parent.substring(state.currentDir.length + 1);
  let cursor = state.currentDir;
  for (const part of relative.split('/').filter(Boolean)) {
    cursor += '/' + part;
    state.expandedDirs.add(cursor);
    if (!state.treeData[cursor]) await loadDir(cursor);
  }
  state.selectedPath = path;
  state.selectedDir = parent;
  renderTree();
  const row = [...dom.treeContainer.querySelectorAll('.tree-item')]
    .find(element => element.dataset.path === path);
  if (row) row.scrollIntoView({ block: 'center' });
  treeDeps.saveState();
  return Boolean(row);
}

// ===== Full refresh (only used by the refresh button) =====

export async function refreshTree() {
  const scrollTop = dom.treeContainer.scrollTop;
  // Reload current dir and all expanded dirs
  const isVisible = (dir) => {
    if (dir === state.currentDir) return true;
    if (!dir.startsWith(state.currentDir + '/')) return false;
    let ancestor = parentPath(dir);
    while (ancestor !== state.currentDir) {
      if (!state.expandedDirs.has(ancestor)) return false;
      ancestor = parentPath(ancestor);
    }
    return true;
  };
  const dirsToReload = [...new Set([state.currentDir, ...state.expandedDirs])]
    .filter(isVisible);
  await Promise.all(dirsToReload.map(async (dir) => {
    delete state.treeData[dir];
    await loadDir(dir);
  }));
  renderTree();
  dom.treeContainer.scrollTop = scrollTop;
}

// ===== Optimistic updates (no backend reload) =====

function parentPath(p) {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.substring(0, idx) : state.homePath;
}

export function isSameOrDescendant(path, parent) {
  return path === parent || path.startsWith(parent + '/');
}

export function remapPathPrefix(path, oldPath, newPath) {
  return isSameOrDescendant(path, oldPath)
    ? newPath + path.substring(oldPath.length)
    : path;
}

export function optimisticAdd(parentDir, name, isDir) {
  const fullPath = parentDir + '/' + name;
  const newItem = {
    name: name,
    path: fullPath,
    is_dir: isDir,
    size: 0,
    modified: Date.now() / 1000,
  };

  const parentData = state.treeData[parentDir];
  if (parentData && parentData.items) {
    const items = parentData.items;
    const insertIdx = items.findIndex(i =>
      (isDir && !i.is_dir) ||
      (isDir === i.is_dir && i.name.toLowerCase() > name.toLowerCase())
    );
    if (insertIdx >= 0) {
      items.splice(insertIdx, 0, newItem);
    } else {
      items.push(newItem);
    }
  }

  // Re-render if the parent is visible (current dir or expanded)
  if (parentDir === state.currentDir || state.expandedDirs.has(parentDir)) {
    renderTree();
  }
}

export function optimisticRemove(path) {
  const parent = parentPath(path);

  // Remove from parent's items
  const parentData = state.treeData[parent];
  if (parentData && parentData.items) {
    parentData.items = parentData.items.filter(i => i.path !== path);
  }

  // Clean up state
  state.expandedDirs = new Set(
    [...state.expandedDirs].filter(dir => !isSameOrDescendant(dir, path)),
  );
  for (const key of Object.keys(state.treeData)) {
    if (isSameOrDescendant(key, path)) delete state.treeData[key];
  }
  if (isSameOrDescendant(state.selectedDir, path)) state.selectedDir = parent;
  if (isSameOrDescendant(state.selectedPath, path)) state.selectedPath = parent;

  renderTree();
}

export function optimisticRename(oldPath, newName) {
  const parent = parentPath(oldPath);
  const newPath = parent + '/' + newName;

  const parentData = state.treeData[parent];
  if (parentData && parentData.items) {
    const item = parentData.items.find(i => i.path === oldPath);
    if (item) {
      item.name = newName;
      item.path = newPath;
    }
  }

  state.expandedDirs = new Set(
    [...state.expandedDirs].map(path => remapPathPrefix(path, oldPath, newPath)),
  );

  const remappedTreeData = {};
  for (const [key, data] of Object.entries(state.treeData)) {
    const remappedKey = remapPathPrefix(key, oldPath, newPath);
    if (data.items) {
      data.items.forEach(child => {
        child.path = remapPathPrefix(child.path, oldPath, newPath);
      });
    }
    remappedTreeData[remappedKey] = data;
  }
  state.treeData = remappedTreeData;

  const tabs = new Map();
  for (const [path, tab] of state.openTabs) {
    const remapped = remapPathPrefix(path, oldPath, newPath);
    if (path === oldPath) tab.name = newName;
    tabs.set(remapped, tab);
  }
  state.openTabs = tabs;
  state.activeTab = state.activeTab
    ? remapPathPrefix(state.activeTab, oldPath, newPath) : null;
  state.cmPath = state.cmPath
    ? remapPathPrefix(state.cmPath, oldPath, newPath) : null;
  state.selectedDir = remapPathPrefix(state.selectedDir, oldPath, newPath);
  state.selectedPath = remapPathPrefix(state.selectedPath, oldPath, newPath);

  renderTree();
}

// ===== Cross-module deps (set by main.js) =====

const treeDeps = {
  openFile: null,
  showContextMenu: null,
  openNewFileModal: null,
  openNewFolderModal: null,
  confirmDelete: null,
  saveState: () => {},
};

export function setTreeDeps(deps) {
  Object.assign(treeDeps, deps);
}

export function initTreeKeyboard() {
  dom.treeContainer.tabIndex = 0;
  dom.treeContainer.addEventListener('keydown', async (event) => {
    const rows = [...dom.treeContainer.querySelectorAll('.tree-item')];
    if (!rows.length) return;
    let index = Math.max(0, rows.findIndex(row => row.dataset.path === state.selectedPath));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      index = Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      const next = rows[index];
      state.selectedPath = next.dataset.path;
      state.selectedDir = next.dataset.isdir === 'true'
        ? next.dataset.path : parentPath(next.dataset.path);
      rows.forEach(candidate => candidate.classList.toggle('selected', candidate === next));
      next.scrollIntoView({ block: 'nearest' });
      return;
    }
    const row = rows[index];
    if (!row) return;
    const isDir = row.dataset.isdir === 'true';
    if (event.key === 'Enter') {
      event.preventDefault();
      row.click();
    } else if (event.key === 'ArrowRight' && isDir && !state.expandedDirs.has(row.dataset.path)) {
      event.preventDefault();
      await toggleDir({ path: row.dataset.path, is_dir: true }, Number(row.dataset.depth));
    } else if (event.key === 'ArrowLeft' && isDir && state.expandedDirs.has(row.dataset.path)) {
      event.preventDefault();
      await toggleDir({ path: row.dataset.path, is_dir: true }, Number(row.dataset.depth));
    } else if (event.key === 'ArrowLeft') {
      const parent = parentPath(row.dataset.path);
      const parentRow = rows.find(candidate => candidate.dataset.path === parent);
      if (parentRow) {
        event.preventDefault();
        state.selectedPath = parent;
        state.selectedDir = parent;
        rows.forEach(candidate => candidate.classList.toggle('selected', candidate === parentRow));
        parentRow.scrollIntoView({ block: 'nearest' });
      }
    }
  });
}
