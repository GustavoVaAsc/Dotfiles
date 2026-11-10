// Where running servers announce themselves, so a second `serve` for the same
// review folder can reuse the first. Lives in a per-user private directory
// outside the repository, because the entry holds the access token.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const idFor = (reviewDir) => crypto.createHash('sha256').update(reviewDir).digest('hex').slice(0, 16);

export async function stateDir(env = process.env) {
  const uid = process.getuid?.();
  const dir = env.KOSMOS_REVIEW_STATE_DIR
    || (env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'kosmos-review') : path.join(os.tmpdir(), `kosmos-review-${uid ?? 'user'}`));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`state directory ${dir} must be a real directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`state directory ${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
  return dir;
}

const entryFile = (dir, id) => path.join(dir, `${id}.json`);

export async function writeEntry(dir, id, entry) {
  const tmp = `${entryFile(dir, id)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
  await fs.rename(tmp, entryFile(dir, id));
}

export async function readEntry(dir, id) {
  try {
    return JSON.parse(await fs.readFile(entryFile(dir, id), 'utf8'));
  } catch {
    return null;
  }
}

export async function removeEntry(dir, id) {
  await fs.rm(entryFile(dir, id), { force: true });
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Asks the server on the entry's port who it is. Resolves true only for our own server of that folder and pid. */
export function probe(entry, id, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: entry.port, path: '/healthz', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(res.statusCode === 200 && json.app === 'kosmos-review' && json.id === id && json.pid === entry.pid);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

const sameEntry = (a, b) => a && b && a.pid === b.pid && a.port === b.port && a.token === b.token;

/**
 * The entry of a running server for this folder, or null. A stale entry is removed, but only if it is still
 * the entry that failed the probe: a server that registered while we were probing keeps its entry.
 */
export async function findLive(dir, id, { probe: probeFn = probe } = {}) {
  const entry = await readEntry(dir, id);
  if (!entry || !Number.isInteger(entry.pid) || !Number.isInteger(entry.port)) return null;
  if (pidAlive(entry.pid) && (await probeFn(entry, id))) return entry;
  if (sameEntry(await readEntry(dir, id), entry)) await removeEntry(dir, id);
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises "start a server for this folder". The lock file holds the owner's pid, so a lock left by a dead
 * process is taken over at once. Returns { release } when acquired, or { live } when a server turned up meanwhile.
 */
export async function acquireStartLock(dir, id, { reuse, waitMs = 10_000 }) {
  const lock = path.join(dir, `${id}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return { release: () => fs.rm(lock, { force: true }) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const live = await reuse();
    if (live) return { live };
    const owner = Number.parseInt(await fs.readFile(lock, 'utf8').catch(() => ''), 10);
    const age = Date.now() - (await fs.stat(lock).then((s) => s.mtimeMs, () => Date.now()));
    // An empty file is a lock being written right now; give it a few seconds before calling it stale.
    if (Number.isInteger(owner) ? !pidAlive(owner) : age > 5000) {
      await fs.rm(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error('another kosmos-review start is in progress; try again');
    await sleep(100);
  }
}

/**
 * Tells a running server "someone is still using you" with its own token, through the authenticated ping that
 * counts as activity for its idle timer. (The probe above deliberately does not.) Best effort: false on any failure.
 */
export function touchServer(entry, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: entry.port, path: '/api/ping', headers: { authorization: `Bearer ${entry.token}` }, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
