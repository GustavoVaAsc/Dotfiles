// Crawls what a browser would load for the page (HTML, stylesheets, classic scripts, the ES-module graph through
// the import map) and checks every file is served by the real server with a JavaScript/CSS content type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewServer } from '../src/server.js';
import { tmpProject } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('every file the page needs is served, and every import resolves', async () => {
  const p = await tmpProject();
  const instance = createReviewServer({ reviewDir: p.reviewDir, projectRoot: p.root, slug: p.slug, token: 'tok-0123456789', webDir: path.join(ROOT, 'web'), vendorDir: path.join(ROOT, 'vendor') });
  const { port } = await instance.start();
  const origin = `http://127.0.0.1:${port}`;
  try {
    const page = await (await fetch(origin + '/')).text();
    const importMap = JSON.parse(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(page)[1]).imports;

    const queue = [
      ...[...page.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
      ...[...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ];
    const seen = new Set();
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await fetch(origin + url);
      assert.equal(res.status, 200, `${url} -> ${res.status}`);
      const type = res.headers.get('content-type');
      if (url.endsWith('.css')) assert.match(type, /text\/css/, url);
      else assert.match(type, /text\/javascript/, url);
      if (url.endsWith('.css')) continue;
      const source = await res.text();
      const specifiers = [...source.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s[^'"`]*?from\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
      for (const spec of specifiers) {
        let target;
        if (importMap[spec]) target = importMap[spec];
        else if (spec.startsWith('.') || spec.startsWith('/')) target = new URL(spec, origin + url).pathname;
        else assert.fail(`${url} imports "${spec}", which the import map does not define`);
        queue.push(target);
      }
    }
    for (const required of ['/app.js', '/components/App.js', '/lib/markdown.js', '/vendor/preact/hooks.module.js', '/vendor/markdown-it/markdown-it.esm.min.mjs', '/styles/theme.css', '/theme-init.js']) {
      assert.ok(seen.has(required), `${required} should be part of the page's dependency graph`);
    }
    assert.equal((await fetch(origin + '/vendor/mermaid/mermaid.min.js')).status, 200, 'lazily loaded mermaid is served');
  } finally {
    await instance.close();
    await p.cleanup();
  }
});
