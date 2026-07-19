/* ===== Path Helpers & Breadcrumb ===== */

import { state } from './state.js';
import { dom } from './dom.js';

export function relativePath(fullPath) {
  if (fullPath === state.homePath) return '~';
  if (fullPath.startsWith(state.homePath + '/')) {
    return '~/' + fullPath.substring(state.homePath.length + 1);
  }
  return fullPath;
}

export function basename(p) {
  const parts = p.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function dirname(p) {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.substring(0, idx) : state.homePath;
}

export function renderBreadcrumb(path, goHomeFn, navigateToFn) {
  // Breadcrumb was replaced by the search bar in the sidebar.
  // The current workspace root is shown in the sidebar header area.
  // This function is kept as a no-op for compatibility.
}
