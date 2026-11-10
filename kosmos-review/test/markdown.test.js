import { test } from 'node:test';
import assert from 'node:assert/strict';
import markdownit from '#markdown-it';
import hljs from '#highlight.js';
import { createMarkdown } from '../web/lib/markdown.js';

const md = createMarkdown({ markdownit, hljs });
const htmlOf = (src) => md.parse(src).segments.filter((s) => s.kind === 'html').map((s) => s.html).join('');
const ANCHOR = /data-line-start="(\d+)" data-line-end="(\d+)"/g;
const anchorsOf = (html) => [...html.matchAll(ANCHOR)].map((m) => [Number(m[1]), Number(m[2])]);

test('paragraphs and headings carry 1-based inclusive source line ranges', () => {
  const html = htmlOf('# Title\n\nFirst\nsecond line\n\nLast\n');
  assert.match(html, /<h1 data-line-start="1" data-line-end="1">Title<\/h1>/);
  assert.deepEqual(anchorsOf(html), [[1, 1], [3, 4], [6, 6]]);
});

test('tight list items are anchored and clipped before their nested list', () => {
  const html = htmlOf('- a\n  - b\n- c\n');
  assert.deepEqual(anchorsOf(html), [[1, 1], [2, 2], [3, 3]]);
});

test('loose list items anchor their paragraphs instead of the whole item', () => {
  const html = htmlOf('- one\n\n  more\n\n- two\n');
  assert.deepEqual(anchorsOf(html), [[1, 1], [3, 3], [5, 5]]);
});

test('table rows and code blocks are anchored', () => {
  const html = htmlOf('| h | i |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a = 1;\n```\n\n    indented\n');
  assert.deepEqual(anchorsOf(html), [[1, 1], [3, 3], [5, 7], [9, 9]]);
  assert.match(html, /<pre data-line-start="5" data-line-end="7"><code class="language-js">/);
});

test('code is syntax highlighted and unknown languages are escaped', () => {
  assert.match(htmlOf('```js\nconst a = 1;\n```\n'), /hljs-keyword/);
  assert.match(htmlOf('```nonsense\n<b>x</b>\n```\n'), /&lt;b&gt;x&lt;\/b&gt;/);
});

test('raw HTML in the document is escaped, not rendered', () => {
  const html = htmlOf('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\ntext <b onclick="x()">b</b>\n');
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<b /i.test(html));
  assert.match(html, /&lt;script&gt;/);
});

test('javascript: and data: links are not turned into links', () => {
  const html = htmlOf('[x](javascript:alert(1)) [y](data:text/html;base64,AAAA) [z](vbscript:x)\n');
  assert.ok(!/href="(javascript|data|vbscript):/i.test(html), html);
});

test('external links open safely; relative links lose their href', () => {
  const html = htmlOf('[ext](https://example.com) [rel](other.md) [hash](#top)\n');
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">ext<\/a>/);
  assert.ok(!/href="other.md"/.test(html));
  assert.match(html, /link-unresolved/);
  assert.match(html, /href="#top"/);
});

test('images under assets/ become lazy-loaded data-asset elements; everything else is refused', () => {
  const html = htmlOf('![diagram](assets/a%20b.png) ![remote](https://evil.example/x.png) ![up](assets/../secret.png) ![abs](/etc/passwd) ![root](x.png)\n');
  assert.match(html, /<img[^>]*data-asset="assets\/a%20b.png"/);
  assert.ok(!/src=/.test(html), 'no src attribute is ever emitted');
  assert.equal((html.match(/asset-missing/g) || []).length, 4);
  assert.ok(!/evil\.example"/.test(html.replace(/title="[^"]*"/g, '')));
});

test('a video extension renders a video element', () => {
  const html = htmlOf('![demo](assets/clip.mp4)\n');
  assert.match(html, /<video[^>]*controls[^>]*data-asset="assets\/clip.mp4"/);
});

test('mermaid fences become mermaid blocks that still hold the source as text', () => {
  const html = htmlOf('```mermaid\ngraph TD\n  A-->B\n```\n');
  assert.match(html, /<div class="mermaid-block" data-line-start="1" data-line-end="4"><pre><code>graph TD\n  A--&gt;B\n<\/code><\/pre><\/div>/);
});

const Q = '```kosmos-question\nid: q1\ntype: single\nprompt: Pick `one`\noptions:\n  - A\n  - B\n```\n';

test('top-level question fences split the document into segments and are collected', () => {
  const doc = md.parse('# T\n\n' + Q + '\nAfter.\n');
  assert.deepEqual(doc.segments.map((s) => s.kind), ['html', 'question', 'html']);
  assert.equal(doc.questions.length, 1);
  assert.equal(doc.questions[0].id, 'q1');
  const seg = doc.segments[1];
  assert.equal(seg.startLine, 3);
  assert.equal(seg.endLine, 10);
  assert.deepEqual(doc.issues, []);
  assert.match(htmlOf('# T\n\n' + Q + '\nAfter.\n'), /After\./);
});

test('segment HTML is balanced when a question sits between list items of other blocks', () => {
  const doc = md.parse('- a\n- b\n\n' + Q + '\n- c\n');
  assert.deepEqual(doc.segments.map((s) => s.kind), ['html', 'question', 'html']);
  assert.equal((doc.segments[0].html.match(/<ul>/g) || []).length, (doc.segments[0].html.match(/<\/ul>/g) || []).length);
});

test('a malformed question yields an error segment and an issue with a document line', () => {
  const doc = md.parse('intro\n\n```kosmos-question\nid: q1\ntype: radio\nprompt: P\n```\n');
  const seg = doc.segments.find((s) => s.kind === 'question');
  assert.equal(seg.question, null);
  assert.ok(seg.errors.length > 0);
  assert.equal(seg.raw, 'id: q1\ntype: radio\nprompt: P\n');
  assert.equal(doc.questions.length, 0);
  assert.equal(doc.issues[0].line, 5);
});

test('duplicate question ids are reported on the second occurrence', () => {
  const body = 'id: same\ntype: text\nprompt: P\n';
  const doc = md.parse('```kosmos-question\n' + body + '```\n\n```kosmos-question\n' + body + '```\n');
  assert.equal(doc.questions.length, 1);
  assert.ok(doc.issues.some((i) => /duplicate/.test(i.message) && i.line >= 6));
});

test('a question fence nested in a list stays a plain code block and is reported', () => {
  const doc = md.parse('- item\n\n  ```kosmos-question\n  id: q\n  type: text\n  prompt: P\n  ```\n');
  assert.equal(doc.segments.every((s) => s.kind === 'html'), true);
  assert.equal(doc.questions.length, 0);
  assert.ok(doc.issues.some((i) => /top level/.test(i.message)));
});

test('question fences inside a longer outer fence are just text', () => {
  const doc = md.parse('````md\n' + Q + '````\n');
  assert.equal(doc.questions.length, 0);
  assert.deepEqual(doc.issues, []);
});

test('a document without questions or with an unclosed question fence does not throw', () => {
  assert.equal(md.parse('').segments.length, 0);
  assert.doesNotThrow(() => md.parse('```kosmos-question\nid: q\n'));
});

test('renderInline renders markdown but never raw HTML', () => {
  assert.equal(md.renderInline('use `x` <script>1</script>'), 'use <code>x</code> &lt;script&gt;1&lt;/script&gt;');
});

test('works without a highlighter (used by the check command)', () => {
  const plain = createMarkdown({ markdownit });
  assert.match(plain.parse('```js\nlet a;\n```\n').segments[0].html, /let a;/);
});

// ---- fix round 1 ----

test('a tight list item that holds a fenced block is anchored on its own text only', () => {
  const html = htmlOf('- item\n  ```js\n  let a;\n  ```\n- next\n');
  assert.deepEqual(anchorsOf(html), [[1, 1], [2, 4], [5, 5]]);
});

test('a tight item followed by a blank line does not claim the blank line', () => {
  const html = htmlOf('- a\n- b\n\nAfter.\n');
  assert.deepEqual(anchorsOf(html), [[1, 1], [2, 2], [4, 4]]);
});

test('a tight item with a nested blockquote and an ordered sublist is clipped before them', () => {
  const html = htmlOf('1. one\n   > quoted\n2. two\n   1. sub\n');
  assert.deepEqual(anchorsOf(html), [[1, 1], [2, 2], [3, 3], [4, 4]]);
});
