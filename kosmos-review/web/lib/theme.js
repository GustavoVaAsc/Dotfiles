// Light/dark switch. theme-init.js sets the initial value before first paint; this module changes it.
const KEY = 'kosmos-review-theme';

export function currentTheme(doc = document) {
  return doc.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme, { doc = document, storage = globalThis.localStorage } = {}) {
  doc.documentElement.setAttribute('data-theme', theme);
  try {
    storage.setItem(KEY, theme);
  } catch { /* storage blocked: the choice just does not persist */ }
}
