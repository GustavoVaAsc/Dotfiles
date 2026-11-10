// Markdown pipeline. Pure: the caller passes in markdown-it (and optionally highlight.js),
// so this module has no import-map dependency and also runs under Node for the tests and the CLI.
//
// Safety: markdown-it runs with html:false, so raw HTML in the document is escaped, and its default
// link validation refuses javascript:, vbscript: and data: URLs. Images never get a src attribute:
// only files under assets/ are shown, and the page fetches them with the access token (see lib/assets.js).
//
// Anchors: every commentable block gets data-line-start / data-line-end, the 1-based inclusive
// source line range taken from markdown-it's token.map.
import { parseQuestion, QUESTION_LANG } from './question-fence.js';

const VIDEO_RE = /\.(mp4|m4v|webm|ogv|mov)$/i;
const infoWord = (info) => info.trim().split(/\s+/)[0] || '';

/** Returns the (still percent-encoded) assets/... path, or null when the reference is not allowed. */
function assetPath(src) {
  const relative = src.replace(/^\.\//, '');
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  if (!decoded.startsWith('assets/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.slice('assets/'.length).split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'))) return null;
  return relative;
}

/** Tags the blocks a reviewer can comment on with their source line range. */
function annotate(tokens) {
  tokens.forEach((token, i) => {
    if (!token.map) return;
    const start = token.map[0] + 1;
    let end = token.map[1];
    switch (token.type) {
      case 'heading_open':
      case 'tr_open':
      case 'code_block':
        break;
      case 'paragraph_open':
        if (token.hidden) return;
        break;
      case 'fence':
        // The default fence renderer puts token attrs on <code>; the renderer rule below reads meta instead.
        token.meta = { ...token.meta, anchor: [start, end] };
        return;
      case 'list_item_open': {
        // Tight item: its paragraph is hidden, so the item itself is the block. Its range is that paragraph's
        // (first line to last line of its own text), not the item's: the item also spans nested lists, fenced
        // blocks and the blank line after it, which have their own anchors or belong to nothing.
        const first = tokens[i + 1];
        if (!(first && first.type === 'paragraph_open' && first.hidden && first.map)) return;
        end = first.map[1];
        break;
      }
      default:
        return;
    }
    token.attrSet('data-line-start', String(start));
    token.attrSet('data-line-end', String(end));
  });
}

export function createMarkdown({ markdownit, hljs = null }) {
  const md = markdownit({
    html: false,
    linkify: false,
    typographer: false,
    highlight: hljs
      ? (code, lang) => {
          if (lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
            } catch { /* fall back to plain text */ }
          }
          return '';
        }
      : undefined,
  });
  const esc = md.utils.escapeHtml;

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const [start, end] = token.meta?.anchor ?? [];
    const attrs = start ? ` data-line-start="${start}" data-line-end="${end}"` : '';
    if (infoWord(token.info) === 'mermaid') {
      return `<div class="mermaid-block"${attrs}><pre><code>${esc(token.content)}</code></pre></div>\n`;
    }
    return defaultFence(tokens, idx, options, env, self).replace(/^<pre/, `<pre${attrs}`);
  };

  const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    } else if (!/^(#|mailto:)/i.test(href)) {
      // A relative link would navigate the page away from the review server.
      token.attrs = token.attrs.filter(([name]) => name !== 'href');
      token.attrSet('class', 'link-unresolved');
      token.attrSet('title', href);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') || '';
    const alt = self.renderInlineAsText(token.children, options, env);
    const asset = assetPath(src);
    if (!asset) {
      return `<span class="asset-missing" title="${esc(`Only files under assets/ can be shown: ${src}`)}">[image: ${esc(alt || src)}]</span>`;
    }
    if (VIDEO_RE.test(asset)) {
      return `<video controls preload="metadata" aria-label="${esc(alt)}" data-asset="${esc(asset)}"></video>`;
    }
    return `<img alt="${esc(alt)}" loading="lazy" data-asset="${esc(asset)}">`;
  };

  return {
    /**
     * @returns {{ segments: Array, questions: Array, issues: {line:number,message:string}[] }}
     *   segments are { kind:'html', html } or { kind:'question', question|null, errors, raw, startLine, endLine }
     */
    parse(text) {
      const env = {};
      const tokens = md.parse(text, env);
      annotate(tokens);

      const segments = [];
      const questions = [];
      const issues = [];
      const firstLineOf = new Map();
      let buffer = [];
      const flush = () => {
        if (buffer.length) segments.push({ kind: 'html', html: md.renderer.render(buffer, md.options, env) });
        buffer = [];
      };

      for (const token of tokens) {
        if (token.type !== 'fence' || infoWord(token.info) !== QUESTION_LANG) {
          buffer.push(token);
          continue;
        }
        const startLine = token.map[0] + 1;
        if (token.level !== 0) {
          issues.push({ line: startLine, message: 'question fences must be at the top level of the document (not inside a list or quote); shown as plain code' });
          buffer.push(token);
          continue;
        }
        flush();
        const parsed = parseQuestion(token.content, { firstLine: startLine + 1 });
        let question = null;
        let errors = [];
        if (!parsed.ok) {
          errors = parsed.errors;
        } else if (firstLineOf.has(parsed.question.id)) {
          errors = [{ line: startLine, message: `duplicate question id "${parsed.question.id}" (first used on line ${firstLineOf.get(parsed.question.id)})` }];
        } else {
          question = parsed.question;
          firstLineOf.set(question.id, startLine);
          questions.push(question);
        }
        issues.push(...errors);
        segments.push({ kind: 'question', question, errors, raw: token.content, startLine, endLine: token.map[1] });
      }
      flush();
      issues.sort((a, b) => a.line - b.line);
      return { segments, questions, issues };
    },

    /** Inline markdown (code spans, emphasis, links) for question prompts and option labels. */
    renderInline(text) {
      return md.renderInline(text);
    },
  };
}
