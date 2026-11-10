import { html } from '../lib/html.js';
import { lineLabel } from './CommentComposer.js';

export function CommentList({ comments, docHash, onEdit, onDelete, onJump }) {
  if (comments.length === 0) {
    return html`<section class="panel"><h2>Comments</h2><p class="muted">No comments yet. Hover a paragraph, heading, list item, table row or code block and click the + in the margin.</p></section>`;
  }
  const sorted = [...comments].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return html`
    <section class="panel" aria-label="Comments">
      <h2>Comments <span class="chip">${comments.length}</span></h2>
      <ul class="comments">
        ${sorted.map((c) => html`
          <li key=${c.id} class="comment">
            <div class="comment-head">
              <button type="button" class="link" onClick=${() => onJump(c.startLine)}>${lineLabel(c)}</button>
              ${c.docHash !== docHash && html`<span class="badge warn" title="Made against an earlier version of the document; check the lines still match">earlier version</span>`}
            </div>
            <blockquote class="quote">${c.quote}</blockquote>
            <p class="comment-text">${c.text}</p>
            <div class="row">
              <button type="button" class="small" onClick=${() => onEdit(c.id)}>Edit</button>
              <button type="button" class="small danger" onClick=${() => onDelete(c.id)}>Delete</button>
            </div>
          </li>`)}
      </ul>
    </section>`;
}
