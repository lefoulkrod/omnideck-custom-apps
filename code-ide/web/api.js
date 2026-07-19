/* ===== API Helpers & Toast ===== */

import { dom } from './dom.js';

export async function api(action, params = {}) {
  try {
    const result = await window.omnideck.invoke(action, params);
    return result;
  } catch (e) {
    console.error('API error:', action, e);
    return { error: e.message || String(e) };
  }
}

let toastTimer = null;

export function showToast(msg, type = 'success') {
  dom.toastMsg.textContent = msg;
  dom.toast.className = 'toast visible ' + type;
  const icon = dom.toast.querySelector('i');
  if (type === 'success') icon.className = 'bi bi-check-circle';
  else if (type === 'error') icon.className = 'bi bi-x-circle';
  else icon.className = 'bi bi-info-circle';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove('visible');
  }, 2500);
}
