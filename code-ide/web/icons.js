/* ===== File Type Icons ===== */

export const FILE_ICONS = {
  '.py': { icon: 'bi-filetype-py', cls: 'icon-py', lang: 'Python' },
  '.js': { icon: 'bi-filetype-js', cls: 'icon-js', lang: 'JavaScript' },
  '.jsx': { icon: 'bi-filetype-js', cls: 'icon-js', lang: 'JavaScript' },
  '.ts': { icon: 'bi-filetype-tsx', cls: 'icon-ts', lang: 'TypeScript' },
  '.tsx': { icon: 'bi-filetype-tsx', cls: 'icon-ts', lang: 'TypeScript' },
  '.html': { icon: 'bi-filetype-html', cls: 'icon-html', lang: 'HTML' },
  '.htm': { icon: 'bi-filetype-html', cls: 'icon-html', lang: 'HTML' },
  '.css': { icon: 'bi-filetype-css', cls: 'icon-css', lang: 'CSS' },
  '.scss': { icon: 'bi-filetype-css', cls: 'icon-css', lang: 'SCSS' },
  '.json': { icon: 'bi-filetype-json', cls: 'icon-json', lang: 'JSON' },
  '.md': { icon: 'bi-filetype-md', cls: 'icon-md', lang: 'Markdown' },
  '.markdown': { icon: 'bi-filetype-md', cls: 'icon-md', lang: 'Markdown' },
  '.txt': { icon: 'bi-file-text', cls: 'icon-txt', lang: 'Plain Text' },
  '.go': { icon: 'bi-filetype-go', cls: 'icon-go', lang: 'Go' },
  '.sh': { icon: 'bi-filetype-sh', cls: 'icon-sh', lang: 'Shell' },
  '.bash': { icon: 'bi-filetype-sh', cls: 'icon-sh', lang: 'Shell' },
  '.yml': { icon: 'bi-filetype-yml', cls: 'icon-yml', lang: 'YAML' },
  '.yaml': { icon: 'bi-filetype-yml', cls: 'icon-yml', lang: 'YAML' },
  '.rs': { icon: 'bi-filetype-rs', cls: 'icon-rs', lang: 'Rust' },
  '.sql': { icon: 'bi-filetype-sql', cls: 'icon-sql', lang: 'SQL' },
  '.xml': { icon: 'bi-filetype-xml', cls: 'icon-xml', lang: 'XML' },
  '.toml': { icon: 'bi-file-text', cls: 'icon-toml', lang: 'TOML' },
  '.cfg': { icon: 'bi-gear', cls: 'icon-cfg', lang: 'Config' },
  '.ini': { icon: 'bi-gear', cls: 'icon-cfg', lang: 'INI' },
  '.env': { icon: 'bi-gear', cls: 'icon-cfg', lang: 'Env' },
  '.png': { icon: 'bi-file-image', cls: 'icon-img', lang: 'Image' },
  '.jpg': { icon: 'bi-file-image', cls: 'icon-img', lang: 'Image' },
  '.jpeg': { icon: 'bi-file-image', cls: 'icon-img', lang: 'Image' },
  '.gif': { icon: 'bi-file-image', cls: 'icon-img', lang: 'Image' },
  '.svg': { icon: 'bi-file-image', cls: 'icon-img', lang: 'SVG' },
  '.ico': { icon: 'bi-file-image', cls: 'icon-img', lang: 'Image' },
  '.pdf': { icon: 'bi-file-pdf', cls: 'icon-default', lang: 'PDF' },
  '.csv': { icon: 'bi-file-spreadsheet', cls: 'icon-default', lang: 'CSV' },
  '.log': { icon: 'bi-file-text', cls: 'icon-txt', lang: 'Log' },
  '.lock': { icon: 'bi-lock', cls: 'icon-default', lang: 'Lock' },
};

export function getFileIcon(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return { icon: 'bi-box', cls: 'icon-default', lang: 'Dockerfile' };
  if (lower === 'makefile') return { icon: 'bi-gear', cls: 'icon-default', lang: 'Makefile' };
  if (lower.startsWith('.env')) return { icon: 'bi-gear', cls: 'icon-cfg', lang: 'Env' };
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.substring(dot);
    if (FILE_ICONS[ext]) return FILE_ICONS[ext];
  }
  return { icon: 'bi-file-earmark', cls: 'icon-default', lang: 'Plain Text' };
}
