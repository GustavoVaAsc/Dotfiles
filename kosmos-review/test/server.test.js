import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReviewServer } from '../src/server.js';
import { tmpProject, tmpDir, validReview, comment, answer } from './helpers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'test-token-0123456789';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function boot(opts = {}) {
  const p = await tmpProject({ git: opts.git, doc: opts.doc });
  const instance = createReviewServer({
    reviewDir: p.reviewDir,
    projectRoot: p.root,
    slug: p.slug,
    token: TOKEN,
    idleMs: opts.idleMs ?? 0,
    onIdle: opts.onIdle,
    listenerLeaseMs: opts.listenerLeaseMs,
    ticketTtlMs: opts.ticketTtlMs,
    launcherPath: opts.launcherPath,
    launcherTtlMs: opts.launcherTtlMs,
    roundKey: opts.roundKey,
    webDir: path.join(ROOT, 'web'),
    vendorDir: path.join(ROOT, 'vendor'),
  });
  const { port } = await instance.start();
  cleanups.push(async () => { await instance.close(); await p.cleanup(); });

  function request(method, url, { headers = {}, body, host } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(host === undefined ? {} : { host }), ...headers, ...(data === undefined ? {} : { 'content-length': Buffer.byteLength(data) }) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json; try { json = JSON.parse(raw.toString('utf8')); } catch { json = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8'), json });
        });
      });
      req.on('error', reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }
  const auth = { authorization: 'Bearer ' + TOKEN };
  const write = { ...auth, 'content-type': 'application/json' };
  return { p, instance, port, request, auth, write };
}

test('binds to 127.0.0.1 only', async () => {
  const { instance } = await boot();
  assert.equal(instance.server.address().address, '127.0.0.1');
});

test('serves the app shell without a token and sets a nonce-based CSP', async () => {
  const { request } = await boot();
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  const csp = res.headers['content-security-policy'];
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, 'CSP carries a nonce');
  assert.ok(res.text.includes(`nonce="${nonce}"`), 'the importmap script carries the same nonce');
  assert.equal(res.text.includes('__CSP_NONCE__'), false);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.ok(!/script-src[^;]*unsafe-eval/.test(csp));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('a fresh nonce is generated per response', async () => {
  const { request } = await boot();
  const a = (await request('GET', '/')).headers['content-security-policy'];
  const b = (await request('GET', '/')).headers['content-security-policy'];
  assert.notEqual(a, b);
});

test('rejects a foreign Host header everywhere (DNS rebinding)', async () => {
  const { request, auth, port } = await boot();
  for (const url of ['/', '/api/state', '/healthz', '/vendor/htm/htm.module.js']) {
    const res = await request('GET', url, { headers: auth, host: 'evil.example:' + port });
    assert.equal(res.status, 403, url);
  }
  assert.equal((await request('GET', '/', { host: `localhost:${port}` })).status, 200);
});

test('healthz identifies the server without leaking the token', async () => {
  const { request } = await boot();
  const res = await request('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.json.app, 'kosmos-review');
  assert.match(res.json.id, /^[0-9a-f]{16}$/);
  assert.equal(res.json.pid, process.pid);
  assert.equal(res.text.includes(TOKEN), false);
});

test('API reads require the token', async () => {
  const { request } = await boot();
  assert.equal((await request('GET', '/api/state')).status, 401);
  assert.equal((await request('GET', '/api/state', { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await request('GET', '/assets/a.png')).status, 401);
});

test('GET /api/state returns doc, hash, meta and open status', async () => {
  const { request, auth, p } = await boot();
  const res = await request('GET', '/api/state', { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.json.slug, 'demo');
  assert.equal(res.json.reviewPath, 'docs/reviews/demo');
  assert.match(res.json.doc.hash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(res.json.doc.text.startsWith('# Title'));
  assert.equal(res.json.status, 'open');
  assert.equal(res.json.round, 1);
  assert.equal(res.json.draft, null);
  assert.equal(res.json.git.isRepo, false);
  assert.equal(res.json.needsKeepPrompt, false);
  assert.ok((await fs.readdir(p.reviewDir)).includes('meta.json'));
});

test('draft autosave and restore through the API', async () => {
  const { request, auth, write } = await boot();
  const st = (await request('GET', '/api/state', { headers: auth })).json;
  const body = validReview({ docHash: st.doc.hash, overall: 'wip', comments: [comment({ docHash: st.doc.hash })], answers: [answer()] });
  const put = await request('PUT', '/api/draft', { headers: write, body });
  assert.equal(put.status, 200);
  const again = (await request('GET', '/api/state', { headers: auth })).json;
  assert.equal(again.draft.overall, 'wip');
  assert.equal(again.draft.comments.length, 1);
  assert.equal(again.status, 'open');
});

test('write requests are refused without the token, cross-origin, with a wrong type, oversize, or malformed', async () => {
  const { request, write, port } = await boot();
  const body = validReview();
  assert.equal((await request('PUT', '/api/draft', { headers: { 'content-type': 'application/json' }, body })).status, 401);
  assert.equal((await request('PUT', '/api/draft', { headers: { ...write, origin: 'http://evil.example' }, body })).status, 403);
  assert.equal((await request('PUT', '/api/draft', { headers: { ...write, origin: `http://127.0.0.1:${port}` }, body })).status, 200);
  assert.equal((await request('PUT', '/api/draft', { headers: { ...write, 'sec-fetch-site': 'cross-site' }, body })).status, 403);
  assert.equal((await request('PUT', '/api/draft', { headers: { ...write, 'content-type': 'text/plain' }, body })).status, 415);
  assert.equal((await request('PUT', '/api/draft', { headers: write, body: '{nope' })).status, 400);
  assert.equal((await request('PUT', '/api/draft', { headers: write, body: validReview({ docHash: 'bad' }) })).status, 400);
  const huge = JSON.stringify(validReview({ overall: 'x'.repeat(600 * 1024) }));
  assert.equal((await request('PUT', '/api/draft', { headers: write, body: huge })).status, 413);
});

test('submit writes round files, clears the draft and flips status to submitted', async () => {
  const { request, auth, write, p } = await boot();
  const st = (await request('GET', '/api/state', { headers: auth })).json;
  await request('PUT', '/api/draft', { headers: write, body: validReview({ docHash: st.doc.hash, overall: 'wip' }) });
  const body = validReview({ docHash: st.doc.hash, overall: 'final', comments: [comment({ docHash: st.doc.hash })] });
  const r1 = await request('POST', '/api/submit', { headers: write, body });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.round, 1);
  assert.equal(r1.json.file, 'docs/reviews/demo/round-1.json');
  const saved = JSON.parse(await fs.readFile(path.join(p.reviewDir, 'round-1.json'), 'utf8'));
  assert.equal(saved.overall, 'final');
  const after = (await request('GET', '/api/state', { headers: auth })).json;
  assert.equal(after.draft, null);
  assert.equal(after.status, 'submitted');
  assert.equal(after.round, 2);
  assert.equal(after.rounds.length, 1);
  const r2 = await request('POST', '/api/submit', { headers: write, body });
  assert.equal(r2.json.round, 2);
  assert.equal(await fs.readFile(path.join(p.reviewDir, 'round-1.json'), 'utf8'), JSON.stringify(saved, null, 2) + '\n');
});

test('submit is refused with 409 when the document changed since the client loaded it', async () => {
  const { request, auth, write, p } = await boot();
  const st = (await request('GET', '/api/state', { headers: auth })).json;
  await fs.writeFile(path.join(p.reviewDir, 'doc.md'), '# Changed\n');
  const res = await request('POST', '/api/submit', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  assert.equal(res.status, 409);
  const names = await fs.readdir(p.reviewDir);
  assert.equal(names.some((n) => n.startsWith('round-')), false);
  const fresh = (await request('GET', '/api/state', { headers: auth })).json;
  assert.notEqual(fresh.doc.hash, st.doc.hash);
});

test('after the agent edits the doc the next state is open for round 2', async () => {
  const { request, auth, write, p } = await boot();
  const st = (await request('GET', '/api/state', { headers: auth })).json;
  await request('POST', '/api/submit', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  await fs.writeFile(path.join(p.reviewDir, 'doc.md'), '# Round two\n');
  const next = (await request('GET', '/api/state', { headers: auth })).json;
  assert.equal(next.status, 'open');
  assert.equal(next.round, 2);
});

test('keep prompt: asked once in a git repo; "no" appends the exclude and is remembered', async () => {
  const { request, auth, write, p } = await boot({ git: true });
  const st = (await request('GET', '/api/state', { headers: auth })).json;
  assert.equal(st.git.isRepo, true);
  assert.equal(st.needsKeepPrompt, true);
  const res = await request('POST', '/api/keep', { headers: write, body: { keep: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.exclude, 'added');
  assert.ok((await fs.readFile(path.join(p.root, '.git', 'info', 'exclude'), 'utf8')).includes('/docs/reviews/demo/'));
  assert.equal((await request('GET', '/api/state', { headers: auth })).json.needsKeepPrompt, false);
  assert.equal((await request('POST', '/api/keep', { headers: write, body: { keep: true } })).status, 409);
});

test('keep prompt: "yes" leaves .git/info/exclude untouched', async () => {
  const { request, write, p } = await boot({ git: true });
  const before = await fs.readFile(path.join(p.root, '.git', 'info', 'exclude')).catch(() => null);
  const res = await request('POST', '/api/keep', { headers: write, body: { keep: true } });
  assert.equal(res.status, 200);
  const after = await fs.readFile(path.join(p.root, '.git', 'info', 'exclude')).catch(() => null);
  assert.deepEqual(after, before);
});

test('keep: rejects a non-boolean and skips quietly outside a git repo', async () => {
  const { request, write, auth } = await boot();
  assert.equal((await request('POST', '/api/keep', { headers: write, body: { keep: 'no' } })).status, 400);
  const res = await request('POST', '/api/keep', { headers: write, body: { keep: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.exclude, 'not-a-git-repo');
  assert.equal((await request('GET', '/api/state', { headers: auth })).json.needsKeepPrompt, false);
});

test('assets: served read-only with a sandboxing CSP and the right type', async () => {
  const { request, auth, p } = await boot();
  await fs.writeFile(path.join(p.reviewDir, 'assets', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(p.reviewDir, 'assets', 'v.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = await request('GET', '/assets/a.png', { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.raw.length, 4);
  const svg = await request('GET', '/assets/v.svg', { headers: auth });
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.match(svg.headers['content-security-policy'], /sandbox/);
  assert.equal(svg.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request('POST', '/assets/a.png', { headers: auth })).status, 405);
});

test('assets: traversal, symlink escapes, unsupported types and missing files are refused', async () => {
  const { request, auth, p } = await boot();
  const outside = await tmpDir();
  cleanups.push(outside.cleanup);
  await fs.writeFile(path.join(outside.dir, 'secret.png'), 'secret');
  await fs.symlink(path.join(outside.dir, 'secret.png'), path.join(p.reviewDir, 'assets', 'leak.png'));
  await fs.symlink(outside.dir, path.join(p.reviewDir, 'assets', 'dir'));
  await fs.writeFile(path.join(p.reviewDir, 'assets', 'notes.txt'), 'x');
  const get = (u) => request('GET', u, { headers: auth });
  assert.equal((await get('/assets/leak.png')).status, 403);
  assert.equal((await get('/assets/dir/secret.png')).status, 403);
  assert.equal((await get('/assets/..%2fdoc.md')).status, 400);
  assert.equal((await get('/assets/%2e%2e/doc.md')).status, 400);
  assert.equal((await get('/assets/..%5cdoc.md')).status, 400);
  assert.equal((await get('/assets/%2fetc%2fpasswd')).status, 400);
  assert.equal((await get('/assets/%00.png')).status, 400);
  assert.equal((await get('/assets/%E0%A4%A.png')).status, 400);
  assert.equal((await get('/assets/notes.txt')).status, 415);
  assert.equal((await get('/assets/missing.png')).status, 404);
  assert.equal((await get('/assets/')).status, 400);
});

test('static: serves web and vendor files only, never the server source or the project', async () => {
  const { request, auth } = await boot();
  assert.equal((await request('GET', '/vendor/htm/htm.module.js')).status, 200);
  assert.equal((await request('GET', '/vendor/htm/LICENSE')).status, 404);
  assert.equal((await request('GET', '/src/server.js')).status, 404);
  assert.equal((await request('GET', '/vendor/%2e%2e/src/server.js')).status, 400);
  assert.equal((await request('GET', '/%2e%2e/package.json')).status, 400);
  assert.equal((await request('GET', '/doc.md', { headers: auth })).status, 404);
  assert.equal((await request('GET', '/package.json')).status, 404);
});

test('unsupported methods and routes', async () => {
  const { request, auth, write } = await boot();
  assert.equal((await request('DELETE', '/api/state', { headers: auth })).status, 405);
  assert.equal((await request('POST', '/api/state', { headers: write, body: {} })).status, 405);
  assert.equal((await request('OPTIONS', '/api/draft', { headers: auth })).status, 405);
  assert.equal((await request('GET', '/api/nope', { headers: auth })).status, 404);
});

test('a request can only ever create the expected files inside the review folder', async () => {
  const { request, auth, write, p } = await boot();
  const st = (await request('GET', '/api/state', { headers: auth })).json;
  await request('PUT', '/api/draft', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  await request('POST', '/api/submit', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  await request('GET', '/assets/..%2f..%2f..%2fx.png', { headers: auth });
  assert.deepEqual((await fs.readdir(p.root)).sort(), ['docs']);
  assert.deepEqual((await fs.readdir(p.reviewDir)).sort(), ['assets', 'doc.md', 'meta.json', 'round-1.json']);
});

test('idle timer fires after a quiet period and is postponed by authenticated activity', async () => {
  let idle = 0;
  const { request, auth } = await boot({ idleMs: 150, onIdle: () => { idle += 1; } });
  await new Promise((r) => setTimeout(r, 90));
  await request('GET', '/api/ping', { headers: auth });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(idle, 0, 'activity postponed the shutdown');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(idle, 1);
});

// ---- fix round 1 ----

test('the review folder swapped for a symlink while the server runs: writes get 409 and nothing lands outside', async () => {
  const { request, auth, write, p } = await boot();
  const outside = await tmpDir();
  cleanups.push(outside.cleanup);
  const st = (await request('GET', '/api/state', { headers: auth })).json;
  await fs.rename(p.reviewDir, p.reviewDir + '.real');
  await fs.symlink(outside.dir, p.reviewDir);
  const put = await request('PUT', '/api/draft', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  assert.equal(put.status, 409);
  const sub = await request('POST', '/api/submit', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  assert.ok([404, 409].includes(sub.status), 'submit status ' + sub.status);
  assert.deepEqual(await fs.readdir(outside.dir), []);
});

test('four parallel "do not keep" answers: one wins, the rest get 409, the exclude is appended once', async () => {
  const { request, write, p } = await boot({ git: true });
  const results = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/api/keep', { headers: write, body: { keep: false } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
  const lines = (await fs.readFile(path.join(p.root, '.git', 'info', 'exclude'), 'utf8')).split('\n');
  assert.equal(lines.filter((l) => l === '/docs/reviews/demo/').length, 1);
  assert.equal(lines.filter((l) => l.startsWith('# kosmos-review')).length, 1);
});

test('a failed exclude append leaves the keep decision open so the page can ask again', async () => {
  const { request, auth, write, p } = await boot({ git: true });
  await fs.rm(path.join(p.root, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(p.root, '.git', 'info'), 'not a directory');
  const res = await request('POST', '/api/keep', { headers: write, body: { keep: false } });
  assert.ok(res.status >= 400);
  assert.equal((await request('GET', '/api/state', { headers: auth })).json.needsKeepPrompt, true);
});

test('an asset path swapped for a symlink after resolution is not followed', async () => {
  const { p } = await boot();
  const { openRegularFile } = await import('../src/paths.js');
  const outside = await tmpDir();
  cleanups.push(outside.cleanup);
  await fs.writeFile(path.join(outside.dir, 's.png'), 'secret');
  const target = path.join(p.reviewDir, 'assets', 'swap.png');
  await fs.symlink(path.join(outside.dir, 's.png'), target);
  await assert.rejects(openRegularFile(target));
});

// ---- fix round 2 ----

test('requests that are rejected, unauthenticated, static or /healthz do not extend the idle timer', async () => {
  let idle = 0;
  const { request, port } = await boot({ idleMs: 300, onIdle: () => { idle += 1; } });
  const noise = [
    () => request('GET', '/healthz', { host: 'evil.example:' + port }),
    () => request('GET', '/api/state', { host: 'evil.example:' + port, headers: { authorization: 'Bearer ' + TOKEN } }),
    () => request('GET', '/api/state'),
    () => request('GET', '/api/state', { headers: { authorization: 'Bearer wrong' } }),
    () => request('GET', '/assets/a.png'),
    () => request('GET', '/healthz'),
    () => request('GET', '/'),
    () => request('GET', '/app.js'),
  ];
  const until = Date.now() + 700;
  for (let i = 0; Date.now() < until; i++) {
    await noise[i % noise.length]();
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(idle, 1, 'the idle timer fired on schedule despite constant traffic of that kind');
});

test('an authenticated ping keeps the server alive', async () => {
  let idle = 0;
  const { request, auth } = await boot({ idleMs: 300, onIdle: () => { idle += 1; } });
  const until = Date.now() + 700;
  while (Date.now() < until) {
    assert.equal((await request('GET', '/api/ping', { headers: auth })).status, 200);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(idle, 0);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(idle, 1, 'and it stops once the pings stop');
});

test('/api/ping needs the token and accepts only GET', async () => {
  const { request, auth, write } = await boot();
  assert.equal((await request('GET', '/api/ping')).status, 401);
  assert.equal((await request('GET', '/api/ping', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.deepEqual((await request('GET', '/api/ping', { headers: auth })).json, { ok: true });
  assert.equal((await request('POST', '/api/ping', { headers: write, body: {} })).status, 405);
});

// ---- fix round 3 ----

const state = (request, auth) => request('GET', '/api/state', { headers: auth });

test('GET /api/state stays 200 when git metadata is hostile: HEAD as a directory, .git as an oversized file, a FIFO or an unreadable file', async () => {
  const { request, auth, p } = await boot({ git: true });
  const dotGit = path.join(p.root, '.git');
  await fs.rm(path.join(dotGit, 'HEAD'));
  await fs.mkdir(path.join(dotGit, 'HEAD'));
  let res = await state(request, auth);
  assert.equal(res.status, 200);
  assert.equal(res.json.git.isRepo, false);
  await fs.rm(dotGit, { recursive: true });
  await fs.writeFile(dotGit, 'gitdir: x\n');
  await fs.truncate(dotGit, 10 * 1024 * 1024);
  res = await state(request, auth);
  assert.equal(res.status, 200);
  assert.equal(res.json.git.isRepo, false);
  await fs.rm(dotGit);
  if (spawnSync('mkfifo', [dotGit]).status === 0) {
    res = await state(request, auth);
    assert.equal(res.status, 200);
    await fs.rm(dotGit);
  }
  await fs.writeFile(dotGit, 'gitdir: x\n', { mode: 0o000 });
  assert.equal((await state(request, auth)).status, 200);
});

test('"Do not keep" with a hostile exclude file is a clear 409, not a 500, and the question stays open', async () => {
  const { request, auth, write, p } = await boot({ git: true });
  const file = path.join(p.root, '.git', 'info', 'exclude');
  await fs.writeFile(file, 'x');
  await fs.truncate(file, 10 * 1024 * 1024);
  const res = await request('POST', '/api/keep', { headers: write, body: { keep: false } });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /exclude/);
  assert.equal((await state(request, auth)).json.needsKeepPrompt, true);
});

test('keep prompt in a worktree or submodule (.git is a file): asked, and "no" is recorded with the manual instruction and no write', async () => {
  const { request, auth, write, p } = await boot();
  await fs.writeFile(path.join(p.root, '.git'), 'gitdir: /somewhere/else/.git/worktrees/w\n');
  const st = (await state(request, auth)).json;
  assert.equal(st.git.isRepo, true);
  assert.equal(st.needsKeepPrompt, true);
  const res = await request('POST', '/api/keep', { headers: write, body: { keep: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.exclude, 'manual');
  assert.equal(res.json.manual.line, '/docs/reviews/demo/');
  assert.equal(res.json.manual.command, 'git rev-parse --git-path info/exclude');
  const after = (await state(request, auth)).json;
  assert.equal(after.meta.keep, false);
  assert.equal(after.needsKeepPrompt, false);
  assert.deepEqual((await fs.readdir(p.root)).sort(), ['.git', 'docs']);
});

// ---- listeners (auto-send) ----

const listener = (request, write, id, action = 'beat') => request('POST', '/api/listener', { headers: write, body: { id, action } });

test('a waiting agent registers as a listener through the authenticated endpoint; the state and the submit response say so', async () => {
  const { request, auth, write } = await boot();
  assert.deepEqual((await state(request, auth)).json.listener, { active: false, count: 0 });
  const res = await listener(request, write, 'waiter-0001');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, active: true, count: 1 });
  assert.deepEqual((await state(request, auth)).json.listener, { active: true, count: 1 });
  await listener(request, write, 'waiter-0002');
  assert.equal((await state(request, auth)).json.listener.count, 2);
  await listener(request, write, 'waiter-0001', 'stop');
  assert.deepEqual((await state(request, auth)).json.listener, { active: true, count: 1 });
  await listener(request, write, 'waiter-0002', 'stop');
  assert.deepEqual((await state(request, auth)).json.listener, { active: false, count: 0 });
});

test('a listener that stops sending heartbeats expires by itself (a dead waiter does not linger)', async () => {
  const { request, auth, write } = await boot({ listenerLeaseMs: 200 });
  await listener(request, write, 'waiter-0001');
  await new Promise((r) => setTimeout(r, 120));
  await listener(request, write, 'waiter-0001'); // heartbeat renews the lease
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await state(request, auth)).json.listener.active, true, 'renewed, so still active');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await state(request, auth)).json.listener, { active: false, count: 0 });
});

test('the submit response reports whether a listener was active at that moment, before the waiter can unregister', async () => {
  const { request, auth, write } = await boot();
  const st = (await state(request, auth)).json;
  const none = await request('POST', '/api/submit', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  assert.deepEqual(none.json.listener, { active: false, count: 0 });
  await listener(request, write, 'waiter-0001');
  const some = await request('POST', '/api/submit', { headers: write, body: validReview({ docHash: st.doc.hash }) });
  assert.deepEqual(some.json.listener, { active: true, count: 1 });
});

test('the listener endpoint needs the token, JSON, and a sane body; the number of listeners is capped', async () => {
  const { request, auth, write } = await boot();
  assert.equal((await request('POST', '/api/listener', { headers: { 'content-type': 'application/json' }, body: { id: 'waiter-0001', action: 'beat' } })).status, 401);
  assert.equal((await request('POST', '/api/listener', { headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request('POST', '/api/listener', { headers: { ...write, origin: 'http://evil.example' }, body: { id: 'waiter-0001', action: 'beat' } })).status, 403);
  for (const body of [{ id: 'x', action: 'beat' }, { id: '../../etc', action: 'beat' }, { id: 'waiter-0001', action: 'kill' }, { id: 5, action: 'beat' }, {}, []]) {
    assert.equal((await request('POST', '/api/listener', { headers: write, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await request('GET', '/api/listener', { headers: auth })).status, 405);
  for (let i = 0; i < 16; i += 1) assert.equal((await listener(request, write, `waiter-${String(i).padStart(4, '0')}`)).status, 200);
  assert.equal((await listener(request, write, 'waiter-9999')).status, 409, 'cap reached');
  assert.equal((await listener(request, write, 'waiter-0000')).status, 200, 'an existing one may still renew');
});

test('rejected or unauthenticated listener requests are not activity for the idle timer', async () => {
  let idle = 0;
  const { request, port } = await boot({ idleMs: 250, onIdle: () => { idle += 1; } });
  const until = Date.now() + 600;
  while (Date.now() < until) {
    await request('POST', '/api/listener', { headers: { 'content-type': 'application/json' }, body: { id: 'waiter-0001', action: 'beat' } });
    await request('POST', '/api/listener', { host: 'evil.example:' + port, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: { id: 'waiter-0001', action: 'beat' } });
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(idle, 1);
});

// ---- fix round 1 (auto-send hardening) ----

test('listener beats are not activity: a waiter must not keep the server (and its token) alive by itself', async () => {
  let idle = 0;
  const { request, write } = await boot({ idleMs: 300, onIdle: () => { idle += 1; } });
  const until = Date.now() + 700;
  while (Date.now() < until) {
    assert.equal((await listener(request, write, 'waiter-0001')).status, 200);
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.equal(idle, 1, 'the idle timer fired on schedule despite the heartbeats');
});

test('a listener bound to a dead pid is not reported, so a killed waiter does not claim delivery', async () => {
  const { request, auth, write } = await boot({ listenerLeaseMs: 60_000 });
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const post = (pid) => request('POST', '/api/listener', { headers: write, body: { id: 'waiter-0001', action: 'beat', pid } });
  assert.equal((await post(dead)).status, 200);
  assert.deepEqual((await state(request, auth)).json.listener, { active: false, count: 0 }, 'pid is gone');
  assert.equal((await post(process.pid)).status, 200);
  assert.deepEqual((await state(request, auth)).json.listener, { active: true, count: 1 }, 'pid alive');
  for (const bad of ['5', -1, 0, 1.5, 2 ** 40]) assert.equal((await post(bad)).status, 400, String(bad));
});

const mint = (request, write) => request('POST', '/api/ticket', { headers: write, body: {} });
const redeem = (request, ticket, extra = {}) => request('POST', '/api/session', { headers: { 'content-type': 'application/json', ...extra }, body: { ticket } });

test('a single-use bootstrap ticket is exchanged once for the real token', async () => {
  const { request, write } = await boot();
  const t = await mint(request, write);
  assert.equal(t.status, 200);
  assert.match(t.json.ticket, /^[A-Za-z0-9_-]{32,64}$/);
  assert.notEqual(t.json.ticket, TOKEN);
  const first = await redeem(request, t.json.ticket);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { token: TOKEN });
  assert.equal((await redeem(request, t.json.ticket)).status, 401, 'the ticket is deleted on use');
});

test('a ticket expires, and it is not a token', async () => {
  const { request, write } = await boot({ ticketTtlMs: 150 });
  const t = (await mint(request, write)).json.ticket;
  assert.equal((await request('GET', '/api/state', { headers: { authorization: 'Bearer ' + t } })).status, 401, 'not usable as a bearer token');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await redeem(request, t)).status, 401, 'expired');
});

test('the ticket endpoints have the usual guards: minting needs the token; redeeming needs Host, Origin, JSON and a sane body', async () => {
  const { request, write, port } = await boot();
  assert.equal((await request('POST', '/api/ticket', { headers: { 'content-type': 'application/json' }, body: {} })).status, 401);
  const t = (await mint(request, write)).json.ticket;
  assert.equal((await request('POST', '/api/session', { headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: { ticket: t } })).status, 403);
  assert.equal((await request('POST', '/api/session', { host: 'evil.example:' + port, headers: { 'content-type': 'application/json' }, body: { ticket: t } })).status, 403);
  assert.equal((await request('POST', '/api/session', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ ticket: t }) })).status, 415);
  assert.equal((await redeem(request, 5)).status, 400);
  assert.equal((await redeem(request, 'short')).status, 400);
  assert.equal((await request('GET', '/api/session')).status, 405);
  assert.equal((await redeem(request, t)).status, 200, 'the rejected attempts did not burn the ticket');
});

test('failed ticket attempts are not activity, and the number of outstanding tickets is capped', async () => {
  let idle = 0;
  const { request, write } = await boot({ idleMs: 300, onIdle: () => { idle += 1; } });
  const until = Date.now() + 600;
  while (Date.now() < until) { await redeem(request, 'x'.repeat(40)); await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(idle, 1);
  for (let i = 0; i < 8; i += 1) assert.equal((await mint(request, write)).status, 200);
  assert.equal((await mint(request, write)).status, 409);
});

test('submit adds a MAC when the server has a round key, and none when it has not', async () => {
  const key = Buffer.alloc(32, 7);
  const a = await boot({ roundKey: key });
  const st = (await state(a.request, a.auth)).json;
  await a.request('POST', '/api/submit', { headers: a.write, body: validReview({ docHash: st.doc.hash }) });
  const withKey = JSON.parse(await fs.readFile(path.join(a.p.reviewDir, 'round-1.json'), 'utf8'));
  assert.match(withKey.mac, /^hmac-sha256:[0-9a-f]{64}$/);
  const b = await boot();
  await b.request('POST', '/api/submit', { headers: b.write, body: validReview({ docHash: (await state(b.request, b.auth)).json.doc.hash }) });
  assert.equal('mac' in JSON.parse(await fs.readFile(path.join(b.p.reviewDir, 'round-1.json'), 'utf8')), false);
});

// ---- fix round 2: the launcher file that carries the ticket ----

test('the server deletes the launcher file the moment its ticket is redeemed', async () => {
  const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'kr-launch-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const launcherPath = path.join(dir, '0123456789abcdef.open.html');
  const { request, write } = await boot({ launcherPath, launcherTtlMs: 60_000 });
  const t = (await mint(request, write)).json.ticket;
  await fs.writeFile(launcherPath, 'x');
  assert.equal((await redeem(request, 'z'.repeat(40))).status, 401, 'a failed attempt leaves it alone');
  assert.ok(await fs.stat(launcherPath));
  assert.equal((await redeem(request, t)).status, 200);
  await assert.rejects(fs.stat(launcherPath));
});

test('the launcher file also disappears by itself after its short lifetime, and a stale one is removed at start and on close', async () => {
  const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'kr-launch-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const launcherPath = path.join(dir, '0123456789abcdef.open.html');
  await fs.writeFile(launcherPath, 'stale');
  const { request, write, instance } = await boot({ launcherPath, launcherTtlMs: 200 });
  await assert.rejects(fs.stat(launcherPath), 'a stale launcher from an earlier run is removed at start');
  await mint(request, write);
  await fs.writeFile(launcherPath, 'fresh');
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(fs.stat(launcherPath), 'removed after its lifetime even if never used');
  await fs.writeFile(launcherPath, 'again');
  await instance.close();
  await assert.rejects(fs.stat(launcherPath), 'and on close');
});
