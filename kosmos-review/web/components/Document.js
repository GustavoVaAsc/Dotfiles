import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { rangesOverlap } from '../lib/anchors.js';
import { MarkdownChunk } from './MarkdownChunk.js';
import { Question } from './Question.js';

/**
 * The rendered document. Hovering a block shows a "+" in the gutter; clicking it starts a comment on that
 * block's source lines (Shift+click adds the block to the comment being written). Blocks that have comments
 * are marked through classes set directly on the rendered DOM, which Preact leaves alone.
 */
export function Document({ segments, markdown, comments, composer, answers, readOnly, onAnswer, onPickBlock, assetBlob, theme }) {
  const rootRef = useRef(null);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    rootRef.current.querySelectorAll('.md [data-line-start]').forEach((el) => {
      const range = { startLine: Number(el.dataset.lineStart), endLine: Number(el.dataset.lineEnd) };
      const count = comments.filter((c) => rangesOverlap(c, range)).length;
      el.classList.toggle('has-comment', count > 0);
      el.classList.toggle('is-composing', Boolean(composer) && rangesOverlap(composer, range));
    });
  });

  const onMouseOver = (event) => {
    if (readOnly) return;
    const block = event.target.closest?.('[data-line-start]');
    if (!block || !rootRef.current.contains(block)) return;
    const top = block.getBoundingClientRect().top - rootRef.current.getBoundingClientRect().top;
    const next = { top: Math.round(top), startLine: Number(block.dataset.lineStart), endLine: Number(block.dataset.lineEnd) };
    setHover((prev) => (prev && prev.top === next.top && prev.startLine === next.startLine && prev.endLine === next.endLine ? prev : next));
  };

  const overlaps = (range) => comments.some((c) => rangesOverlap(c, range));

  return html`
    <article class="doc" ref=${rootRef} onMouseOver=${onMouseOver} onMouseLeave=${() => setHover(null)}>
      ${segments.map((segment, i) => (segment.kind === 'question'
        ? html`<${Question} key=${i} segment=${segment} markdown=${markdown} readOnly=${readOnly}
            answer=${segment.question && answers[segment.question.id]}
            onChange=${(patch) => segment.question && onAnswer(segment.question.id, patch)}
            commented=${overlaps(segment)} composing=${Boolean(composer) && rangesOverlap(composer, segment)} />`
        : html`<${MarkdownChunk} key=${i} markup=${segment.html} assetBlob=${assetBlob} theme=${theme} />`))}
      ${hover && !readOnly && html`
        <button type="button" class="gutter-add" style=${{ top: `${hover.top}px` }}
          title=${`Comment on line${hover.endLine > hover.startLine ? `s ${hover.startLine}-${hover.endLine}` : ` ${hover.startLine}`} (Shift+click adds to the open comment)`}
          aria-label="Add comment on this block"
          onClick=${(e) => onPickBlock({ startLine: hover.startLine, endLine: hover.endLine }, e.shiftKey)}>+</button>`}
    </article>`;
}
