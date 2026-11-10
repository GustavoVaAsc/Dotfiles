import { useEffect, useRef } from 'preact/hooks';
import { html } from '../lib/html.js';
import { loadAssets } from '../lib/assets.js';
import { renderMermaid } from '../lib/mermaid.js';

/**
 * One run of rendered Markdown. The HTML comes from lib/markdown.js (markdown-it with raw HTML off),
 * so it is trusted markup; after it is in the DOM, images are fetched with the token and diagrams drawn.
 * Preact does not touch the inner HTML again while `markup` stays the same string.
 */
export function MarkdownChunk({ markup, assetBlob, theme }) {
  const ref = useRef(null);

  useEffect(() => loadAssets(ref.current, assetBlob), [markup]);

  useEffect(() => {
    let cancelled = false;
    renderMermaid(ref.current, () => cancelled).catch((err) => console.error('mermaid', err));
    return () => { cancelled = true; };
  }, [markup, theme]);

  return html`<div class="md" ref=${ref} dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}
