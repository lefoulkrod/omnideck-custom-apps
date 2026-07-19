/* ===== Sidebar Toggle & Resize ===== */

import { dom } from './dom.js';

let isResizing = false;

function activeView() {
  return dom.sidebar.dataset.view || 'explorer';
}

function updateActivityButtons() {
  const visible = !dom.sidebar.classList.contains('hidden');
  const view = activeView();
  document.getElementById('btn-explorer')?.classList.toggle(
    'active', visible && view === 'explorer',
  );
  document.getElementById('btn-source-control')?.classList.toggle(
    'active', visible && view === 'source-control',
  );
}

export function setSidebarView(view) {
  const normalized = view === 'source-control' ? 'source-control' : 'explorer';
  dom.sidebar.dataset.view = normalized;
  dom.explorerView.hidden = normalized !== 'explorer';
  dom.sourceView.hidden = normalized !== 'source-control';
  updateActivityButtons();
}

export function showSidebarView(view, saveStateFn = () => {}) {
  setSidebarView(view);
  dom.sidebar.classList.remove('hidden');
  dom.resizer.classList.remove('hidden');
  updateActivityButtons();
  saveStateFn();
}

export function toggleSidebarView(view, saveStateFn = () => {}) {
  const shouldHide = !dom.sidebar.classList.contains('hidden') && activeView() === view;
  if (shouldHide) {
    dom.sidebar.classList.add('hidden');
    dom.resizer.classList.add('hidden');
    updateActivityButtons();
    saveStateFn();
    return false;
  }
  showSidebarView(view, saveStateFn);
  return true;
}

export function toggleSidebar(saveStateFn) {
  const isHidden = dom.sidebar.classList.toggle('hidden');
  dom.resizer.classList.toggle('hidden', isHidden);
  updateActivityButtons();
  saveStateFn();
}

export function initSidebar(saveStateFn) {
  dom.resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = e.clientX - dom.activityBar.getBoundingClientRect().right;
    if (newWidth > 240 && newWidth < 600) {
      dom.sidebar.style.width = newWidth + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      saveStateFn();
    }
  });
}
