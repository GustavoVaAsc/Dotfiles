import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isGitRepo, excludeReviewFolder, manualExcludeInstruction } from '../src/git-exclude.js';
import { tmpProject, tmpDir } from './helpers.js';

const EXCLUDE = (root) => path.join(root, '.git', 'info', 'exclude');

test('a folder without .git is not a repo and nothing is created', async () => {
  const p = await tmpProject();
  try {
    assert.equal(await isGitRepo(p.root), false);
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'not-a-git-repo');
    await assert.rejects(fs.stat(path.join(p.root, '.git')));
  } finally { await p.cleanup(); }
});

test('adds the anchored folder pattern to .git/info/exclude', async () => {
  const p = await tmpProject({ git: true });
  try {
    await fs.writeFile(EXCLUDE(p.root), '# comment\n*.swp\n');
    assert.equal(await isGitRepo(p.root), true);
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'added');
    const lines = (await fs.readFile(EXCLUDE(p.root), 'utf8')).split('\n');
    assert.ok(lines.includes('/docs/reviews/demo/'));
    assert.ok(lines.includes('*.swp'), 'existing lines are preserved');
  } finally { await p.cleanup(); }
});

test('is idempotent: a second call changes nothing', async () => {
  const p = await tmpProject({ git: true });
  try {
    await excludeReviewFolder(p.root, p.slug);
    const before = await fs.readFile(EXCLUDE(p.root), 'utf8');
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'already');
    assert.equal(await fs.readFile(EXCLUDE(p.root), 'utf8'), before);
    assert.equal(before.split('\n').filter((l) => l === '/docs/reviews/demo/').length, 1);
  } finally { await p.cleanup(); }
});

test('handles an exclude file without a trailing newline and a missing exclude file', async () => {
  const p = await tmpProject({ git: true });
  try {
    await fs.writeFile(EXCLUDE(p.root), 'no-newline');
    await excludeReviewFolder(p.root, p.slug);
    const lines = (await fs.readFile(EXCLUDE(p.root), 'utf8')).split('\n');
    assert.equal(lines[0], 'no-newline');
    assert.ok(lines.includes('/docs/reviews/demo/'));
    await fs.rm(path.join(p.root, '.git', 'info'), { recursive: true });
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'added');
    assert.ok((await fs.readFile(EXCLUDE(p.root), 'utf8')).includes('/docs/reviews/demo/'));
  } finally { await p.cleanup(); }
});

test('does not touch .gitignore', async () => {
  const p = await tmpProject({ git: true });
  try {
    await excludeReviewFolder(p.root, p.slug);
    await assert.rejects(fs.stat(path.join(p.root, '.gitignore')));
  } finally { await p.cleanup(); }
});

test('refuses to write through a symlinked exclude file', async () => {
  const p = await tmpProject({ git: true });
  const outside = await tmpDir();
  try {
    const target = path.join(outside.dir, 'victim');
    await fs.writeFile(target, 'untouched');
    await fs.symlink(target, EXCLUDE(p.root));
    await assert.rejects(excludeReviewFolder(p.root, p.slug));
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('refuses to write through an exclude file hard-linked to a file outside the repo', async () => {
  const p = await tmpProject({ git: true });
  const outside = await tmpDir();
  try {
    const target = path.join(outside.dir, 'victim');
    await fs.writeFile(target, 'untouched\n');
    await fs.rm(EXCLUDE(p.root), { force: true });
    try {
      await fs.link(target, EXCLUDE(p.root));
    } catch (err) {
      if (err.code === 'EXDEV') return; // different filesystems: a hard link is impossible, nothing to test
      throw err;
    }
    await assert.rejects(excludeReviewFolder(p.root, p.slug), { status: 409, message: /hard link/ });
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched\n');
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('real git ignores the folder after the append (skipped when git is missing)', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git not installed');
  const p = await tmpProject();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: p.root }).status, 0);
    const probe = () => spawnSync('git', ['check-ignore', '-q', 'docs/reviews/demo/doc.md'], { cwd: p.root }).status;
    assert.equal(probe(), 1, 'not ignored before');
    await excludeReviewFolder(p.root, p.slug);
    assert.equal(probe(), 0, 'ignored after');
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: p.root, encoding: 'utf8' }).stdout.includes('docs/'), false);
  } finally { await p.cleanup(); }
});

// ---- fix round 1 ----

test('refuses a .git/info that is a symlink', async () => {
  const p = await tmpProject({ git: true });
  const outside = await tmpDir();
  try {
    await fs.rm(path.join(p.root, '.git', 'info'), { recursive: true });
    await fs.symlink(outside.dir, path.join(p.root, '.git', 'info'));
    await assert.rejects(excludeReviewFolder(p.root, p.slug));
    assert.deepEqual(await fs.readdir(outside.dir), []);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('creates only info/ itself, never missing parents', async () => {
  const p = await tmpProject({ git: true });
  try {
    await fs.rm(path.join(p.root, '.git', 'info'), { recursive: true });
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'added');
    assert.deepEqual((await fs.readdir(path.join(p.root, '.git'))).sort(), ['HEAD', 'info', 'objects']);
  } finally { await p.cleanup(); }
});

// ---- fix round 3 ----

const sparse = async (file, bytes = 10 * 1024 * 1024) => { await fs.writeFile(file, 'gitdir: x\n'); await fs.truncate(file, bytes); };
const mkfifo = (file) => spawnSync('mkfifo', [file]).status === 0;
const GIT = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const ls = async (dir) => (await fs.readdir(dir)).sort();

test('the commondir attack: a fake gitdir inside the project pointing at another repository writes nothing anywhere', async () => {
  const p = await tmpProject();
  const other = await tmpDir('kr-victim-');
  try {
    await fs.mkdir(path.join(other.dir, '.git', 'info'), { recursive: true });
    await fs.mkdir(path.join(other.dir, '.git', 'objects'));
    await fs.writeFile(path.join(other.dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const fake = path.join(p.root, 'fake-gitdir');
    await fs.mkdir(fake);
    await fs.writeFile(path.join(fake, 'HEAD'), 'ref: x\n');
    await fs.writeFile(path.join(fake, 'gitdir'), path.join(p.root, '.git') + '\n'); // a valid-looking back-link
    await fs.writeFile(path.join(fake, 'commondir'), path.join(other.dir, '.git') + '\n');
    await fs.writeFile(path.join(p.root, '.git'), 'gitdir: fake-gitdir\n');
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'manual');
    assert.deepEqual(await ls(path.join(other.dir, '.git', 'info')), [], 'the other repository was not touched');
    assert.deepEqual(await ls(fake), ['HEAD', 'commondir', 'gitdir'], 'nothing was created in the fake git dir either');
  } finally { await p.cleanup(); await other.cleanup(); }
});

test('when .git is a file (worktree or submodule) the append is never automatic, whatever it points at', async () => {
  const p = await tmpProject();
  try {
    await fs.writeFile(path.join(p.root, '.git'), 'gitdir: /nonexistent/anywhere\n');
    assert.equal(await isGitRepo(p.root), true, 'still counts as a repo, so the page can show the manual instruction');
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'manual');
    assert.deepEqual(await ls(p.root), ['.git', 'docs']);
  } finally { await p.cleanup(); }
});

test('a .git file that does not start with "gitdir:" is not a repo', async () => {
  const p = await tmpProject();
  try {
    await fs.writeFile(path.join(p.root, '.git'), 'hello\n');
    assert.equal(await isGitRepo(p.root), false);
    assert.equal(await excludeReviewFolder(p.root, p.slug), 'not-a-git-repo');
  } finally { await p.cleanup(); }
});

test('a real git worktree gets the manual result and no repository file is written (skipped without git)', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git not installed');
  const main = await tmpProject();
  const holder = await tmpDir('kr-wt-');
  try {
    assert.equal(GIT(main.root, 'init', '-q').status, 0);
    assert.equal(GIT(main.root, 'commit', '--allow-empty', '-q', '-m', 'init').status, 0);
    const wt = path.join(holder.dir, 'wt');
    assert.equal(GIT(main.root, 'worktree', 'add', '-q', wt, '-b', 'side').status, 0);
    await fs.mkdir(path.join(wt, 'docs', 'reviews', 'demo'), { recursive: true });
    const before = await fs.readFile(path.join(main.root, '.git', 'info', 'exclude'), 'utf8').catch(() => null);
    assert.equal((await fs.lstat(path.join(wt, '.git'))).isFile(), true);
    assert.equal(await isGitRepo(wt), true);
    assert.equal(await excludeReviewFolder(wt, 'demo'), 'manual');
    assert.equal(await fs.readFile(path.join(main.root, '.git', 'info', 'exclude'), 'utf8').catch(() => null), before);
    // the instruction really works: the command prints the path git uses and the line then ignores the folder
    const target = GIT(wt, 'rev-parse', '--git-path', 'info/exclude').stdout.trim();
    const abs = path.resolve(wt, target);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, manualExcludeInstruction('demo').line + '\n');
    await fs.writeFile(path.join(wt, 'docs', 'reviews', 'demo', 'doc.md'), '# x');
    assert.equal(GIT(wt, 'check-ignore', '-q', 'docs/reviews/demo/doc.md').status, 0);
  } finally { await main.cleanup(); await holder.cleanup(); }
});

test('manualExcludeInstruction gives the exact line and a command that does not trust any file in the repo', () => {
  const m = manualExcludeInstruction('demo');
  assert.equal(m.line, '/docs/reviews/demo/');
  assert.equal(m.command, 'git rev-parse --git-path info/exclude');
});

test('isGitRepo never throws: a HEAD that is a directory, a symlink to a FIFO, a symlinked objects/ are all "not a repo"', async () => {
  const p = await tmpProject({ git: true });
  try {
    await fs.rm(path.join(p.root, '.git', 'HEAD'));
    await fs.mkdir(path.join(p.root, '.git', 'HEAD'));
    assert.equal(await isGitRepo(p.root), false);
    await fs.rmdir(path.join(p.root, '.git', 'HEAD'));
    if (mkfifo(path.join(p.root, 'pipe'))) {
      await fs.symlink(path.join(p.root, 'pipe'), path.join(p.root, '.git', 'HEAD'));
      assert.equal(await isGitRepo(p.root), false);
      await fs.rm(path.join(p.root, '.git', 'HEAD'));
    }
    await fs.writeFile(path.join(p.root, '.git', 'HEAD'), 'ref: x\n');
    await fs.rename(path.join(p.root, '.git', 'objects'), path.join(p.root, 'objects.real'));
    await fs.symlink(path.join(p.root, 'objects.real'), path.join(p.root, '.git', 'objects'));
    assert.equal(await isGitRepo(p.root), false);
  } finally { await p.cleanup(); }
});

test('isGitRepo never throws on a .git file that is oversized, unreadable, a FIFO or a directory-like oddity', async () => {
  const p = await tmpProject();
  try {
    const dotGit = path.join(p.root, '.git');
    await sparse(dotGit);
    assert.equal(await isGitRepo(p.root), false, 'oversized (sparse 10 MiB)');
    await fs.rm(dotGit);
    await fs.writeFile(dotGit, 'gitdir: x\n', { mode: 0o000 });
    if (process.getuid?.() !== 0) assert.equal(await isGitRepo(p.root), false, 'unreadable');
    await fs.rm(dotGit);
    if (mkfifo(dotGit)) assert.equal(await isGitRepo(p.root), false, 'a FIFO (must not block)');
  } finally { await p.cleanup(); }
});

test('an exclude file that is oversized, a FIFO or unreadable is refused with a clear error and is never read whole or blocked on', async () => {
  const p = await tmpProject({ git: true });
  try {
    const file = path.join(p.root, '.git', 'info', 'exclude');
    const refused = (e) => e.status === 409 && /exclude/.test(e.message);
    await sparse(file);
    await assert.rejects(excludeReviewFolder(p.root, p.slug), refused);
    assert.equal((await fs.stat(file)).size, 10 * 1024 * 1024, 'not appended to');
    await fs.rm(file);
    if (mkfifo(file)) { await assert.rejects(excludeReviewFolder(p.root, p.slug), refused); await fs.rm(file); }
    await fs.writeFile(file, '', { mode: 0o000 });
    if (process.getuid?.() !== 0) await assert.rejects(excludeReviewFolder(p.root, p.slug), refused);
  } finally { await p.cleanup(); }
});
