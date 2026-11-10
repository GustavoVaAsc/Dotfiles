// Post-render enhancers (assets, Mermaid, scrolling) against hand-made DOM fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, Element_ } from './fake-dom.js';
import { loadAssets } from '../web/lib/assets.js';
import { renderMermaid } from '../web/lib/mermaid.js';
import { findBlock } from '../web/lib/dom.js';

let dom;
before(() => {
  dom = installFakeDom();
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => `val(${name})` });
});
after(() => {
  delete globalThis.mermaid;
  delete globalThis.getComputedStyle;
  dom.restore();
});

const withChildren = (nodes) => ({ querySelectorAll: () => nodes });
const settle = () => new Promise((r) => setTimeout(r, 10));

function assetEl(path) {
  const el = new Element_('img');
  el.dataset = { asset: path };
  return el;
}

test('loadAssets gives each image a blob URL, revokes it once the image has loaded, and marks failures', async () => {
  const ok = assetEl('assets/a.png');
  const bad = assetEl('assets/missing.png');
  const requested = [];
  const assetBlob = async (p) => {
    requested.push(p);
    if (p.includes('missing')) throw new Error('404 Not Found');
    return { size: 1 };
  };
  const urls = { created: [], revoked: [] };
  const blobUrls = { create: () => { urls.created.push('blob:1'); return 'blob:1'; }, revoke: (u) => urls.revoked.push(u) };
  const root = withChildren([ok, bad]);
  loadAssets(root, assetBlob, blobUrls);
  await settle();
  assert.equal(ok.src, 'blob:1');
  assert.deepEqual(urls.revoked, [], 'not revoked before the image has decoded');
  ok.onload();
  assert.deepEqual(urls.revoked, ['blob:1'], 'revoked after load, so it cannot be opened as a same-origin document');
  assert.equal(bad.dataset.assetState, 'error');
  assert.match(bad.title, /Could not load assets\/missing.png: 404/);
  loadAssets(root, assetBlob, blobUrls);
  await settle();
  assert.equal(requested.length, 2, 'already-handled elements are not fetched again');
});

test('loadAssets keeps the blob URL of a video (streaming needs it) and revokes on image error too', async () => {
  const video = new Element_('video');
  video.dataset = { asset: 'assets/v.mp4' };
  const img = assetEl('assets/b.png');
  const revoked = [];
  loadAssets(withChildren([video, img]), async () => ({ size: 1 }), { create: () => 'blob:x', revoke: (u) => revoked.push(u) });
  await settle();
  assert.equal(video.src, 'blob:x');
  assert.ok(!video.onload);
  img.onerror();
  assert.deepEqual(revoked, ['blob:x']);
});

test('loadAssets: a cancelled run does not touch the elements', async () => {
  const el = assetEl('assets/a.png');
  const stop = loadAssets(withChildren([el]), async () => ({ size: 1 }), { create: () => 'blob:late', revoke() {} });
  stop();
  await settle();
  assert.equal(el.src, undefined);
});

function mermaidBlock(source) {
  const el = new Element_('div');
  el.dataset = {};
  const code = { textContent: source };
  el.querySelector = (sel) => (sel === 'code' ? code : null);
  return el;
}

test('renderMermaid draws each block with securityLevel strict and keeps the source for re-render', async () => {
  const calls = { init: [], render: [] };
  globalThis.mermaid = {
    initialize: (cfg) => calls.init.push(cfg),
    render: async (id, src) => { calls.render.push([id, src]); return { svg: `<svg data-for="${src}"></svg>` }; },
  };
  const block = mermaidBlock('graph TD\n A-->B');
  await renderMermaid(withChildren([block]));
  assert.equal(calls.init[0].securityLevel, 'strict');
  assert.equal(calls.init[0].startOnLoad, false);
  assert.equal(block.innerHTML, '<svg data-for="graph TD\n A-->B"></svg>');
  assert.equal(block.dataset.mermaid, 'graph TD\n A-->B');
  block.querySelector = () => null; // after the first render the <code> is gone; the stored source is used
  await renderMermaid(withChildren([block]));
  assert.equal(calls.render[1][1], 'graph TD\n A-->B');
});

test('renderMermaid shows the source and the error when a diagram does not parse', async () => {
  globalThis.mermaid = {
    initialize() {},
    render: async () => { throw new Error('Parse error on line 2'); },
  };
  const block = mermaidBlock('graph ???');
  await renderMermaid(withChildren([block]));
  assert.ok(block.classList.contains('mermaid-error'));
  assert.ok(block.textContent.includes('graph ???'));
  assert.ok(block.textContent.includes('Diagram error: Parse error on line 2'));
});

test('renderMermaid does nothing, and loads nothing, when there is no diagram', async () => {
  delete globalThis.mermaid;
  await renderMermaid(withChildren([]));
  assert.equal(globalThis.mermaid, undefined);
});

test('renderMermaid stops when cancelled', async () => {
  let rendered = 0;
  globalThis.mermaid = { initialize() {}, render: async () => { rendered += 1; return { svg: '<svg></svg>' }; } };
  await renderMermaid(withChildren([mermaidBlock('a'), mermaidBlock('b')]), () => true);
  assert.equal(rendered, 0);
});

test('findBlock picks the smallest block containing the line, else the next block', () => {
  const block = (s, e) => { const el = new Element_('p'); el.dataset = { lineStart: String(s), lineEnd: String(e) }; return el; };
  const outer = block(1, 10);
  const inner = block(4, 5);
  const later = block(20, 21);
  const root = withChildren([outer, inner, later]);
  assert.equal(findBlock(root, 4), inner);
  assert.equal(findBlock(root, 8), outer);
  assert.equal(findBlock(root, 15), later);
  assert.equal(findBlock(root, 99), null);
});
