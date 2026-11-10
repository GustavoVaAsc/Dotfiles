// Path confinement. Every filesystem path the server touches goes through here.
// Clients never send a file path for writes; for reads (assets, static files)
// the URL path is checked lexically and then resolved with realpath, so a
// symlink cannot lead out of the root.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export class PathError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PathError';
    this.status = status;
  }
}

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new PathError('invalid slug: use lowercase letters, digits, "-" and "_" (max 64, must start with a letter or digit)');
  }
  return slug;
}

/** Lexical checks on a relative path that came from a URL or a document. Returns its segments. */
export function checkRelativePath(rel) {
  if (typeof rel !== 'string' || rel === '') throw new PathError('empty path');
  if (rel.length > 512) throw new PathError('path too long');
  if (rel.includes('\0')) throw new PathError('invalid path');
  if (rel.includes('\\')) throw new PathError('invalid path');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new PathError('absolute paths are not allowed');
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || seg.startsWith('.')) throw new PathError('invalid path segment');
  }
  return segments;
}

const isInside = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Resolves rel under rootReal (an already-realpath'd directory). The result is a real path inside the root. */
export async function confine(rootReal, rel) {
  const segments = checkRelativePath(rel);
  let real;
  try {
    real = await fs.realpath(path.join(rootReal, ...segments));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new PathError('not found', 404);
    throw err;
  }
  if (!isInside(rootReal, real) || real === rootReal) throw new PathError('path escapes the served folder', 403);
  return real;
}

/**
 * Locates docs/reviews/<slug>/ under the project root and checks that it, and its
 * doc.md, really live inside the project (no symlink out).
 */
export async function resolveReview(projectRootInput, slugInput) {
  const slug = validateSlug(slugInput);
  let projectRoot;
  try {
    projectRoot = await fs.realpath(path.resolve(String(projectRootInput)));
  } catch {
    throw new PathError(`project root not found: ${projectRootInput}`);
  }
  if (!(await fs.stat(projectRoot)).isDirectory()) throw new PathError(`project root is not a directory: ${projectRoot}`);

  const relReviewDir = `docs/reviews/${slug}`;
  const reviewLink = path.join(projectRoot, 'docs', 'reviews', slug);
  let reviewDir;
  try {
    if ((await fs.lstat(reviewLink)).isSymbolicLink()) {
      throw new PathError(`${relReviewDir} is a symlink; refusing to serve it`, 403);
    }
    reviewDir = await fs.realpath(reviewLink);
  } catch (err) {
    if (err instanceof PathError) throw err;
    throw new PathError(`review folder not found: ${relReviewDir}/ (write doc.md there first)`);
  }
  if (!isInside(projectRoot, reviewDir) || reviewDir === projectRoot) {
    throw new PathError(`${relReviewDir} resolves outside the project root`, 403);
  }

  const docPath = path.join(reviewDir, 'doc.md');
  let docReal;
  try {
    docReal = await fs.realpath(docPath);
  } catch {
    throw new PathError(`doc.md not found in ${relReviewDir}/`);
  }
  if (docReal !== docPath) throw new PathError(`${relReviewDir}/doc.md is a symlink; refusing to serve it`, 403);
  if (!(await fs.stat(docReal)).isFile()) throw new PathError(`${relReviewDir}/doc.md is not a regular file`);
  return { projectRoot, reviewDir, docPath, relReviewDir, slug };
}

/**
 * Opens an already-resolved file for reading without following a symlink at the last component, and checks
 * that the opened file is the one that was lstat'ed just before (same dev/ino, regular file). Closes the
 * window between realpath() and open() for the final path component; intermediate directories can still be
 * swapped in that window because Node exposes no openat().
 */
export async function openRegularFile(real) {
  const before = await fs.lstat(real);
  if (before.isSymbolicLink()) throw new PathError('refusing to follow a symlink', 403);
  if (!before.isFile()) throw new PathError('not found', 404);
  let handle;
  try {
    handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (err.code === 'ELOOP') throw new PathError('refusing to follow a symlink', 403);
    throw err;
  }
  const after = await handle.stat();
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
    await handle.close();
    throw new PathError('the file changed while it was being opened', 409);
  }
  return { handle, size: after.size };
}
