/* ===== File Name / Content Search ===== */

import { state } from './state.js';
import { dom } from './dom.js';
import { api, showToast } from './api.js';
import { getFileIcon } from './icons.js';
import { relativePath } from './breadcrumb.js';
import { renderTree } from './tree.js';
import { openConfirmDialog } from './modals.js';

let searchTimer = null;
let isSearching = false;
let searchSequence = 0;

function searchParams(query) {
  return {
    path: state.rootDir || state.homePath,
    query,
    limit: 200,
    content: state.searchContent,
    include: dom.searchInclude?.value.trim() || '',
    exclude: dom.searchExclude?.value.trim() || '',
    show_hidden: state.showHidden,
  };
}

function scheduleSearch(openFileFn, navigateToFn) {
  const query = dom.searchInput.value.trim();
  dom.searchClear.style.display = query ? 'flex' : 'none';
  if (searchTimer) clearTimeout(searchTimer);
  if (!query) {
    clearSearch();
    return;
  }
  searchTimer = setTimeout(() => doSearch(query, openFileFn, navigateToFn), 200);
}

export function initSearch(openFileFn, navigateToFn, refreshTreeFn) {
  const input = dom.searchInput;
  const clearBtn = dom.searchClear;
  dom.searchReplace.disabled = !state.searchContent;
  dom.searchReplaceAll.disabled = !state.searchContent;

  input.addEventListener('input', () => scheduleSearch(openFileFn, navigateToFn));

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    clearSearch();
    input.focus();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      clearBtn.style.display = 'none';
      clearSearch();
      event.stopPropagation();
    }
  });

  dom.searchMode.addEventListener('click', () => {
    state.searchContent = !state.searchContent;
    dom.searchMode.classList.toggle('active', state.searchContent);
    input.placeholder = state.searchContent ? 'Search file contents...' : 'Search files...';
    dom.searchReplace.disabled = !state.searchContent;
    dom.searchReplaceAll.disabled = !state.searchContent;
    scheduleSearch(openFileFn, navigateToFn);
  });

  dom.searchOptionsToggle.addEventListener('click', () => {
    dom.searchOptions.hidden = !dom.searchOptions.hidden;
  });
  for (const option of [dom.searchInclude, dom.searchExclude]) {
    option.addEventListener('input', () => scheduleSearch(openFileFn, navigateToFn));
  }

  dom.searchReplaceAll.addEventListener('click', async () => {
    const query = input.value;
    if (!state.searchContent || !query) return;
    const preview = await api('search_files', searchParams(query));
    if (preview.error) {
      showToast(preview.error, 'error');
      return;
    }
    const previewPaths = (preview.results || []).slice(0, 6).map(item => item.rel_path);
    const more = (preview.results?.length || 0) > previewPaths.length
      ? ` and ${preview.results.length - previewPaths.length} more` : '';
    openConfirmDialog(
      'Replace Across Files',
      `Replace every literal occurrence of '${query}' in ${preview.results?.length || 0} matching file(s)?\n${previewPaths.join(', ')}${more}`,
      'Replace All',
      async (confirmed) => {
        if (!confirmed) return;
        const { content, ...replaceParams } = searchParams(query);
        const result = await api('replace_in_files', {
          ...replaceParams,
          replacement: dom.searchReplace.value,
        });
        if (result.error) {
          showToast(result.error, 'error');
          return;
        }
        showToast(
          `Replaced ${result.replacements} occurrence${result.replacements === 1 ? '' : 's'} in ${result.files_changed} file${result.files_changed === 1 ? '' : 's'}`,
          'success',
        );
        await refreshTreeFn();
        doSearch(query, openFileFn, navigateToFn);
      },
    );
  });
}

export function clearSearch() {
  searchSequence += 1;
  if (!isSearching) return;
  isSearching = false;
  dom.treeContainer.innerHTML = '';
  if (state.treeData[state.currentDir]) renderTree();
}

export async function doSearch(query, openFileFn, navigateToFn) {
  const requestId = ++searchSequence;
  isSearching = true;
  const tree = dom.treeContainer;
  tree.innerHTML = '<div class="loading"><div class="spinner"></div>Searching...</div>';

  const result = await api('search_files', searchParams(query));
  if (!isSearching || requestId !== searchSequence) return;

  tree.innerHTML = '';
  if (result.error) {
    const error = document.createElement('div');
    error.className = 'loading';
    error.style.color = 'var(--danger)';
    error.textContent = result.error;
    tree.appendChild(error);
    return;
  }

  const results = result.results || [];
  const header = document.createElement('div');
  header.className = 'search-results-header';
  header.textContent = results.length
    ? `${results.length} result${results.length === 1 ? '' : 's'}`
    : 'No results';
  tree.appendChild(header);
  if (!results.length) return;

  for (const item of results) {
    const row = document.createElement('div');
    row.className = 'search-result-item';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    if (item.is_dir) {
      icon.innerHTML = '<i class="bi bi-folder icon-folder"></i>';
    } else {
      const fileIcon = getFileIcon(item.name);
      icon.innerHTML = `<i class="bi ${fileIcon.icon} ${fileIcon.cls}"></i>`;
    }
    row.appendChild(icon);

    const details = document.createElement('span');
    details.className = 'result-details';
    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = item.line ? `${item.name}:${item.line}` : item.name;
    const path = document.createElement('span');
    path.className = 'result-path';
    path.textContent = item.match || relativePath(item.path);
    details.append(name, path);
    row.appendChild(details);

    row.onclick = async () => {
      if (item.is_dir) {
        await navigateToFn(item.path);
      } else {
        await openFileFn(item.path, item.name);
        if (item.line && state.cm) {
          state.cm.setCursor({ line: item.line - 1, ch: 0 });
          state.cm.scrollIntoView({ line: item.line - 1, ch: 0 }, 80);
        }
      }
      dom.searchInput.value = '';
      dom.searchClear.style.display = 'none';
      clearSearch();
    };

    tree.appendChild(row);
  }
}
