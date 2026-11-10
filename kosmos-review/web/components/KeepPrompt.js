import { useState } from 'preact/hooks';
import { html } from '../lib/html.js';

export function KeepPrompt({ reviewPath, onChoose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const choose = async (keep) => {
    setBusy(true);
    setError(null);
    try {
      await onChoose(keep);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return html`
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="keep-title">
        <h2 id="keep-title">Keep this review in the repo?</h2>
        <p>The review lives in <code>${reviewPath}/</code>: the document, its assets and one file per submitted round.</p>
        <ul>
          <li><strong>Keep</strong>: it is tracked like any other file.</li>
          <li><strong>Do not keep</strong>: the folder is added to <code>.git/info/exclude</code> (local only; <code>.gitignore</code> is not touched). In a git worktree or submodule nothing is written automatically; you are shown the line to add yourself.</li>
        </ul>
        ${error && html`<p class="error">${error}</p>`}
        <div class="row">
          <button type="button" class="primary" disabled=${busy} onClick=${() => choose(true)}>Keep in the repo</button>
          <button type="button" disabled=${busy} onClick=${() => choose(false)}>Do not keep</button>
        </div>
      </div>
    </div>`;
}
