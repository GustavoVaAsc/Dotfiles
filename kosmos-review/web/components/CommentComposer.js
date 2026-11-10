import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';

const label = (c) => (c.endLine > c.startLine ? `Lines ${c.startLine}-${c.endLine}` : `Line ${c.startLine}`);
export { label as lineLabel };

/** Textarea for a new or edited comment. The text lives here so extending the range does not lose it. */
export function CommentComposer({ composer, onSave, onCancel }) {
  const [text, setText] = useState(composer.text);
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), [composer.id]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSave(text);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return html`
    <section class="panel composer" aria-label="Comment">
      <h2>${composer.id ? 'Edit comment' : 'New comment'} <span class="chip">${label(composer)}</span></h2>
      <blockquote class="quote">${composer.quote || '(empty lines)'}</blockquote>
      <textarea ref=${ref} rows="5" placeholder="What should change, and how?" value=${text}
        onInput=${(e) => setText(e.target.value)} onKeyDown=${onKeyDown}></textarea>
      <div class="row">
        <button type="button" class="primary" disabled=${text.trim() === ''} onClick=${() => onSave(text)}>Save comment</button>
        <button type="button" onClick=${onCancel}>Cancel</button>
        <span class="hint">Ctrl+Enter saves${composer.id ? '' : '. Shift+click another block’s + to extend the range'}</span>
      </div>
    </section>`;
}
