const ROUTES = new Set([
  'home',
  'inbox',
  'conversations',
  'artifacts',
  'files',
  'storage',
  'project',
]);

export function parseRoute(hash = '') {
  const clean = String(hash).replace(/^#\/?/, '');
  const [rawView = 'home', rawId = ''] = clean.split('/');
  const view = ROUTES.has(rawView) ? rawView : 'home';
  let id = '';
  try {
    id = decodeURIComponent(rawId);
  } catch {
    id = '';
  }
  if (view === 'project' && !id) return { view: 'home', id: '' };
  return { view, id };
}

export function routeHash(view, id = '') {
  return `#/${view}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

export function formatDate(value, now = Date.now()) {
  if (!value) return 'Unknown date';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  const delta = now - date.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (delta >= 0 && delta < day) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (delta >= day && delta < 7 * day) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function itemKey(itemOrType, maybeId) {
  const type = typeof itemOrType === 'string' ? itemOrType : itemOrType.type;
  const id = typeof itemOrType === 'string' ? maybeId : itemOrType.id;
  return `${type}\u0000${id}`;
}

export function splitItemKey(key) {
  const separator = key.indexOf('\u0000');
  return { type: key.slice(0, separator), id: key.slice(separator + 1) };
}

export function typeLabel(type, plural = false) {
  const labels = {
    conversation: ['Conversation', 'Conversations'],
    artifact: ['Artifact', 'Artifacts'],
    file: ['File', 'Files'],
    folder: ['Folder', 'Folders'],
  };
  return (labels[type] || ['Item', 'Items'])[plural ? 1 : 0];
}

export function typeGlyph(type) {
  return { conversation: '◌', artifact: '◇', file: '▤', folder: '▱' }[type] || '·';
}

export function fileUrl(path) {
  if (!path || !String(path).startsWith('/')) return '#';
  return String(path)
    .split('/')
    .map((segment, index) => (index === 0 ? '' : encodeURIComponent(segment)))
    .join('/');
}

export function projectPrompt(project, items = []) {
  const counts = items.reduce((result, item) => {
    result[item.type] = (result[item.type] || 0) + 1;
    return result;
  }, {});
  const summary = Object.entries(counts)
    .map(([type, count]) => `${count} ${typeLabel(type, count !== 1).toLowerCase()}`)
    .join(', ');
  return `Help me review and organize my Omnideck project “${project.name}”.${summary ? ` It currently contains ${summary}.` : ''} Suggest a useful structure, identify anything that may be misplaced or missing, and propose next steps. Do not move or delete files unless I explicitly approve it.`;
}
