// `serve` opens the browser only for a fresh server. The opener is injected, so no browser is ever started here.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { tmpProject, tmpDir } from './helpers.js';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function setup() {
  const p = await tmpProject();
  const state = await tmpDir('kr-state-');
  const saved = process.env.KOSMOS_REVIEW_STATE_DIR;
  process.env.KOSMOS_REVIEW_STATE_DIR = path.join(state.dir, 's');
  const opened = [];
  const deps = { opener: (url) => { opened.push(url); return { opened: true, reason: 'xdg-open' }; } };
  const run = async (args, d = deps) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { const code = await main(args, d); return { code, out: lines.join('\n') }; } finally { console.log = log; }
  };
  cleanups.push(async () => {
    await run(['stop', p.root, p.slug]);
    if (saved === undefined) delete process.env.KOSMOS_REVIEW_STATE_DIR; else process.env.KOSMOS_REVIEW_STATE_DIR = saved;
    await p.cleanup(); await state.cleanup();
  });
  return { p, run, opened };
}

test('a fresh server opens the URL once and says so', async () => {
  const { p, run, opened } = await setup();
  const r = await run(['serve', p.root, p.slug]);
  assert.equal(r.code, 0);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^file:\/\/\/.*\/[0-9a-f]{16}\.open\.html$/, 'the browser gets a launcher file, nothing with a ticket or token in its command line');
  const printed = /^URL: (http:\/\/127\.0\.0\.1:(\d+)\/#token=([\w-]+))$/m.exec(r.out);
  assert.ok(printed, 'the printed URL is the token URL');
  assert.ok(!opened[0].includes(printed[3]) && !/ticket=/.test(opened[0]), 'neither token nor ticket is in what the browser was started with');
  // the launcher (private file) redirects to a ticket that bootstraps the page exactly once, and is then deleted
  const file = fileURLToPath(opened[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const html = readFileSync(file, 'utf8');
  const ticket = /#ticket=([\w-]+)/.exec(html)[1];
  assert.ok(!html.includes(printed[3]), 'the launcher holds the ticket, not the token');
  const redeem = () => fetch(`http://127.0.0.1:${printed[2]}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const first = await redeem();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).token, printed[3]);
  assert.equal((await redeem()).status, 401);
  for (let i = 0; i < 40 && existsSync(file); i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.equal(existsSync(file), false, 'the server deletes the launcher as soon as the ticket is used');
  assert.match(r.out, /^URL: /m, 'the URL is always printed');
  assert.match(r.out, /Browser: launch requested \(xdg-open\)/, 'it cannot see whether a (possibly sandboxed) browser could read the page, so it does not claim success');
  assert.doesNotMatch(r.out, /Browser: opened/);
});

test('reusing a running server does not open another tab', async () => {
  const { p, run, opened } = await setup();
  await run(['serve', p.root, p.slug]);
  const again = await run(['serve', p.root, p.slug]);
  assert.equal(opened.length, 1, 'still only the first open');
  assert.match(again.out, /^URL: /m);
  assert.match(again.out, /Browser: not opened \(the server was already running/);
});

test('--no-open never opens, and still prints the URL', async () => {
  const { p, run, opened } = await setup();
  const r = await run(['serve', p.root, p.slug, '--no-open']);
  assert.equal(r.code, 0);
  assert.equal(opened.length, 0);
  assert.match(r.out, /^URL: /m);
  assert.match(r.out, /Browser: not opened \(--no-open\)/);
});

test('no display: the opener reports it and the output says why, without failing', async () => {
  const { p, run } = await setup();
  const r = await run(['serve', p.root, p.slug], { opener: () => ({ opened: false, reason: 'no-display' }) });
  assert.equal(r.code, 0);
  assert.match(r.out, /^URL: /m);
  assert.match(r.out, /Browser: not opened \(no display/);
});

test('an opener that throws does not fail serve', async () => {
  const { p, run } = await setup();
  const r = await run(['serve', p.root, p.slug], { opener: () => { throw new Error('boom'); } });
  assert.equal(r.code, 0);
  assert.match(r.out, /Browser: not opened/);
});

test('when no ticket can be minted the browser is not opened with anything else', async () => {
  const { p, run, opened } = await setup();
  const r = await run(['serve', p.root, p.slug], { opener: (u) => { opened.push(u); return { opened: true, reason: 'x' }; }, mintTicket: async () => null });
  assert.equal(r.code, 0);
  assert.equal(opened.length, 0);
  assert.match(r.out, /Browser: not opened \(could not prepare a one-time link/);
});

// ---- fix round 3 ----

test('the default opener is given the exact launcher URL even when the state directory path has @ = , ( ) in it', async () => {
  const p = await tmpProject();
  const outer = await tmpDir('kr-odd-');
  const odd = path.join(outer.dir, 'kosmos@host=1,(a)');
  const saved = process.env.KOSMOS_REVIEW_STATE_DIR;
  process.env.KOSMOS_REVIEW_STATE_DIR = odd;
  const spawned = [];
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const code = await main(['serve', p.root, p.slug], { platform: 'linux', env: { DISPLAY: ':0' }, exists: () => true, spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { on() {}, unref() {} }; } });
    assert.equal(code, 0);
    assert.equal(spawned.length, 1, lines.join('\n'));
    assert.equal(spawned[0].cmd, '/usr/bin/xdg-open');
    assert.match(spawned[0].args[0], /^file:\/\/\/.*kosmos@host=1,\(a\)\/[0-9a-f]{16}\.open\.html$/);
    assert.match(lines.join('\n'), /Browser: launch requested \(xdg-open\)/);
  } finally {
    console.log = log;
    await main(['stop', p.root, p.slug]);
    if (saved === undefined) delete process.env.KOSMOS_REVIEW_STATE_DIR; else process.env.KOSMOS_REVIEW_STATE_DIR = saved;
    await p.cleanup(); await outer.cleanup();
  }
});
