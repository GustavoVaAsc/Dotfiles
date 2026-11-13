import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { waitForRound } from '../src/wait.js';
import { tmpProject, tmpDir } from './helpers.js';

const ROUND = JSON.stringify({ schema: 1, submittedAt: '2026-01-01T00:00:00Z', comments: [], answers: [] });
const later = (ms, fn) => new Promise((resolve) => setTimeout(() => resolve(fn()), ms));

test('returns the first round newer than the ones that existed when the wait started', async () => {
  const p = await tmpProject();
  try {
    await fs.writeFile(path.join(p.reviewDir, 'round-1.json'), ROUND);
    await fs.writeFile(path.join(p.reviewDir, 'round-2.json'), ROUND);
    const pending = waitForRound({ reviewDir: p.reviewDir, timeoutMs: 5000, pollMs: 10_000 });
    later(150, () => fs.writeFile(path.join(p.reviewDir, 'round-3.json'), ROUND));
    const r = await pending;
    assert.deepEqual([r.status, r.round, r.file], ['round', 3, path.join(p.reviewDir, 'round-3.json')]);
  } finally { await p.cleanup(); }
});

test('is event driven: with a 10 s poll interval a new round is still noticed within a second', async () => {
  const p = await tmpProject();
  try {
    const t0 = Date.now();
    const pending = waitForRound({ reviewDir: p.reviewDir, timeoutMs: 8000, pollMs: 10_000 });
    later(100, () => fs.writeFile(path.join(p.reviewDir, 'round-1.json'), ROUND));
    assert.equal((await pending).status, 'round');
    assert.ok(Date.now() - t0 < 1500);
  } finally { await p.cleanup(); }
});

test('falls back to polling when fs.watch is unavailable or errors', async () => {
  const p = await tmpProject();
  try {
    const broken = waitForRound({ reviewDir: p.reviewDir, timeoutMs: 5000, pollMs: 40, watch: () => { throw new Error('ENOSPC: inotify limit'); } });
    later(120, () => fs.writeFile(path.join(p.reviewDir, 'round-1.json'), ROUND));
    assert.equal((await broken).status, 'round');
    const { EventEmitter } = await import('node:events');
    const erroring = waitForRound({ reviewDir: p.reviewDir, timeoutMs: 5000, pollMs: 40, watch: () => { const w = new EventEmitter(); w.close = () => {}; setTimeout(() => w.emit('error', new Error('gone')), 10); return w; } });
    later(150, () => fs.writeFile(path.join(p.reviewDir, 'round-2.json'), ROUND));
    assert.equal((await erroring).round, 2);
  } finally { await p.cleanup(); }
});

test('only regular files count: a directory or a symlink named round-N.json does not end the wait', async () => {
  const p = await tmpProject();
  const outside = await tmpDir();
  try {
    await fs.writeFile(path.join(outside.dir, 'x.json'), ROUND);
    const pending = waitForRound({ reviewDir: p.reviewDir, timeoutMs: 700, pollMs: 50 });
    later(100, async () => {
      await fs.mkdir(path.join(p.reviewDir, 'round-1.json'));
      await fs.symlink(path.join(outside.dir, 'x.json'), path.join(p.reviewDir, 'round-2.json'));
    });
    assert.equal((await pending).status, 'timeout');
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('times out with a distinct status', async () => {
  const p = await tmpProject();
  try {
    const t0 = Date.now();
    const r = await waitForRound({ reviewDir: p.reviewDir, timeoutMs: 300, pollMs: 50 });
    assert.equal(r.status, 'timeout');
    assert.ok(Date.now() - t0 >= 280);
  } finally { await p.cleanup(); }
});

test('does not spin: with nothing happening it checks about once per poll interval', async () => {
  const p = await tmpProject();
  try {
    let checks = 0;
    const r = await waitForRound({ reviewDir: p.reviewDir, timeoutMs: 1700, pollMs: 500, onCheck: () => { checks += 1; } });
    assert.equal(r.status, 'timeout');
    assert.ok(checks >= 3 && checks <= 7, `checks: ${checks}`);
  } finally { await p.cleanup(); }
});

test('several new rounds at once: the lowest is delivered first, so rounds are handled one at a time', async () => {
  const p = await tmpProject();
  try {
    // no watch events, a 300 ms poll: both files are in place before the next check
    const pending = waitForRound({ reviewDir: p.reviewDir, timeoutMs: 3000, pollMs: 300, watch: () => { throw new Error('off'); } });
    later(50, async () => { await fs.writeFile(path.join(p.reviewDir, 'round-1.json'), ROUND); await fs.writeFile(path.join(p.reviewDir, 'round-2.json'), ROUND); });
    const r = await pending;
    assert.deepEqual([r.status, r.round], ['round', 1]);
  } finally { await p.cleanup(); }
});

test('after: a round that already exists is delivered at once, the first one greater than N', async () => {
  const p = await tmpProject();
  try {
    for (const n of [1, 2, 3]) await fs.writeFile(path.join(p.reviewDir, `round-${n}.json`), ROUND);
    assert.equal((await waitForRound({ reviewDir: p.reviewDir, timeoutMs: 500, after: 0 })).round, 1);
    assert.equal((await waitForRound({ reviewDir: p.reviewDir, timeoutMs: 500, after: 1 })).round, 2);
    assert.equal((await waitForRound({ reviewDir: p.reviewDir, timeoutMs: 200, pollMs: 50, after: 3 })).status, 'timeout');
  } finally { await p.cleanup(); }
});

test('can be aborted', async () => {
  const p = await tmpProject();
  try {
    const ac = new AbortController();
    const pending = waitForRound({ reviewDir: p.reviewDir, timeoutMs: 10_000, pollMs: 10_000, signal: ac.signal });
    later(100, () => ac.abort());
    assert.equal((await pending).status, 'aborted');
  } finally { await p.cleanup(); }
});
