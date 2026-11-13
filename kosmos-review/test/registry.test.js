import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir, idFor, writeEntry, readEntry, removeEntry, findLive, acquireStartLock, keyDir } from '../src/registry.js';
import { tmpDir } from './helpers.js';

test('stateDir creates a private directory and honours KOSMOS_REVIEW_STATE_DIR', async () => {
  const t = await tmpDir();
  try {
    const want = path.join(t.dir, 'state');
    const got = await stateDir({ KOSMOS_REVIEW_STATE_DIR: want });
    assert.equal(got, want);
    const st = await fs.stat(want);
    assert.equal(st.mode & 0o077, 0, 'no group/other permissions');
  } finally { await t.cleanup(); }
});

test('stateDir refuses a symlink and tightens a too-open directory', async () => {
  const t = await tmpDir();
  try {
    const real = path.join(t.dir, 'real');
    await fs.mkdir(real, { mode: 0o755 });
    const link = path.join(t.dir, 'link');
    await fs.symlink(real, link);
    await assert.rejects(stateDir({ KOSMOS_REVIEW_STATE_DIR: link }));
    await fs.chmod(real, 0o777);
    await stateDir({ KOSMOS_REVIEW_STATE_DIR: real });
    assert.equal((await fs.stat(real)).mode & 0o077, 0);
  } finally { await t.cleanup(); }
});

test('idFor is stable, short and distinct per folder', () => {
  assert.equal(idFor('/a/b'), idFor('/a/b'));
  assert.notEqual(idFor('/a/b'), idFor('/a/c'));
  assert.match(idFor('/a/b'), /^[0-9a-f]{16}$/);
});

test('entries round-trip with private file mode and are removable', async () => {
  const t = await tmpDir();
  try {
    const dir = await stateDir({ KOSMOS_REVIEW_STATE_DIR: path.join(t.dir, 's') });
    const id = idFor('/x');
    assert.equal(await readEntry(dir, id), null);
    await writeEntry(dir, id, { pid: 1, port: 2, token: 'tok' });
    assert.deepEqual(await readEntry(dir, id), { pid: 1, port: 2, token: 'tok' });
    assert.equal((await fs.stat(path.join(dir, id + '.json'))).mode & 0o077, 0);
    await removeEntry(dir, id);
    assert.equal(await readEntry(dir, id), null);
    await removeEntry(dir, id);
  } finally { await t.cleanup(); }
});

test('a corrupt entry reads as missing', async () => {
  const t = await tmpDir();
  try {
    const dir = await stateDir({ KOSMOS_REVIEW_STATE_DIR: path.join(t.dir, 's') });
    await fs.writeFile(path.join(dir, 'abcd.json'), '{bad');
    assert.equal(await readEntry(dir, 'abcd'), null);
  } finally { await t.cleanup(); }
});

// ---- fix round 1 ----

const deadPid = async () => {
  const { spawnSync } = await import('node:child_process');
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout * 1;
};

test('findLive removes a stale entry, but not one that was replaced while it was probing', async () => {
  const t = await tmpDir();
  try {
    const dir = await stateDir({ KOSMOS_REVIEW_STATE_DIR: path.join(t.dir, 's') });
    const id = idFor('/x');
    await writeEntry(dir, id, { pid: process.pid, port: 1, token: 'old' });
    const fresh = { pid: process.pid, port: 2, token: 'new' };
    const entry = await findLive(dir, id, {
      probe: async () => { await writeEntry(dir, id, fresh); return false; }, // the "old" server fails its probe; a new one registers meanwhile
    });
    assert.equal(entry, null);
    assert.deepEqual(await readEntry(dir, id), fresh, 'the newer entry survives');
    const gone = await findLive(dir, id, { probe: async () => false });
    assert.equal(gone, null);
    assert.equal(await readEntry(dir, id), null, 'a genuinely stale entry is removed');
  } finally { await t.cleanup(); }
});

test('acquireStartLock takes a lock whose owner pid is dead without waiting', async () => {
  const t = await tmpDir();
  try {
    const dir = await stateDir({ KOSMOS_REVIEW_STATE_DIR: path.join(t.dir, 's') });
    const id = idFor('/x');
    await fs.writeFile(path.join(dir, `${id}.lock`), String(await deadPid()), { mode: 0o600 });
    const t0 = Date.now();
    const lock = await acquireStartLock(dir, id, { reuse: async () => null, waitMs: 5000 });
    assert.ok(lock.release, 'acquired');
    assert.ok(Date.now() - t0 < 1500, 'did not wait for the 30 s staleness timer');
    await lock.release();
    await assert.rejects(fs.stat(path.join(dir, `${id}.lock`)));
  } finally { await t.cleanup(); }
});

test('acquireStartLock waits for a live owner, then gives up; a reusable server short-circuits', async () => {
  const t = await tmpDir();
  try {
    const dir = await stateDir({ KOSMOS_REVIEW_STATE_DIR: path.join(t.dir, 's') });
    const id = idFor('/x');
    await fs.writeFile(path.join(dir, `${id}.lock`), String(process.pid), { mode: 0o600 });
    await assert.rejects(acquireStartLock(dir, id, { reuse: async () => null, waitMs: 300 }), /in progress/);
    const live = { port: 9 };
    assert.deepEqual(await acquireStartLock(dir, id, { reuse: async () => live, waitMs: 300 }), { live });
  } finally { await t.cleanup(); }
});

// ---- fix round 2: where the round key lives ----

test('the round key directory is under XDG_STATE_HOME (default ~/.local/state), private and owner-checked, not the runtime dir', async () => {
  const t = await tmpDir();
  try {
    const xdg = path.join(t.dir, 'state-home');
    const got = await keyDir({ XDG_STATE_HOME: xdg, XDG_RUNTIME_DIR: path.join(t.dir, 'run'), HOME: t.dir });
    assert.equal(got, path.join(xdg, 'kosmos-review'));
    assert.equal((await fs.stat(got)).mode & 0o077, 0);
    assert.equal(await keyDir({ HOME: path.join(t.dir, 'home') }), path.join(t.dir, 'home', '.local', 'state', 'kosmos-review'));
    assert.equal(await keyDir({ XDG_STATE_HOME: 'relative/path', HOME: path.join(t.dir, 'home2') }), path.join(t.dir, 'home2', '.local', 'state', 'kosmos-review'), 'a relative XDG_STATE_HOME is ignored, as the spec says');
    await assert.rejects(fs.stat(path.join(t.dir, 'run')), 'nothing was created in the runtime directory');
  } finally { await t.cleanup(); }
});

test('KOSMOS_REVIEW_STATE_DIR (used by the tests) keeps the key next to the registry; a symlinked key directory is refused', async () => {
  const t = await tmpDir();
  try {
    const dir = path.join(t.dir, 's');
    assert.equal(await keyDir({ KOSMOS_REVIEW_STATE_DIR: dir }), dir);
    const real = path.join(t.dir, 'real');
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, path.join(t.dir, 'link'));
    await assert.rejects(keyDir({ KOSMOS_REVIEW_STATE_DIR: path.join(t.dir, 'link') }));
  } finally { await t.cleanup(); }
});
