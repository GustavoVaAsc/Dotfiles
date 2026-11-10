// Command line for kosmos-review. The skill only ever calls this.
import fs from 'node:fs/promises';
import { openSync, closeSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import markdownit from '#markdown-it';
import { createMarkdown } from '../web/lib/markdown.js';
import { resolveReview, PathError } from './paths.js';
import { createReviewServer } from './server.js';
import { createStore } from './store.js';
import { stateDir, idFor, writeEntry, readEntry, removeEntry, findLive, probe, acquireStartLock, touchServer } from './registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.dirname(HERE);
const ENTRY_POINT = path.join(APP_DIR, 'kosmos-review');
const DEFAULT_IDLE_MINUTES = 120;
const MAX_IDLE_MINUTES = 60 * 24 * 7;
const MIN_IDLE_MINUTES = 1 / 60; // one second: anything smaller would shut the server down before the page loads

const USAGE = `usage:
  kosmos-review serve  <project-root> <slug> [--idle-minutes N]   start (or reuse) the review server, print the URL, return at once
  kosmos-review check  <project-root> <slug>                      validate the kosmos-question fences in doc.md
  kosmos-review latest <project-root> <slug>                      print the path of the newest round-N.json
  kosmos-review stop   <project-root> <slug>                      stop the review server

The review folder is <project-root>/docs/reviews/<slug>/ and must already contain doc.md.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const opts = { idleMinutes: DEFAULT_IDLE_MINUTES, foreground: false, quiet: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--idle-minutes') {
      const value = Number(rest[++i]);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_IDLE_MINUTES) throw new UsageError(`--idle-minutes needs a number between 0 and ${MAX_IDLE_MINUTES}`);
      opts.idleMinutes = Math.max(value, MIN_IDLE_MINUTES);
    } else if (arg === '--foreground') {
      opts.foreground = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new UsageError('expected <project-root> and <slug>');
  return { command, root: positional[0], slug: positional[1], opts };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const urlFor = (entry) => `http://127.0.0.1:${entry.port}/#token=${entry.token}`;

/** A reused server gets a ping with its own token, so asking for the URL again also resets its idle timer. */
async function reuse(review, entry, idleMinutes) {
  await touchServer(entry);
  announce(review, entry, 'reused, already running', idleMinutes);
}

function announce(review, entry, how, idleMinutes) {
  console.log(`URL: ${urlFor(entry)}`);
  console.log(`Review folder: ${review.relReviewDir}`);
  console.log(`Server: pid ${entry.pid}, port ${entry.port} (${how})`);
  console.log(`It stops by itself after ${entry.idleMinutes ?? idleMinutes} minutes without requests. Stop now: kosmos-review stop ${review.projectRoot} ${review.slug}`);
}

async function runForeground(review, opts, dir, id) {
  const token = crypto.randomBytes(24).toString('base64url');
  const instance = createReviewServer({
    reviewDir: review.reviewDir,
    projectRoot: review.projectRoot,
    slug: review.slug,
    token,
    idleMs: Math.round(opts.idleMinutes * 60_000),
    onIdle: () => shutdown(),
    webDir: path.join(APP_DIR, 'web'),
    vendorDir: path.join(APP_DIR, 'vendor'),
  });
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    const current = await readEntry(dir, id);
    if (current?.pid === process.pid) await removeEntry(dir, id);
    await instance.close().catch(() => {});
    process.exit(0);
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);

  const { port } = await instance.start();
  const entry = { id, pid: process.pid, port, token, reviewDir: review.reviewDir, projectRoot: review.projectRoot, slug: review.slug, startedAt: new Date().toISOString(), idleMinutes: opts.idleMinutes };
  await writeEntry(dir, id, entry);
  if (!opts.quiet) announce(review, entry, 'running in the foreground; Ctrl-C to stop', opts.idleMinutes);
  return new Promise(() => {}); // run until shutdown() exits the process
}

async function startDetached(review, opts, dir, id) {
  const logPath = path.join(dir, `${id}.log`);
  const logFd = openSync(logPath, 'w', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [ENTRY_POINT, 'serve', review.projectRoot, review.slug, '--foreground', '--quiet', '--idle-minutes', String(opts.idleMinutes)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
  } finally {
    closeSync(logFd);
  }
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = await readEntry(dir, id);
    if (entry && entry.pid === child.pid && (await probe(entry, id))) return entry;
    if (exited) break;
    await sleep(50);
  }
  let log = '';
  try { log = readFileSync(logPath, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch { /* no log */ }
  throw new Error(`the server did not start${log ? `:\n${log}` : ''}`);
}

async function cmdServe(review, opts) {
  const dir = await stateDir();
  const id = idFor(review.reviewDir);
  const existing = await findLive(dir, id);
  if (opts.foreground) {
    if (existing) throw new Error(`a server is already running for ${review.relReviewDir} (pid ${existing.pid}); stop it first with: kosmos-review stop ${review.projectRoot} ${review.slug}`);
    return runForeground(review, opts, dir, id);
  }
  if (existing) {
    await reuse(review, existing, opts.idleMinutes);
    return 0;
  }
  const lock = await acquireStartLock(dir, id, { reuse: () => findLive(dir, id) });
  if (lock.live) {
    await reuse(review, lock.live, opts.idleMinutes);
    return 0;
  }
  try {
    const raced = await findLive(dir, id);
    if (raced) await reuse(review, raced, opts.idleMinutes);
    else announce(review, await startDetached(review, opts, dir, id), 'started, detached', opts.idleMinutes);
  } finally {
    await lock.release();
  }

  const markdown = createMarkdown({ markdownit });
  const issues = markdown.parse(await fs.readFile(review.docPath, 'utf8')).issues;
  for (const issue of issues) console.error(`warning: ${review.relReviewDir}/doc.md:${issue.line}: ${issue.message}`);
  return 0;
}

async function cmdCheck(review) {
  const text = await fs.readFile(review.docPath, 'utf8');
  const { issues, questions } = createMarkdown({ markdownit }).parse(text);
  for (const issue of issues) console.log(`${review.relReviewDir}/doc.md:${issue.line}: ${issue.message}`);
  if (issues.length) {
    console.log(`${issues.length} problem(s) in the question fences`);
    return 1;
  }
  console.log(`ok: ${questions.length} question(s)`);
  return 0;
}

async function cmdLatest(review) {
  const store = createStore({ reviewDir: review.reviewDir, slug: review.slug, relReviewDir: review.relReviewDir });
  const last = (await store.listRounds()).at(-1);
  if (!last) {
    console.error(`no round submitted yet in ${review.relReviewDir}/`);
    return 1;
  }
  const file = path.join(review.reviewDir, `round-${last.round}.json`);
  if (!(await fs.lstat(file)).isFile()) {
    console.error(`${file} is not a regular file`);
    return 1;
  }
  console.log(file);
  return 0;
}

async function cmdStop(review) {
  const dir = await stateDir();
  const id = idFor(review.reviewDir);
  const entry = await findLive(dir, id);
  if (!entry) {
    console.log('not running');
    return 0;
  }
  const gone = async (ms) => {
    for (let waited = 0; waited < ms; waited += 50) {
      if (!(await probe(entry, id, 300))) return true;
      await sleep(50);
    }
    return false;
  };
  process.kill(entry.pid, 'SIGTERM');
  let how = 'stopped';
  if (!(await gone(3000))) {
    process.kill(entry.pid, 'SIGKILL'); // the pid was just verified through /healthz, so this is our server
    how = 'stopped (it ignored SIGTERM, so it was killed)';
    if (!(await gone(2000))) {
      console.error('the server is still answering after SIGKILL');
      return 1;
    }
  }
  await removeEntry(dir, id);
  await fs.rm(path.join(dir, `${id}.log`), { force: true });
  console.log(how);
  return 0;
}

export async function main(argv) {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      console.log(USAGE);
      return argv.length === 0 ? 2 : 0;
    }
    if (!['serve', 'check', 'latest', 'stop'].includes(argv[0])) throw new UsageError(`unknown command ${argv[0]}`);
    const { command, root, slug, opts } = parseArgs(argv);
    const review = await resolveReview(root, slug);
    if (command === 'serve') return await cmdServe(review, opts);
    if (command === 'check') return await cmdCheck(review);
    if (command === 'latest') return await cmdLatest(review);
    return await cmdStop(review);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n${USAGE}`);
      return 2;
    }
    if (err instanceof PathError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    console.error(`error: ${err.message}`);
    return 1;
  }
}
