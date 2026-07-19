import { composeChat, invoke } from './api.js';
import {
  escapeHtml,
  fileUrl,
  formatBytes,
  formatDate,
  itemKey,
  parseRoute,
  routeHash,
  splitItemKey,
  typeIconClass,
  typeLabel,
} from './state.js';

const COLORS = ['#5b6cf9', '#8b5cf6', '#d946ef', '#ef476f', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6'];

const dom = {
  content: document.querySelector('#content'),
  pageTitle: document.querySelector('#page-title'),
  pageEyebrow: document.querySelector('#page-eyebrow'),
  search: document.querySelector('#global-search'),
  refresh: document.querySelector('#refresh-button'),
  newProject: document.querySelector('#new-project'),
  newProjectSidebar: document.querySelector('#new-project-sidebar'),
  projectNav: document.querySelector('#project-nav'),
  inboxBadge: document.querySelector('#inbox-badge'),
  menu: document.querySelector('#menu-button'),
  sidebarClose: document.querySelector('#sidebar-close'),
  scrim: document.querySelector('#scrim'),
  selectionBar: document.querySelector('#selection-bar'),
  selectionCount: document.querySelector('#selection-count'),
  selectionProject: document.querySelector('#assign-project'),
  assignSelection: document.querySelector('#assign-selection'),
  clearSelection: document.querySelector('#clear-selection'),
  projectModal: document.querySelector('#project-modal'),
  projectForm: document.querySelector('#project-form'),
  projectModalEyebrow: document.querySelector('#project-modal-eyebrow'),
  projectModalTitle: document.querySelector('#project-modal-title'),
  projectName: document.querySelector('#project-name'),
  projectDescription: document.querySelector('#project-description'),
  projectTags: document.querySelector('#project-tags'),
  projectSubmit: document.querySelector('#project-submit'),
  colorOptions: document.querySelector('#color-options'),
  confirmModal: document.querySelector('#confirm-modal'),
  confirmMessage: document.querySelector('#confirm-message'),
  confirmCancel: document.querySelector('#confirm-cancel'),
  confirmAction: document.querySelector('#confirm-action'),
  toast: document.querySelector('#toast'),
};

const state = {
  dashboard: null,
  projects: [],
  route: parseRoute(location.hash),
  selected: new Map(),
  editingProjectId: null,
  selectedColor: COLORS[0],
  confirmCallback: null,
  filePath: '',
  showHidden: false,
  currentProject: null,
  currentProjectItems: [],
  storageReport: null,
  welcomeConsumed: false,
  visibleResources: new Map(),
  conversationDetails: new Map(),
  filters: {
    conversationsArchive: 'all',
    conversationsAssignment: 'all',
    conversationsArtifacts: 'all',
    conversationsSort: 'activity',
    artifactsStatus: 'all',
    artifactsAssignment: 'all',
  },
};

let toastTimer;
let searchTimer;

function showToast(message, type = 'success') {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.className = `toast visible ${type}`;
  toastTimer = setTimeout(() => {
    dom.toast.className = 'toast';
  }, 2800);
}

function setPage(title, eyebrow = 'Your Omnideck') {
  dom.pageTitle.textContent = title;
  dom.pageEyebrow.textContent = eyebrow;
}

function showLoading(message = 'Gathering your Omnideck activity…') {
  dom.content.innerHTML = `<div class="loading-state"><span class="spinner"></span><p>${escapeHtml(message)}</p></div>`;
}

function showError(error) {
  dom.content.innerHTML = `<div class="page"><div class="error-state"><strong>Something went wrong.</strong><br>${escapeHtml(error?.message || error)}</div></div>`;
}

function emptyState(title, message, action = '') {
  return `<div class="empty-state"><div class="empty-mark">○</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>${action}</div>`;
}

function encoded(value) {
  return escapeHtml(encodeURIComponent(String(value)));
}

function decoded(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return '';
  }
}

function projectPills(projects = []) {
  if (!projects.length) return '';
  return `<div class="project-pills">${projects.slice(0, 3).map((project) => `
    <span class="project-pill" style="--pill-color:${escapeHtml(project.color)}">${escapeHtml(project.name)}</span>
  `).join('')}${projects.length > 3 ? `<span class="status-pill">+${projects.length - 3}</span>` : ''}</div>`;
}

function statusPill(item) {
  if (item.status === 'missing') return '<span class="status-pill danger">Missing</span>';
  if (item.orphaned) return '<span class="status-pill warning">Source chat gone</span>';
  if (item.archived) return '<span class="status-pill">Archived</span>';
  return '';
}

function itemSecondary(item) {
  if (item.type === 'conversation') {
    const artifactCount = Number(item.artifact_count) || 0;
    return `${formatBytes(item.total_size)} total · ${formatBytes(item.size)} conversation + ${formatBytes(item.artifact_bytes)} artifacts · ${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'} · ${item.turn_count} ${item.turn_count === 1 ? 'turn' : 'turns'}${item.first_message ? `<br>${escapeHtml(item.first_message)}` : ''}`;
  }
  if (item.type === 'artifact') {
    const source = item.conversation_title ? `From ${escapeHtml(item.conversation_title)}` : 'Source conversation unavailable';
    return `${formatBytes(item.size)} · ${escapeHtml(item.content_type)}<br>${source}`;
  }
  return `${escapeHtml(item.display_path || item.path || '')}${item.type === 'folder' && item.file_count ? `<br>${item.file_count} files · ${formatBytes(item.size)}` : ''}`;
}

function itemMeta(item) {
  const date = item.last_activity || item.updated_at || item.modified;
  return `${statusPill(item)}<div>${escapeHtml(formatDate(date))}</div>`;
}

function itemTitle(item, options = {}) {
  if (item.type === 'folder' && options.browse) {
    return `<button class="folder-link" data-action="open-folder" data-path="${encoded(item.path)}">${escapeHtml(item.title)}</button>`;
  }
  if (item.type === 'artifact' && item.status === 'present' && item.path) {
    return `<a class="folder-link" href="${escapeHtml(fileUrl(item.path))}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>`;
  }
  return `<strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>`;
}

function itemRow(item, options = {}) {
  const key = itemKey(item);
  state.visibleResources.set(key, item);
  const checked = state.selected.has(key);
  const remove = options.projectId
    ? `<button class="button subtle small" data-action="remove-item" data-project-id="${encoded(options.projectId)}" data-type="${escapeHtml(item.type)}" data-id="${encoded(item.id)}">Remove</button>`
    : '';
  const note = options.projectId
    ? `<button class="button subtle small" data-action="edit-note" data-project-id="${encoded(options.projectId)}" data-type="${escapeHtml(item.type)}" data-id="${encoded(item.id)}" data-note="${encoded(item.project_note || '')}">Note</button>`
    : '';
  const details = item.type === 'conversation'
    ? `<button class="button subtle small" data-action="conversation-details" data-id="${encoded(item.id)}" data-default-project-id="${encoded(options.projectId || '')}" aria-expanded="false"><i class="bi bi-info-circle" aria-hidden="true"></i> Details</button>`
    : '';
  return `
    <div class="item-row ${checked ? 'selected' : ''}" data-resource-row data-type="${escapeHtml(item.type)}" data-id="${encoded(item.id)}">
      <input class="item-check" type="checkbox" aria-label="Select ${escapeHtml(item.title)}" data-select-item data-type="${escapeHtml(item.type)}" data-id="${encoded(item.id)}" ${checked ? 'checked' : ''}>
      <span class="type-icon ${escapeHtml(item.type)}" title="${typeLabel(item.type)}"><i class="bi ${typeIconClass(item.type)}" aria-hidden="true"></i></span>
      <div class="item-primary">
        ${itemTitle(item, options)}
        ${projectPills(item.projects)}
        ${item.project_note ? `<div class="note-preview">${escapeHtml(item.project_note)}</div>` : ''}
      </div>
      <div class="item-secondary">${itemSecondary(item)}</div>
      <div class="item-actions">
        <div class="item-meta">${itemMeta(item)}</div>
        ${details}
        <button class="icon-button bordered" data-action="ask-item" data-type="${escapeHtml(item.type)}" data-id="${encoded(item.id)}" title="Ask about this resource" aria-label="Ask about ${escapeHtml(item.title)}"><i class="bi bi-stars" aria-hidden="true"></i></button>
        ${note}${remove}
      </div>
    </div>`;
}

function recentItem(item) {
  const detail = item.type === 'conversation'
    ? `${item.turn_count} turns · ${formatBytes(item.size)}`
    : `${formatBytes(item.size)} · ${item.status}`;
  return `<div class="recent-item">
    <span class="type-icon ${escapeHtml(item.type)}"><i class="bi ${typeIconClass(item.type)}" aria-hidden="true"></i></span>
    <div class="item-primary"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(detail)}</small></div>
    <span class="item-meta">${escapeHtml(formatDate(item.last_activity || item.updated_at))}</span>
  </div>`;
}

function bundleProjectOptions(preferredProjectId = '') {
  const selectedProjectId = [preferredProjectId]
    .find((id) => state.projects.some((project) => project.id === id))
    || state.projects[0]?.id
    || '';
  return {
    selectedProjectId,
    html: state.projects.map((project) => `<option value="${escapeHtml(project.id)}" ${project.id === selectedProjectId ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join(''),
  };
}

function conversationAgentCard(agent, index) {
  const activity = [
    `${agent.turn_count} ${agent.turn_count === 1 ? 'turn' : 'turns'}`,
    agent.tool_result_count ? `${agent.tool_result_count} tool results` : '',
    agent.output_count ? `${agent.output_count} outputs` : '',
  ].filter(Boolean).join(' · ');
  return `<article class="agent-card">
    <div class="agent-card-heading">
      <span class="agent-icon"><i class="bi bi-robot" aria-hidden="true"></i></span>
      <div><strong>Spawned agent ${index + 1}</strong><span>${escapeHtml(agent.name)}</span></div>
      ${agent.status ? `<span class="status-pill">${escapeHtml(agent.status)}</span>` : ''}
    </div>
    <p class="agent-activity">${escapeHtml(activity)}</p>
  </article>`;
}

function conversationDetailsPanel(details, preferredProjectId = '') {
  const conversation = details.conversation;
  const storage = details.storage;
  const artifactSummary = details.artifact_summary;
  const agentActivity = details.agent_activity;
  const projectOptions = bundleProjectOptions(preferredProjectId);
  const storageRows = storage.categories.map((category) => `<div class="storage-category">
    <div><strong>${escapeHtml(category.label)}</strong><span>${category.file_count} ${category.file_count === 1 ? 'file' : 'files'} · ${formatBytes(category.size)}</span></div>
    <div class="storage-bar" aria-label="${escapeHtml(category.label)}: ${category.percent}%"><span style="width:${Math.max(1, Math.min(100, Number(category.percent) || 0))}%"></span></div>
    <span>${category.percent}%</span>
  </div>`).join('');
  const fileRows = storage.files.slice(0, 8).map((file) => `<div class="detail-file-row">
    <i class="bi bi-file-earmark" aria-hidden="true"></i><span title="${escapeHtml(file.relative_path)}">${escapeHtml(file.relative_path)}</span><strong>${formatBytes(file.size)}</strong>
  </div>`).join('');
  const artifactRows = details.artifacts.slice(0, 20).map((artifact) => `<div class="detail-artifact-row">
    <span class="type-icon artifact"><i class="bi bi-collection" aria-hidden="true"></i></span>
    <div>${artifact.status === 'present' && artifact.path ? `<a href="${escapeHtml(fileUrl(artifact.path))}" target="_blank" rel="noopener">${escapeHtml(artifact.title)}</a>` : `<strong>${escapeHtml(artifact.title)}</strong>`}<span>${artifact.status === 'present' ? formatBytes(artifact.size) : 'Missing file'}${artifact.agent_name ? ` · ${escapeHtml(artifact.agent_name)}` : ''}</span></div>
    ${projectPills(artifact.projects)}
  </div>`).join('');
  const bundleControls = state.projects.length
    ? `<div class="bundle-controls">
        <label><span class="sr-only">Choose project</span><select data-bundle-project>${projectOptions.html}</select></label>
        <button class="button primary" data-action="assign-conversation-bundle" data-id="${encoded(conversation.id)}"><i class="bi bi-folder-plus" aria-hidden="true"></i> Add conversation + ${artifactSummary.count} ${artifactSummary.count === 1 ? 'artifact' : 'artifacts'}</button>
      </div>`
    : '<button class="button primary" data-action="new-project"><i class="bi bi-plus-lg" aria-hidden="true"></i> Create a project first</button>';
  const spawnedAgentsSection = agentActivity.spawned_count
    ? `<section class="detail-section"><div class="detail-section-heading"><h4><i class="bi bi-robot" aria-hidden="true"></i> Spawned agents</h4><span>${agentActivity.spawned_count}</span></div><div class="agent-list">${agentActivity.agents.map(conversationAgentCard).join('')}</div></section>`
    : '';
  return `<section class="conversation-details" data-conversation-details="${encoded(conversation.id)}">
    <div class="conversation-detail-heading">
      <div><span class="eyebrow">Conversation resource</span><h3>${escapeHtml(conversation.title)}</h3><p>Conversation data and linked artifact files are counted separately.</p></div>
      <div class="heading-actions">
        <button class="button subtle small" data-action="ask-conversation-details" data-id="${encoded(conversation.id)}"><i class="bi bi-stars" aria-hidden="true"></i> Ask about this</button>
        <button class="icon-button" data-action="close-conversation-details" aria-label="Close conversation details"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
      </div>
    </div>
    <div class="detail-stats">
      <div><span>Conversation data</span><strong>${formatBytes(storage.total)}</strong><small>${storage.file_count} ${storage.file_count === 1 ? 'file' : 'files'}${storage.complete ? '' : ' (partial)'}</small></div>
      <div><span>Linked artifact files</span><strong>${formatBytes(artifactSummary.bytes)}</strong><small>${artifactSummary.count} indexed · ${artifactSummary.missing_count} missing</small></div>
      <div><span>History</span><strong>${conversation.event_count} events</strong><small>${conversation.turn_count} ${conversation.turn_count === 1 ? 'turn' : 'turns'} · ${escapeHtml(formatDate(conversation.started_at))}</small></div>
      <div><span>Spawned agents</span><strong>${agentActivity.spawned_count}</strong><small>${agentActivity.totals.turns} turns · ${agentActivity.totals.tool_results} tool results · ${agentActivity.totals.outputs} outputs</small></div>
    </div>
    <div class="conversation-detail-grid ${agentActivity.spawned_count ? '' : 'single'}">
      <section class="detail-section"><div class="detail-section-heading"><h4><i class="bi bi-hdd" aria-hidden="true"></i> Conversation storage</h4><span>${formatBytes(storage.total)}</span></div>${storageRows || '<p class="detail-empty">No conversation files were readable.</p>'}<div class="detail-files">${fileRows}</div></section>
      ${spawnedAgentsSection}
    </div>
    <section class="detail-section artifact-detail-section"><div class="detail-section-heading"><h4><i class="bi bi-collection" aria-hidden="true"></i> Artifacts created</h4><span>${artifactSummary.count}</span></div>${artifactRows || '<p class="detail-empty">No artifacts are indexed to this conversation.</p>'}${details.artifacts.length > 20 ? `<p class="detail-empty">Showing the 20 largest/recent indexed entries.</p>` : ''}</section>
    <section class="bundle-panel"><div><h4>Organize the whole conversation</h4><p>Add the conversation and every indexed artifact to one project. Missing artifact references are included; source content is never moved.</p></div>${bundleControls}</section>
  </section>`;
}

function renderProjectNavigation() {
  if (!state.projects.length) {
    dom.projectNav.innerHTML = '<div class="empty-project-nav">No projects yet. Create one to start organizing.</div>';
  } else {
    dom.projectNav.innerHTML = state.projects.map((project) => `
      <a href="${routeHash('project', project.id)}" data-project-route="${escapeHtml(project.id)}">
        <span class="project-dot" style="--dot-color:${escapeHtml(project.color)}"></span>
        <span class="project-name">${escapeHtml(project.name)}</span>
        <span class="project-count">${project.counts.total}</span>
      </a>`).join('');
  }
  const selectedProject = state.route.view === 'project' ? state.route.id : '';
  document.querySelectorAll('[data-project-route]').forEach((link) => {
    link.classList.toggle('active', link.dataset.projectRoute === selectedProject);
  });
  dom.selectionProject.innerHTML = state.projects.length
    ? `<option value="">Choose a project…</option>${state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')}`
    : '<option value="">Create a project first</option>';
  dom.assignSelection.disabled = !state.projects.length;
}

function updateActiveNavigation() {
  document.querySelectorAll('[data-route]').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === state.route.view);
  });
  renderProjectNavigation();
}

async function loadDashboard() {
  state.dashboard = await invoke('get_dashboard');
  state.projects = state.dashboard.projects || [];
  dom.inboxBadge.textContent = state.dashboard.stats?.unassigned || '';
  renderProjectNavigation();
  return state.dashboard;
}

function projectCard(project) {
  return `<a class="project-card" href="${routeHash('project', project.id)}">
    <div class="project-card-top"><span class="dot" style="--dot-color:${escapeHtml(project.color)}"></span><h4>${escapeHtml(project.name)}</h4></div>
    <p>${escapeHtml(project.description || 'A home for related conversations, artifacts, files, and folders.')}</p>
    <div class="project-card-footer"><span>${project.counts.total} ${project.counts.total === 1 ? 'item' : 'items'}</span><span>${escapeHtml(formatDate(project.updated_at))}</span></div>
  </a>`;
}

function attentionCard(count, title, description, route, good = false) {
  return `<a class="attention-card ${good ? 'good' : ''}" href="${routeHash(route)}">
    <span class="attention-icon">${good ? '✓' : count}</span>
    <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>
  </a>`;
}

function renderHome() {
  setPage('Home');
  const data = state.dashboard;
  const showWelcome = Boolean(data.first_run && !state.welcomeConsumed);
  state.welcomeConsumed = true;
  const stats = data.stats;
  const query = dom.search.value.trim().toLowerCase();
  const projects = data.projects.filter((project) =>
    !query || [project.name, project.description, ...(project.tags || [])].some((value) => String(value).toLowerCase().includes(query)),
  );
  const recent = [...data.recent.conversations, ...data.recent.artifacts]
    .sort((a, b) => String(b.last_activity || b.updated_at).localeCompare(String(a.last_activity || a.updated_at)))
    .slice(0, 6);
  const attention = data.attention;
  dom.content.innerHTML = `<div class="page">
    ${showWelcome ? `<section class="welcome-panel">
      <div class="welcome-copy"><span class="eyebrow">A calmer place for everything</span><h2>Make sense of what Omnideck creates.</h2><p>Group conversations, artifacts, files, and folders around the work they belong to—without moving or rewriting the originals.</p></div>
      <button class="button light" data-action="new-project">Create your first project</button>
    </section>` : ''}
    <section class="stats-grid">
      <div class="stat-card"><span class="stat-label">Projects</span><strong>${stats.projects}</strong><small>${stats.projects ? 'Virtual collections' : 'Ready when you are'}</small></div>
      <div class="stat-card"><span class="stat-label">Conversations</span><strong>${stats.conversations}</strong><small>${formatBytes(stats.conversation_bytes)} conversation data</small></div>
      <div class="stat-card"><span class="stat-label">Artifacts</span><strong>${stats.artifacts}</strong><small>${formatBytes(stats.artifact_bytes)} linked files</small></div>
      <div class="stat-card"><span class="stat-label">Waiting in inbox</span><strong>${stats.unassigned}</strong><small>Unassigned chats and artifacts</small></div>
    </section>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-heading"><h3>Your projects</h3><button class="text-button" data-action="new-project">New project</button></div>
        ${projects.length ? `<div class="project-grid">${projects.map(projectCard).join('')}</div>` : emptyState('No projects yet', query ? 'No projects match this search.' : 'Create a project for a trip, research topic, home task, or anything else.', '<button class="button primary" data-action="new-project">Create project</button>')}
      </section>
      <section class="panel">
        <div class="panel-heading"><h3>Needs attention</h3><a href="#/storage">Review storage</a></div>
        <div class="attention-list">
          ${attention.unassigned_conversations ? attentionCard(attention.unassigned_conversations, 'Unassigned conversations', 'Give recent chats a home.', 'inbox') : ''}
          ${attention.unassigned_artifacts ? attentionCard(attention.unassigned_artifacts, 'Unassigned artifacts', 'Connect outputs to their projects.', 'inbox') : ''}
          ${attention.missing_artifacts ? attentionCard(attention.missing_artifacts, 'Missing artifact files', 'Indexed files that are no longer present.', 'storage') : ''}
          ${!attention.unassigned_conversations && !attention.unassigned_artifacts && !attention.missing_artifacts ? attentionCard(0, 'Everything looks organized', 'There are no obvious loose ends right now.', 'inbox', true) : ''}
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h3>Recent activity</h3><a href="#/conversations">All conversations</a></div>
        <div class="recent-list">${recent.length ? recent.map(recentItem).join('') : emptyState('No recent activity', 'Conversations and artifacts will appear here.', '').replace('empty-state', 'empty-state compact')}</div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h3>Storage snapshot</h3><a href="#/storage">Open cleanup view</a></div>
        ${data.last_storage_scan?.summary ? `<div class="attention-list">
          ${attentionCard(data.last_storage_scan.summary.large_files, 'Large files', `${formatBytes(data.last_storage_scan.summary.bytes)} scanned in total.`, 'storage', !data.last_storage_scan.summary.large_files)}
          ${attentionCard(data.last_storage_scan.summary.duplicate_groups, 'Duplicate groups', `${formatBytes(data.last_storage_scan.summary.duplicate_savings)} potentially recoverable.`, 'storage', !data.last_storage_scan.summary.duplicate_groups)}
        </div>` : emptyState('No storage scan yet', 'Run a read-only scan to understand what is using space.', '<a class="button primary" href="#/storage">Review storage</a>').replace('empty-state', 'empty-state compact')}
      </section>
    </div>
  </div>`;
}

function listHeading(title, description, actions = '') {
  return `<div class="page-heading"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}

function projectAssignmentOptions(selected = 'all') {
  return `<option value="all" ${selected === 'all' ? 'selected' : ''}>All organization</option>
    <option value="unassigned" ${selected === 'unassigned' ? 'selected' : ''}>Unassigned only</option>
    ${state.projects.map((project) => `<option value="project:${escapeHtml(project.id)}" ${selected === `project:${project.id}` ? 'selected' : ''}>In ${escapeHtml(project.name)}</option>`).join('')}`;
}

async function renderConversations() {
  setPage('Conversations', 'Browse & organize');
  const result = await invoke('list_conversations', {
    query: dom.search.value.trim(),
    assignment: state.filters.conversationsAssignment,
    archive: state.filters.conversationsArchive,
    artifact_filter: state.filters.conversationsArtifacts,
    sort: state.filters.conversationsSort,
  });
  dom.content.innerHTML = `<div class="page">
    ${listHeading('Conversations', 'See conversation size, activity, and organization without opening the event logs.')}
    <div class="toolbar">
      <select data-filter="conversations-archive" aria-label="Conversation archive status">
        <option value="all" ${state.filters.conversationsArchive === 'all' ? 'selected' : ''}>Active & archived</option>
        <option value="active" ${state.filters.conversationsArchive === 'active' ? 'selected' : ''}>Active only</option>
        <option value="archived" ${state.filters.conversationsArchive === 'archived' ? 'selected' : ''}>Archived only</option>
      </select>
      <select data-filter="conversations-assignment" aria-label="Conversation organization">${projectAssignmentOptions(state.filters.conversationsAssignment)}</select>
      <select data-filter="conversations-artifacts" aria-label="Conversation artifacts">
        <option value="all" ${state.filters.conversationsArtifacts === 'all' ? 'selected' : ''}>All artifact counts</option>
        <option value="with" ${state.filters.conversationsArtifacts === 'with' ? 'selected' : ''}>Has artifacts</option>
        <option value="without" ${state.filters.conversationsArtifacts === 'without' ? 'selected' : ''}>No artifacts</option>
        <option value="missing" ${state.filters.conversationsArtifacts === 'missing' ? 'selected' : ''}>Has missing artifacts</option>
      </select>
      <select data-filter="conversations-sort" aria-label="Sort conversations">
        <option value="activity" ${state.filters.conversationsSort === 'activity' ? 'selected' : ''}>Newest activity</option>
        <option value="total_size" ${state.filters.conversationsSort === 'total_size' ? 'selected' : ''}>Largest total storage</option>
      </select>
      <span class="toolbar-count">${result.total} ${result.total === 1 ? 'conversation' : 'conversations'}</span>
    </div>
    <section class="data-panel">${result.conversations.length ? `<div class="item-list">${result.conversations.map((item) => itemRow(item)).join('')}</div>` : emptyState('No conversations found', 'Try another filter or search term.')}</section>
  </div>`;
}

async function renderArtifacts() {
  setPage('Artifacts', 'Browse & organize');
  const result = await invoke('list_artifacts', {
    query: dom.search.value.trim(),
    assignment: state.filters.artifactsAssignment,
    status: state.filters.artifactsStatus,
  });
  dom.content.innerHTML = `<div class="page">
    ${listHeading('Artifacts', 'Browse agent-created outputs and see whether their files and source conversations still exist.')}
    <div class="toolbar">
      <select data-filter="artifacts-status" aria-label="Artifact status">
        <option value="all" ${state.filters.artifactsStatus === 'all' ? 'selected' : ''}>All statuses</option>
        <option value="present" ${state.filters.artifactsStatus === 'present' ? 'selected' : ''}>Present</option>
        <option value="missing" ${state.filters.artifactsStatus === 'missing' ? 'selected' : ''}>Missing file</option>
        <option value="orphaned" ${state.filters.artifactsStatus === 'orphaned' ? 'selected' : ''}>Source chat gone</option>
      </select>
      <select data-filter="artifacts-assignment" aria-label="Artifact organization">${projectAssignmentOptions(state.filters.artifactsAssignment)}</select>
      <span class="toolbar-count">${result.total} ${result.total === 1 ? 'artifact' : 'artifacts'}</span>
    </div>
    <section class="data-panel">${result.artifacts.length ? `<div class="item-list">${result.artifacts.map((item) => itemRow(item)).join('')}</div>` : emptyState('No artifacts found', 'Try another filter or search term.')}</section>
  </div>`;
}

function inboxSection(title, description, items, route) {
  return `<section class="panel inbox-section">
    <div class="panel-heading"><div class="section-heading"><h3>${escapeHtml(title)}</h3><span class="count">${items.length}</span></div><a href="${routeHash(route)}">View all</a></div>
    ${items.length ? `<div class="item-list">${items.map((item) => itemRow(item)).join('')}</div>` : `<div class="empty-state compact"><div class="empty-mark">✓</div><h3>All caught up</h3><p>${escapeHtml(description)}</p></div>`}
  </section>`;
}

async function renderInbox() {
  setPage('Inbox', 'Unassigned items');
  const result = await invoke('get_inbox', { query: dom.search.value.trim() });
  dom.content.innerHTML = `<div class="page">
    ${listHeading('Inbox', 'A staging area for things that do not belong to a project yet.')}
    <div class="inbox-sections">
      ${inboxSection('Conversations', 'Every conversation shown here has a project.', result.conversations, 'conversations')}
      ${inboxSection('Artifacts', 'Every artifact shown here has a project.', result.artifacts, 'artifacts')}
      ${inboxSection('Recent files & folders', 'Your recent top-level files are organized.', result.files, 'files')}
    </div>
  </div>`;
}

function breadcrumbs(result) {
  const relative = result.path.startsWith(result.home) ? result.path.slice(result.home.length) : '';
  const parts = relative.split('/').filter(Boolean);
  let accumulated = result.home;
  const crumbs = [`<button class="breadcrumb" data-action="open-folder" data-path="${encoded(result.home)}">Home</button>`];
  for (const part of parts) {
    accumulated += `/${part}`;
    crumbs.push('<span class="breadcrumb-separator">/</span>');
    crumbs.push(`<button class="breadcrumb" data-action="open-folder" data-path="${encoded(accumulated)}">${escapeHtml(part)}</button>`);
  }
  return crumbs.join('');
}

async function renderFiles() {
  setPage('Files & folders', 'Browse & organize');
  const result = await invoke('browse_files', {
    path: state.filePath,
    query: dom.search.value.trim(),
    show_hidden: state.showHidden,
  });
  state.filePath = result.path;
  dom.content.innerHTML = `<div class="page">
    ${listHeading('Files & folders', 'Browse Omnideck’s shared user files and add references to projects. Nothing is moved.', result.parent ? `<button class="button subtle" data-action="open-folder" data-path="${encoded(result.parent)}">↑ Parent folder</button>` : '')}
    <div class="toolbar">
      <div class="breadcrumbs">${breadcrumbs(result)}</div>
      <button class="button subtle small" data-action="toggle-hidden">${state.showHidden ? 'Hide hidden items' : 'Show hidden items'}</button>
      <span class="toolbar-count">${result.total} items</span>
    </div>
    <section class="data-panel">${result.items.length ? `<div class="item-list">${result.items.map((item) => itemRow(item, { browse: true })).join('')}</div>` : emptyState('This folder is empty', dom.search.value ? 'No items match this search.' : 'There is nothing to organize here yet.')}</section>
  </div>`;
}

function projectTags(project) {
  return project.tags?.length ? `<div class="project-tags">${project.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : '';
}

async function renderProject(projectId) {
  const result = await invoke('get_project_items', { project_id: projectId, query: dom.search.value.trim() });
  const project = result.project;
  state.currentProject = project;
  state.currentProjectItems = result.items;
  setPage(project.name, 'Project');
  dom.content.innerHTML = `<div class="page">
    <section class="project-hero" style="--project-color:${escapeHtml(project.color)}">
      <div class="project-hero-main"><span class="project-color-block"></span><div><span class="eyebrow">Project</span><h2>${escapeHtml(project.name)}</h2><p>${escapeHtml(project.description || 'A virtual collection of related Omnideck work.')}</p>${projectTags(project)}</div></div>
      <div class="heading-actions">
        <button class="button subtle" data-action="edit-project" data-project-id="${encoded(project.id)}">Edit</button>
        <button class="button subtle" data-action="delete-project" data-project-id="${encoded(project.id)}">Delete</button>
      </div>
    </section>
    <section class="project-summary-strip">
      <div class="project-summary-item"><span>Items</span><strong>${result.items.length}</strong></div>
      <div class="project-summary-item"><span>Conversation data</span><strong>${formatBytes(result.storage.conversation)}</strong></div>
      <div class="project-summary-item"><span>Artifact files</span><strong>${formatBytes(result.storage.artifact)}</strong></div>
      <div class="project-summary-item"><span>Other files</span><strong>${formatBytes(result.storage.files)}</strong></div>
    </section>
    <div class="toolbar"><span class="read-only-badge">Virtual collection</span><span class="toolbar-count">Removing an item here never deletes its source</span></div>
    <section class="data-panel">${result.items.length ? `<div class="item-list">${result.items.map((item) => itemRow(item, { projectId: project.id })).join('')}</div>` : emptyState('This project is empty', 'Select items from the Inbox, Conversations, Artifacts, or Files views, then add them here.', '<a class="button primary" href="#/inbox">Open inbox</a>')}</section>
  </div>`;
}

function reportFileRow(item, extra = '') {
  return `<div class="recent-item">
    <span class="type-icon file"><i class="bi bi-file-earmark" aria-hidden="true"></i></span>
    <div class="item-primary"><strong title="${escapeHtml(item.display_path)}">${escapeHtml(item.name || item.filename || item.title)}</strong><small>${escapeHtml(item.display_path || '')}${extra ? ` · ${escapeHtml(extra)}` : ''}</small></div>
    <span class="item-meta">${formatBytes(item.size)}</span>
  </div>`;
}

function reportPanel(title, count, body, emptyMessage) {
  return `<section class="panel"><div class="panel-heading"><h3>${escapeHtml(title)}</h3><span class="status-pill">${count}</span></div><div class="report-list">${count ? body : `<div class="empty-state compact"><div class="empty-mark">✓</div><h3>Nothing found</h3><p>${escapeHtml(emptyMessage)}</p></div>`}</div></section>`;
}

async function renderStorage() {
  setPage('Storage & cleanup', 'Review before acting');
  const report = await invoke('get_storage_report', { refresh: false });
  state.storageReport = report.available === false ? null : report;
  if (!state.storageReport) {
    dom.content.innerHTML = `<div class="page">
      ${listHeading('Storage & cleanup', 'Understand what is using space before deciding what to keep.')}
      <section class="storage-intro"><div><span class="read-only-badge">Read-only</span><h3>Start with a safe inventory</h3><p>The scan checks user-visible files, large and stale items, exact duplicates, missing artifact links, and artifacts whose source conversation is gone. It does not delete, move, rename, or rewrite anything.</p></div><button class="button primary" data-action="scan-storage">Run storage scan</button></section>
      ${emptyState('No scan has been run', 'The first scan can take a little while in a large Omnideck home directory.')}
    </div>`;
    return;
  }
  const summary = state.storageReport.summary;
  const duplicates = state.storageReport.duplicates.map((group) => `<div class="duplicate-group"><strong>${group.copies} exact copies · ${formatBytes(group.potential_savings)} potentially recoverable</strong><ul>${group.files.map((path) => `<li>${escapeHtml(path)}</li>`).join('')}</ul></div>`).join('');
  dom.content.innerHTML = `<div class="page">
    ${listHeading('Storage & cleanup', 'Review evidence before changing source content.', '<button class="button primary" data-action="scan-storage"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Scan again</button>')}
    <section class="storage-intro"><div><span class="read-only-badge">Read-only report</span><h3>No cleanup action runs from this screen</h3><p>Use this inventory to understand the environment and review specific files in their resource views. Artifact storage is counted separately from conversation storage elsewhere in the app.</p></div><strong>${formatBytes(summary.bytes)}</strong></section>
    <section class="report-grid">
      <div class="report-card"><span>Files scanned</span><strong>${summary.files}</strong><small>${summary.directories} folders${state.storageReport.truncated ? ' · scan limit reached' : ''}</small></div>
      <div class="report-card"><span>Large files</span><strong>${summary.large_files}</strong><small>25 MB or larger</small></div>
      <div class="report-card"><span>Exact duplicates</span><strong>${summary.duplicate_groups}</strong><small>${formatBytes(summary.duplicate_savings)} potential savings</small></div>
      <div class="report-card"><span>Broken artifact links</span><strong>${summary.missing_artifacts}</strong><small>${summary.orphaned_artifacts} with no source chat</small></div>
    </section>
    <div class="report-sections">
      ${reportPanel('Large files', state.storageReport.large_files.length, state.storageReport.large_files.map((item) => reportFileRow(item, formatDate(item.modified))).join(''), 'No files are 25 MB or larger.')}
      ${reportPanel('Exact duplicate groups', state.storageReport.duplicates.length, duplicates, 'No exact duplicates were found among eligible files.')}
      ${reportPanel('Older files to review', state.storageReport.stale_files.length, state.storageReport.stale_files.map((item) => reportFileRow(item, `Last changed ${formatDate(item.modified)}`)).join(''), 'No files older than 180 days were found.')}
      ${reportPanel('Missing artifact files', state.storageReport.missing_artifacts.length, state.storageReport.missing_artifacts.map((item) => reportFileRow(item, item.conversation_title || 'Source chat unavailable')).join(''), 'All indexed artifact files are present.')}
    </div>
    <p class="scan-meta">Scanned ${escapeHtml(formatDate(state.storageReport.scanned_at))}. Ignored common caches and dependency folders: ${escapeHtml(state.storageReport.ignored_directories.join(', '))}.</p>
  </div>`;
}

async function renderRoute({ preserveContent = false } = {}) {
  state.route = parseRoute(location.hash);
  state.visibleResources.clear();
  updateActiveNavigation();
  if (!preserveContent) showLoading();
  try {
    if (!state.dashboard) await loadDashboard();
    switch (state.route.view) {
      case 'home': renderHome(); break;
      case 'inbox': await renderInbox(); break;
      case 'conversations': await renderConversations(); break;
      case 'artifacts': await renderArtifacts(); break;
      case 'files': await renderFiles(); break;
      case 'storage': await renderStorage(); break;
      case 'project': await renderProject(state.route.id); break;
      default: renderHome();
    }
  } catch (error) {
    showError(error);
  }
}

function updateSelectionBar() {
  dom.selectionCount.textContent = state.selected.size;
  dom.selectionBar.hidden = state.selected.size === 0;
  document.querySelectorAll('[data-select-item]').forEach((checkbox) => {
    const key = itemKey(checkbox.dataset.type, decoded(checkbox.dataset.id));
    checkbox.checked = state.selected.has(key);
    checkbox.closest('.item-row')?.classList.toggle('selected', checkbox.checked);
  });
}

function clearSelection() {
  state.selected.clear();
  updateSelectionBar();
}

function renderColorOptions() {
  dom.colorOptions.innerHTML = COLORS.map((color) => `<button type="button" class="color-option ${color === state.selectedColor ? 'selected' : ''}" style="background:${color}" data-color="${color}" aria-label="Use color ${color}"></button>`).join('');
}

function openProjectModal(project = null) {
  state.editingProjectId = project?.id || null;
  state.selectedColor = project?.color || COLORS[0];
  dom.projectModalEyebrow.textContent = project ? 'Edit' : 'Create';
  dom.projectModalTitle.textContent = project ? 'Edit project' : 'New project';
  dom.projectSubmit.textContent = project ? 'Save changes' : 'Create project';
  dom.projectName.value = project?.name || '';
  dom.projectDescription.value = project?.description || '';
  dom.projectTags.value = project?.tags?.join(', ') || '';
  renderColorOptions();
  dom.projectModal.hidden = false;
  setTimeout(() => dom.projectName.focus(), 0);
}

function closeProjectModal() {
  dom.projectModal.hidden = true;
  state.editingProjectId = null;
}

function openConfirmation(message, callback) {
  dom.confirmMessage.textContent = message;
  state.confirmCallback = callback;
  dom.confirmModal.hidden = false;
}

function closeConfirmation() {
  dom.confirmModal.hidden = true;
  state.confirmCallback = null;
}

async function refreshAll(message = '') {
  state.dashboard = null;
  await loadDashboard();
  await renderRoute();
  if (message) showToast(message);
}

function findKnownItem(type, id) {
  const visible = state.visibleResources.get(itemKey(type, id));
  if (visible) return visible;
  if (state.currentProjectItems?.length) {
    const match = state.currentProjectItems.find((item) => item.type === type && item.id === id);
    if (match) return match;
  }
  return { type, id, title: typeLabel(type) };
}

function askAboutItem(type, id) {
  const item = findKnownItem(type, id);
  composeChat(`Tell me about this ${typeLabel(type).toLowerCase()} resource: “${item.title}”.`, {
    kind: 'omnideck-resource',
    source_app: 'omnideck-projects',
    resource: item,
  });
  showToast('Resource added to Omnideck chat');
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (!action) return;
  if (action === 'new-project') {
    openProjectModal();
  } else if (action === 'open-folder') {
    state.filePath = decoded(button.dataset.path);
    await renderRoute();
  } else if (action === 'toggle-hidden') {
    state.showHidden = !state.showHidden;
    await renderRoute();
  } else if (action === 'edit-project') {
    const id = decoded(button.dataset.projectId);
    const project = state.projects.find((candidate) => candidate.id === id) || state.currentProject;
    openProjectModal(project);
  } else if (action === 'delete-project') {
    const id = decoded(button.dataset.projectId);
    const project = state.projects.find((candidate) => candidate.id === id) || state.currentProject;
    openConfirmation(`Delete “${project.name}”?`, async () => {
      const result = await invoke('delete_project', { project_id: id });
      closeConfirmation();
      location.hash = routeHash('home');
      await refreshAll(`Deleted ${result.deleted_project}. Source content was untouched.`);
    });
  } else if (action === 'remove-item') {
    await invoke('remove_project_item', {
      project_id: decoded(button.dataset.projectId),
      item_type: button.dataset.type,
      item_id: decoded(button.dataset.id),
    });
    await refreshAll('Removed from project. Source content was untouched.');
  } else if (action === 'edit-note') {
    const current = decoded(button.dataset.note);
    const note = window.prompt('Project note (1,000 characters maximum):', current);
    if (note === null) return;
    await invoke('update_item_note', {
      project_id: decoded(button.dataset.projectId),
      item_type: button.dataset.type,
      item_id: decoded(button.dataset.id),
      note,
    });
    await renderRoute();
    showToast('Note saved');
  } else if (action === 'ask-item') {
    askAboutItem(button.dataset.type, decoded(button.dataset.id));
  } else if (action === 'conversation-details') {
    const row = button.closest('[data-resource-row]');
    const openPanel = row?.nextElementSibling;
    if (openPanel?.matches('[data-conversation-details]')) {
      openPanel.remove();
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    button.disabled = true;
    const conversationId = decoded(button.dataset.id);
    try {
      const details = await invoke('get_conversation_details', { conversation_id: conversationId });
      state.conversationDetails.set(conversationId, details);
      row?.insertAdjacentHTML('afterend', conversationDetailsPanel(details, decoded(button.dataset.defaultProjectId)));
      button.setAttribute('aria-expanded', 'true');
    } finally {
      button.disabled = false;
    }
  } else if (action === 'close-conversation-details') {
    const panel = button.closest('[data-conversation-details]');
    panel?.previousElementSibling?.querySelector('[data-action="conversation-details"]')?.setAttribute('aria-expanded', 'false');
    panel?.remove();
  } else if (action === 'assign-conversation-bundle') {
    const panel = button.closest('[data-conversation-details]');
    const projectId = panel?.querySelector('[data-bundle-project]')?.value;
    if (!projectId) {
      showToast('Choose a project first', 'error');
      return;
    }
    button.disabled = true;
    try {
      const result = await invoke('assign_conversation_bundle', {
        project_id: projectId,
        conversation_id: decoded(button.dataset.id),
      });
      const project = state.projects.find((candidate) => candidate.id === projectId);
      await refreshAll(result.added
        ? `Added the conversation and ${result.artifacts_added} ${result.artifacts_added === 1 ? 'artifact' : 'artifacts'} to ${project?.name || 'the project'}`
        : `Everything is already in ${project?.name || 'that project'}`);
    } finally {
      button.disabled = false;
    }
  } else if (action === 'ask-conversation-details') {
    const conversationId = decoded(button.dataset.id);
    const details = state.conversationDetails.get(conversationId);
    if (!details) return;
    composeChat(`Tell me about this conversation resource: “${details.conversation.title}”.`, {
      kind: 'omnideck-resource',
      source_app: 'omnideck-projects',
      resource: details.conversation,
      conversation_details: details,
    });
    showToast('Conversation resource added to Omnideck chat');
  } else if (action === 'scan-storage') {
    showLoading('Running a read-only storage scan…');
    state.storageReport = await invoke('get_storage_report', { refresh: true });
    await renderStorage();
    state.dashboard = null;
    await loadDashboard();
    showToast('Storage scan complete');
  }
}

dom.projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const wasEditing = Boolean(state.editingProjectId);
  const payload = {
    name: dom.projectName.value,
    description: dom.projectDescription.value,
    color: state.selectedColor,
    tags: dom.projectTags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  dom.projectSubmit.disabled = true;
  try {
    const result = state.editingProjectId
      ? await invoke('update_project', { project_id: state.editingProjectId, ...payload })
      : await invoke('create_project', payload);
    closeProjectModal();
    state.dashboard = null;
    await loadDashboard();
    location.hash = routeHash('project', result.project.id);
    await renderRoute();
    showToast(wasEditing ? 'Project updated' : 'Project created');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.projectSubmit.disabled = false;
  }
});

document.addEventListener('click', async (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) {
    event.preventDefault();
    try {
      await handleAction(actionButton);
    } catch (error) {
      showToast(error.message, 'error');
      await renderRoute({ preserveContent: true });
    }
  }
  if (event.target.closest('[data-close-modal]')) closeProjectModal();
  const colorButton = event.target.closest('[data-color]');
  if (colorButton) {
    state.selectedColor = colorButton.dataset.color;
    renderColorOptions();
  }
  if (event.target.closest('a[href^="#/"]')) document.body.classList.remove('sidebar-open');
});

document.addEventListener('change', async (event) => {
  if (event.target.matches('[data-select-item]')) {
    const item = { type: event.target.dataset.type, id: decoded(event.target.dataset.id) };
    const key = itemKey(item);
    if (event.target.checked) state.selected.set(key, item);
    else state.selected.delete(key);
    updateSelectionBar();
    return;
  }
  const filter = event.target.dataset.filter;
  if (filter === 'conversations-archive') state.filters.conversationsArchive = event.target.value;
  if (filter === 'conversations-assignment') state.filters.conversationsAssignment = event.target.value;
  if (filter === 'conversations-artifacts') state.filters.conversationsArtifacts = event.target.value;
  if (filter === 'conversations-sort') state.filters.conversationsSort = event.target.value;
  if (filter === 'artifacts-status') state.filters.artifactsStatus = event.target.value;
  if (filter === 'artifacts-assignment') state.filters.artifactsAssignment = event.target.value;
  if (filter) await renderRoute();
});

dom.newProject.addEventListener('click', () => openProjectModal());
dom.newProjectSidebar.addEventListener('click', () => openProjectModal());
dom.menu.addEventListener('click', () => document.body.classList.add('sidebar-open'));
dom.sidebarClose.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
dom.scrim.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
dom.clearSelection.addEventListener('click', clearSelection);
dom.confirmCancel.addEventListener('click', closeConfirmation);
dom.confirmAction.addEventListener('click', async () => {
  if (!state.confirmCallback) return;
  dom.confirmAction.disabled = true;
  try {
    await state.confirmCallback();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.confirmAction.disabled = false;
  }
});

dom.assignSelection.addEventListener('click', async () => {
  const projectId = dom.selectionProject.value;
  if (!projectId) {
    showToast('Choose a project first', 'error');
    return;
  }
  dom.assignSelection.disabled = true;
  try {
    const result = await invoke('assign_items', { project_id: projectId, items: [...state.selected.values()] });
    clearSelection();
    await refreshAll(`${result.added} ${result.added === 1 ? 'item' : 'items'} added to project`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.assignSelection.disabled = false;
  }
});

dom.refresh.addEventListener('click', async () => {
  dom.refresh.disabled = true;
  try {
    await refreshAll('Refreshed');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    dom.refresh.disabled = false;
  }
});

dom.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderRoute(), 220);
});

window.addEventListener('hashchange', () => {
  clearSelection();
  state.currentProject = null;
  state.currentProjectItems = [];
  renderRoute();
});

document.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (event.key === '/' && !typing) {
    event.preventDefault();
    dom.search.focus();
  }
  if (event.key === 'Escape') {
    closeProjectModal();
    closeConfirmation();
    document.body.classList.remove('sidebar-open');
  }
});

if (!location.hash) history.replaceState(null, '', routeHash('home'));
renderRoute();
