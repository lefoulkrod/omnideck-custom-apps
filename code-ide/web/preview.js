/* ===== File Preview (images, PDFs) ===== */

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp'];
export const PDF_EXTS = ['.pdf'];

export function isPreviewable(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.substring(dot);
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (PDF_EXTS.includes(ext)) return 'pdf';
  return null;
}

export function renderPreview(tab, path) {
  const type = isPreviewable(tab.name);
  if (!type) return null;

  // Custom Apps and home files are served from the same Omnideck origin.
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const version = tab.previewVersion ? `?v=${tab.previewVersion}` : '';
  const fileUrl = encodedPath + version;

  const container = document.createElement('div');
  container.className = 'preview-container';

  if (type === 'image') {
    const img = document.createElement('img');
    img.className = 'preview-image';
    img.src = fileUrl;
    img.alt = tab.name;
    img.onerror = () => {
      container.innerHTML = '<div class="preview-error"><i class="bi bi-exclamation-triangle"></i><span>Failed to load image</span></div>';
    };
    container.appendChild(img);
  } else if (type === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.className = 'preview-pdf';
    iframe.src = fileUrl;
    iframe.title = tab.name;
    container.appendChild(iframe);
  }

  return container;
}
