import { html } from '../lib/html.js';

const SAVE_TEXT = { idle: '', saving: 'Saving…', saved: 'Draft saved', error: 'Draft not saved. Retrying on the next change' };

export function Header({ slug, round, status, saveState, theme, onToggleTheme }) {
  return html`
    <header class="topbar">
      <div class="brand"><span class="logo" aria-hidden="true">◆</span> Kosmos review</div>
      <div class="crumbs"><code>${slug}</code> <span class="chip">round ${round}</span> ${status === 'submitted' && html`<span class="chip ok">submitted</span>`}</div>
      <div class="spacer"></div>
      <div class=${'save-state save-' + saveState} role="status" aria-live="polite">${SAVE_TEXT[saveState]}</div>
      <button type="button" class="small" onClick=${onToggleTheme} aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme">${theme === 'dark' ? 'Light' : 'Dark'}</button>
    </header>`;
}
