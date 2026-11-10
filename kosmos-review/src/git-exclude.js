// The "keep this review in the repo?" answer "no" lands here.
//
// For an ordinary checkout (".git" is a real directory) the review folder is appended to .git/info/exclude,
// which is local-only, so .gitignore is never dirtied. This is the one write the server makes outside the review
// folder, so it is deliberately narrow.
//
// When ".git" is a file (a worktree or a submodule) nothing is written: the file says where the real git dir is, but
// that path, and the "commondir" and config files behind it, are repository-controlled input, and following them
// would let a crafted checkout steer the append into a different repository. The caller shows the user the line to
// add by hand instead ('manual').
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { validateSlug } from './paths.js';

const MAX_META_BYTES = 64 * 1024;

export class GitMetaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitMetaError';
    this.status = 409;
  }
}

/**
 * Reads a small regular file safely: no symlink at the last component, never blocks on a FIFO (O_NONBLOCK, and the
 * type is checked on the opened handle), refuses anything over 64 KiB. Returns null when it does not exist.
 */
async function readSmallFile(file) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants;
  let handle;
  try {
    handle = await fs.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new GitMetaError(`cannot read ${path.basename(file)} (${err.code ?? 'error'})`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new GitMetaError(`${path.basename(file)} is not a regular file`);
    if (st.size > MAX_META_BYTES) throw new GitMetaError(`${path.basename(file)} is larger than ${MAX_META_BYTES} bytes`);
    return await handle.readFile('utf8');
  } catch (err) {
    if (err instanceof GitMetaError) throw err;
    throw new GitMetaError(`cannot read ${path.basename(file)} (${err.code ?? 'error'})`);
  } finally {
    await handle.close();
  }
}

const lstatOrNull = (p) => fs.lstat(p).catch(() => null);

/**
 * What ".git" is: { kind: 'none' }, { kind: 'dir', infoDir } for a real .git directory that looks like one
 * (HEAD is a regular file, objects/ a real directory), or { kind: 'file' } for a worktree/submodule pointer file.
 * Never throws: anything odd is "none", and unexpected errors are logged.
 */
async function inspectGit(projectRoot) {
  try {
    const dotGit = path.join(projectRoot, '.git');
    const st = await lstatOrNull(dotGit);
    if (!st) return { kind: 'none' };
    if (st.isDirectory()) {
      const [head, objects] = await Promise.all([lstatOrNull(path.join(dotGit, 'HEAD')), lstatOrNull(path.join(dotGit, 'objects'))]);
      return head?.isFile() && objects?.isDirectory() ? { kind: 'dir', infoDir: path.join(dotGit, 'info') } : { kind: 'none' };
    }
    if (st.isFile()) {
      // Only its shape is checked; the target is never followed.
      return /^gitdir:\s*\S/.test((await readSmallFile(dotGit)) ?? '') ? { kind: 'file' } : { kind: 'none' };
    }
    return { kind: 'none' };
  } catch (err) {
    if (!(err instanceof GitMetaError)) console.error(`[kosmos-review] could not inspect .git: ${err.stack || err}`);
    return { kind: 'none' };
  }
}

/** True for a normal checkout and for a worktree/submodule (so the page still asks, and can show the manual step). */
export async function isGitRepo(projectRoot) {
  return (await inspectGit(projectRoot)).kind !== 'none';
}

/** What to tell the user when the exclude cannot be written automatically. */
export function manualExcludeInstruction(slug) {
  validateSlug(slug);
  return { line: `/docs/reviews/${slug}/`, command: 'git rev-parse --git-path info/exclude' };
}

/** info/ must be a plain directory: create it if absent (never its parents), refuse a symlink. */
async function ensureInfoDir(infoDir) {
  try {
    await fs.mkdir(infoDir);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const st = await fs.lstat(infoDir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new GitMetaError('refusing to write into .git/info: it is not a plain directory');
}

/** Returns 'added', 'already', 'manual' or 'not-a-git-repo'. Idempotent. Throws GitMetaError (409) when it must refuse. */
export async function excludeReviewFolder(projectRoot, slug) {
  validateSlug(slug);
  const git = await inspectGit(projectRoot);
  if (git.kind === 'none') return 'not-a-git-repo';
  if (git.kind === 'file') return 'manual';

  const pattern = `/docs/reviews/${slug}/`;
  const accepted = new Set([pattern, pattern.slice(0, -1), pattern.slice(1), pattern.slice(1, -1)]);
  await ensureInfoDir(git.infoDir);
  const file = path.join(git.infoDir, 'exclude');

  let existing;
  try {
    existing = await readSmallFile(file);
  } catch (err) {
    throw new GitMetaError(`refusing to modify .git/info/exclude: ${err.message}`);
  }
  if (existing !== null && existing.split(/\r?\n/).some((line) => accepted.has(line.trim()))) return 'already';

  // O_NOFOLLOW: if exclude is (or becomes) a symlink the open fails instead of writing elsewhere.
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants;
  let handle;
  try {
    handle = await fs.open(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o644);
  } catch (err) {
    throw new GitMetaError(`refusing to modify .git/info/exclude (${err.code ?? 'error'})`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new GitMetaError('refusing to modify .git/info/exclude: not a regular file');
    // O_NOFOLLOW stops symlinks but not hard links: a second name for the same inode would carry the append to a
    // file outside the repository.
    if (st.nlink !== 1) throw new GitMetaError('refusing to modify .git/info/exclude: it has other hard links');
    // The handle must still be the file at that path (nothing swapped between the open and this check).
    const current = await lstatOrNull(file);
    if (!current || current.dev !== st.dev || current.ino !== st.ino) {
      throw new GitMetaError('refusing to modify .git/info/exclude: it changed while being opened');
    }
    const lead = existing && !existing.endsWith('\n') ? '\n' : '';
    await handle.write(`${lead}# kosmos-review: local-only review folder\n${pattern}\n`);
  } finally {
    await handle.close();
  }
  return 'added';
}
