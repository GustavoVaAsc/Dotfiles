import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PathError, validateSlug, checkRelativePath, confine, resolveReview, openRegularFile } from '../src/paths.js';
import { tmpProject, tmpDir } from './helpers.js';

test('validateSlug accepts plain slugs', () => {
  assert.equal(validateSlug('my-review_2'), 'my-review_2');
  assert.equal(validateSlug('a'), 'a');
});

test('validateSlug rejects traversal, separators, case, dots and bad types', () => {
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'A', '.hidden', 'a.b', 'a b', 'a'.repeat(65), null, undefined, 5, '-x', 'x\0']) {
    assert.throws(() => validateSlug(bad), PathError, `slug ${JSON.stringify(bad)}`);
  }
});

test('checkRelativePath returns segments for a clean relative path', () => {
  assert.deepEqual(checkRelativePath('img/a.png'), ['img', 'a.png']);
});

test('checkRelativePath rejects absolute, traversal, dot, hidden, backslash, drive and NUL paths', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', '..', 'a/./b', 'a//b', 'a\\b', 'C:/x', 'c:x', '.hidden/x', 'a/.git/x', 'a\0b', 'a/', 5, null]) {
    assert.throws(() => checkRelativePath(bad), PathError, `path ${JSON.stringify(bad)}`);
  }
});

test('confine resolves a file inside the root', async () => {
  const p = await tmpProject();
  try {
    await fs.writeFile(path.join(p.reviewDir, 'assets', 'a.png'), 'x');
    const real = await confine(path.join(p.reviewDir, 'assets'), 'a.png');
    assert.equal(real, path.join(p.reviewDir, 'assets', 'a.png'));
  } finally { await p.cleanup(); }
});

test('confine reports 404 for a missing file and 400 for a traversal attempt', async () => {
  const p = await tmpProject();
  try {
    const root = path.join(p.reviewDir, 'assets');
    await assert.rejects(confine(root, 'nope.png'), (e) => e instanceof PathError && e.status === 404);
    await assert.rejects(confine(root, '../doc.md'), (e) => e instanceof PathError && e.status === 400);
    await assert.rejects(confine(root, '/etc/passwd'), (e) => e instanceof PathError && e.status === 400);
  } finally { await p.cleanup(); }
});

test('confine rejects a symlinked file that escapes the root', async () => {
  const p = await tmpProject();
  const outside = await tmpDir();
  try {
    await fs.writeFile(path.join(outside.dir, 'secret.txt'), 'secret');
    await fs.symlink(path.join(outside.dir, 'secret.txt'), path.join(p.reviewDir, 'assets', 'link.png'));
    await assert.rejects(confine(path.join(p.reviewDir, 'assets'), 'link.png'), (e) => e instanceof PathError && e.status === 403);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('confine rejects a symlinked directory that escapes the root', async () => {
  const p = await tmpProject();
  const outside = await tmpDir();
  try {
    await fs.writeFile(path.join(outside.dir, 'secret.txt'), 'secret');
    await fs.symlink(outside.dir, path.join(p.reviewDir, 'assets', 'dir'));
    await assert.rejects(confine(path.join(p.reviewDir, 'assets'), 'dir/secret.txt'), (e) => e instanceof PathError && e.status === 403);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('confine allows a symlink that stays inside the root', async () => {
  const p = await tmpProject();
  try {
    await fs.writeFile(path.join(p.reviewDir, 'assets', 'real.png'), 'x');
    await fs.symlink('real.png', path.join(p.reviewDir, 'assets', 'alias.png'));
    assert.equal(await confine(path.join(p.reviewDir, 'assets'), 'alias.png'), path.join(p.reviewDir, 'assets', 'real.png'));
  } finally { await p.cleanup(); }
});

test('resolveReview returns real paths for a valid review folder', async () => {
  const p = await tmpProject();
  try {
    const r = await resolveReview(p.root, p.slug);
    assert.equal(r.projectRoot, p.root);
    assert.equal(r.reviewDir, p.reviewDir);
    assert.equal(r.relReviewDir, 'docs/reviews/demo');
  } finally { await p.cleanup(); }
});

test('resolveReview rejects a missing doc.md, a bad slug and a missing project root', async () => {
  const p = await tmpProject({ doc: null });
  try {
    await assert.rejects(resolveReview(p.root, p.slug), PathError);
    await assert.rejects(resolveReview(p.root, '../x'), PathError);
    await assert.rejects(resolveReview(path.join(p.root, 'missing'), p.slug), PathError);
  } finally { await p.cleanup(); }
});

test('resolveReview rejects a doc.md symlink that points outside the review folder', async () => {
  const p = await tmpProject({ doc: null });
  const outside = await tmpDir();
  try {
    await fs.writeFile(path.join(outside.dir, 'x.md'), '# x');
    await fs.symlink(path.join(outside.dir, 'x.md'), path.join(p.reviewDir, 'doc.md'));
    await assert.rejects(resolveReview(p.root, p.slug), PathError);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('resolveReview rejects a docs/reviews folder that is a symlink out of the project', async () => {
  const outside = await tmpDir();
  const p = await tmpProject({ doc: null });
  try {
    await fs.mkdir(path.join(outside.dir, 'elsewhere'), { recursive: true });
    await fs.writeFile(path.join(outside.dir, 'elsewhere', 'doc.md'), '# x');
    await fs.rm(path.join(p.root, 'docs'), { recursive: true });
    await fs.mkdir(path.join(p.root, 'docs'));
    await fs.symlink(outside.dir, path.join(p.root, 'docs', 'reviews'));
    await fs.rename(path.join(outside.dir, 'elsewhere'), path.join(outside.dir, 'demo'));
    await assert.rejects(resolveReview(p.root, 'demo'), PathError);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

// ---- fix round 1 ----

test('openRegularFile opens a regular file and returns a handle with its stat', async () => {
  const p = await tmpProject();
  try {
    const file = path.join(p.reviewDir, 'assets', 'a.png');
    await fs.writeFile(file, 'abcd');
    const { handle, size } = await openRegularFile(file);
    try {
      assert.equal(size, 4);
      assert.equal((await handle.readFile('utf8')), 'abcd');
    } finally { await handle.close(); }
  } finally { await p.cleanup(); }
});

test('openRegularFile refuses a symlink at the final component and a directory', async () => {
  const p = await tmpProject();
  try {
    await fs.writeFile(path.join(p.reviewDir, 'assets', 'real.png'), 'x');
    await fs.symlink('real.png', path.join(p.reviewDir, 'assets', 'alias.png'));
    await assert.rejects(openRegularFile(path.join(p.reviewDir, 'assets', 'alias.png')));
    await assert.rejects(openRegularFile(path.join(p.reviewDir, 'assets')));
  } finally { await p.cleanup(); }
});
