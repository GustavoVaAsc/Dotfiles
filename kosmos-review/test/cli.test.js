import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpProject, tmpDir, validReview } from './helpers.js';
import { idFor } from '../src/registry.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'kosmos-review');

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function setup(opts) {
  const p = await tmpProject(opts);
  const state = await tmpDir('kr-state-');
  const stateDir = path.join(state.dir, 's');
  const env = { ...process.env, KOSMOS_REVIEW_STATE_DIR: stateDir };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20000 });
  cleanups.push(async () => { run(['stop', p.root, p.slug]); await p.cleanup(); await state.cleanup(); });
  return { p, run, stateDir };
}
const urlOf = (out) => /^URL: (http:\/\/127\.0\.0\.1:(\d+)\/#token=([\w-]+))$/m.exec(out);
const pidOf = (out) => Number(/pid (\d+)/.exec(out)[1]);
// Polling /healthz would count as activity and keep the server alive, so wait for the process itself to go away.
const exited = async (pid, ms = 10000) => {
  for (let waited = 0; waited < ms; waited += 100) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const health = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status; } catch { return null; } };

test('serve detaches (the command returns), prints the URL, and a second call reuses the server', async () => {
  const { p, run } = await setup();
  const t0 = Date.now();
  const a = run(['serve', p.root, p.slug]);
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.ok(Date.now() - t0 < 10000);
  const m = urlOf(a.stdout);
  assert.ok(m, a.stdout);
  assert.equal(await health(m[2]), 200, 'the detached server keeps running after the command exits');
  const b = run(['serve', p.root, p.slug]);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(urlOf(b.stdout)[1], m[1], 'same URL (same port and token)');
  assert.match(b.stdout, /reused/i);
});

test('stop terminates the server and a later serve starts a fresh one', async () => {
  const { p, run } = await setup();
  const a = urlOf(run(['serve', p.root, p.slug]).stdout);
  const s = run(['stop', p.root, p.slug]);
  assert.equal(s.status, 0, s.stderr);
  for (let i = 0; i < 40 && (await health(a[2])) !== null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await health(a[2]), null);
  const b = urlOf(run(['serve', p.root, p.slug]).stdout);
  assert.ok(b);
  assert.notEqual(b[3], a[3], 'new token for a new server');
});

test('stale registry entries (dead pid) are ignored', async () => {
  const { p, run } = await setup();
  const a = run(['serve', p.root, p.slug]);
  const m = urlOf(a.stdout);
  process.kill(Number(/pid (\d+)/.exec(a.stdout)[1]), 'SIGKILL');
  for (let i = 0; i < 40 && (await health(m[2])) !== null; i++) await new Promise((r) => setTimeout(r, 50));
  const b = run(['serve', p.root, p.slug]);
  assert.equal(b.status, 0, b.stderr);
  assert.ok(urlOf(b.stdout));
  assert.doesNotMatch(b.stdout, /reused/i);
});

test('the server exits on its own after the idle timeout', async () => {
  const { p, run } = await setup();
  const a = run(['serve', p.root, p.slug, '--idle-minutes', '0.01']);
  const m = urlOf(a.stdout);
  assert.equal(await health(m[2]), 200);
  assert.equal(await exited(pidOf(a.stdout)), true, 'the process exited by itself');
  assert.equal(await health(m[2]), null);
});

test('serve validates its input with exit code 2', async () => {
  const { p, run } = await setup();
  assert.equal(run(['serve', p.root, '../x']).status, 2);
  assert.equal(run(['serve', path.join(p.root, 'nope'), p.slug]).status, 2);
  assert.equal(run(['serve', p.root]).status, 2);
  assert.equal(run(['serve', p.root, p.slug, '--idle-minutes', 'abc']).status, 2);
  assert.equal(run(['serve', p.root, p.slug, '--bogus']).status, 2);
  assert.equal(run(['frobnicate']).status, 2);
  await fs.rm(path.join(p.reviewDir, 'doc.md'));
  const r = run(['serve', p.root, p.slug]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /doc\.md/);
});

test('latest reports the newest submitted round, or exits 1 when there is none', async () => {
  const { p, run } = await setup();
  assert.equal(run(['latest', p.root, p.slug]).status, 1);
  const m = urlOf(run(['serve', p.root, p.slug]).stdout);
  const base = `http://127.0.0.1:${m[2]}`;
  const headers = { authorization: 'Bearer ' + m[3], 'content-type': 'application/json' };
  const st = await (await fetch(base + '/api/state', { headers })).json();
  for (let i = 0; i < 2; i++) {
    const res = await fetch(base + '/api/submit', { method: 'POST', headers, body: JSON.stringify(validReview({ docHash: st.doc.hash })) });
    assert.equal(res.status, 200);
  }
  const r = run(['latest', p.root, p.slug]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(p.root, 'docs/reviews/demo/round-2.json'), 'an absolute path, so it works from any cwd');
});

test('check validates question fences and reports line numbers', async () => {
  const good = await setup({ doc: '# T\n\n```kosmos-question\nid: q1\ntype: text\nprompt: Why?\n```\n' });
  const ok = good.run(['check', good.p.root, good.p.slug]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /1 question/);
  const bad = await setup({ doc: '# T\n\n```kosmos-question\nid: q1\ntype: radio\nprompt: Why?\n```\n' });
  const r = bad.run(['check', bad.p.root, bad.p.slug]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /doc\.md:5/);
});

// ---- fix round 1 ----

test('serve --foreground refuses when a live server already exists for the folder', async () => {
  const { p, run } = await setup();
  assert.equal(run(['serve', p.root, p.slug]).status, 0);
  const r = run(['serve', p.root, p.slug, '--foreground']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already running/);
});

test('a tiny --idle-minutes is clamped to one second instead of firing immediately', async () => {
  const { p, run } = await setup();
  const a = run(['serve', p.root, p.slug, '--idle-minutes', '0.0000001']);
  assert.equal(a.status, 0, a.stderr);
  const m = urlOf(a.stdout);
  assert.equal(await health(m[2]), 200, 'still up right after start');
  assert.equal(await exited(pidOf(a.stdout)), true, 'gone after about a second without requests');
});

test('latest ignores a round-N.json that is not a regular file', async () => {
  const { p, run } = await setup();
  const body = JSON.stringify({ schema: 1, submittedAt: '2026-01-01T00:00:00Z', comments: [], answers: [] });
  await fs.writeFile(path.join(p.reviewDir, 'round-1.json'), body);
  await fs.symlink(path.join(p.reviewDir, 'round-1.json'), path.join(p.reviewDir, 'round-4.json'));
  await fs.mkdir(path.join(p.reviewDir, 'round-6.json'));
  const r = run(['latest', p.root, p.slug]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(p.root, 'docs/reviews/demo/round-1.json'));
});

test('stop removes the server log on a clean stop', async () => {
  const { p, run, stateDir } = await setup();
  assert.equal(run(['serve', p.root, p.slug]).status, 0);
  const id = idFor(p.reviewDir);
  await fs.stat(path.join(stateDir, `${id}.log`));
  assert.equal(run(['stop', p.root, p.slug]).status, 0);
  await assert.rejects(fs.stat(path.join(stateDir, `${id}.log`)));
});

test('stop escalates to SIGKILL when the server ignores SIGTERM', async () => {
  const { p, run, stateDir } = await setup();
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const id = idFor(p.reviewDir);
  // A stand-in "server" that answers /healthz like ours and ignores SIGTERM.
  const script = `
    const http = require('node:http'); const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    const s = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ app: 'kosmos-review', id: ${JSON.stringify(id)}, pid: process.pid })); });
    s.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(${JSON.stringify(path.join(stateDir, `${id}.json`))}, JSON.stringify({ id: ${JSON.stringify(id)}, pid: process.pid, port: s.address().port, token: 'tok' }));
      console.log('ready');
    });`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const r = run(['stop', p.root, p.slug]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await new Promise((x) => setTimeout(x, 50));
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { child.kill('SIGKILL'); }
});

// ---- fix round 3 ----

test('serve that reuses a running server resets its idle timer through the authenticated ping', async () => {
  const { p, run } = await setup();
  const a = run(['serve', p.root, p.slug, '--idle-minutes', '0.05']); // 3 s
  assert.equal(a.status, 0, a.stderr);
  const pid = pidOf(a.stdout);
  await new Promise((r) => setTimeout(r, 2000));
  const b = run(['serve', p.root, p.slug]);
  assert.match(b.stdout, /reused/i);
  await new Promise((r) => setTimeout(r, 2000)); // 4 s after start: past the original deadline
  assert.doesNotThrow(() => process.kill(pid, 0), 'still alive, because the second serve counted as activity');
  assert.equal(await exited(pid), true, 'and it still idles out afterwards');
});
