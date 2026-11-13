// The review server: one process serves one review folder on 127.0.0.1.
//
//   GET  /                 app shell (no data; no token needed)
//   GET  /<file>           static files from web/ and /vendor/<file> from vendor/ (read-only, allow-listed types)
//   GET  /healthz          identity probe used by the CLI to detect a live server (not activity)
//   GET  /api/ping         the page's heartbeat; with the token, counts as activity for the idle timer
//   GET  /api/state        document, draft, meta, rounds                        (token)
//   PUT  /api/draft        autosave comments and answers                        (token)
//   POST /api/submit       write the next round-N.json and clear the draft      (token)
//   POST /api/ticket       mint a single-use bootstrap ticket                   (token)
//   POST /api/session      redeem a ticket once for the token (the ticket is the credential)
//   POST /api/listener     a waiting agent's heartbeat (lease) or stop; tells the page its review will be picked up
//   POST /api/keep         answer the "keep this review in the repo?" question  (token)
//   GET  /assets/<path>    files under <review folder>/assets/                  (token)
//
// Every route runs the Host allow-list first. Everything except the app shell
// and its static code needs the bearer token, and writes also refuse
// cross-origin callers and non-JSON bodies.
import http from 'node:http';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGuard } from './security.js';
import { confine, checkRelativePath, openRegularFile } from './paths.js';
import { createStore } from './store.js';
import { parseReview, parseKeep } from './validate.js';
import { isGitRepo, excludeReviewFolder, manualExcludeInstruction } from './git-exclude.js';
import { idFor } from './registry.js';
import { createMutex } from './mutex.js';

const MAX_BODY = 512 * 1024;
const MAX_DRAIN = 16 * 1024 * 1024;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.vtt': 'text/vtt',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const decodePath = (raw) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'malformed URL encoding');
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_DRAIN) {
        req.destroy();
        return;
      }
      if (over) return;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => (over ? reject(new HttpError(413, `body too large (max ${MAX_BODY} bytes)`)) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new HttpError(400, 'request aborted')); });
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

export function createReviewServer({ reviewDir, projectRoot, slug, token, idleMs = 0, onIdle, webDir, vendorDir, listenerLeaseMs = 30_000, ticketTtlMs = 60_000, roundKey = null, launcherPath = null, launcherTtlMs = 45_000 }) {
  const relReviewDir = `docs/reviews/${slug}`;
  const store = createStore({ reviewDir, projectRoot, slug, relReviewDir, roundKey });
  const id = idFor(reviewDir);
  const keepLock = createMutex();
  let guard;
  let webRoot;
  let vendorRoot;
  let idleTimer;

  const touch = () => {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => onIdle?.(), idleMs);
  };

  // Agents waiting for a submitted round (kosmos-review wait). In memory only: a lease that the waiter renews with
  // an authenticated heartbeat, so a waiter that dies simply expires. Nothing here comes from the document.
  const listeners = new Map(); // id -> { expires (ms since epoch), pid }
  const MAX_LISTENERS = 16;
  const pidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  };
  // A lease also dies with its waiter: a killed `wait` must not keep the page claiming "sent to the agent".
  const listenerStatus = () => {
    const now = Date.now();
    for (const [lid, l] of listeners) if (l.expires <= now || (l.pid !== undefined && !pidAlive(l.pid))) listeners.delete(lid);
    return { active: listeners.size > 0, count: listeners.size };
  };
  // Single-use bootstrap tickets: the browser is started with one of these instead of the token, because a
  // command line is readable by other local users. Minted with the token, redeemed once for the token.
  const tickets = new Map(); // ticket -> expiry
  const MAX_TICKETS = 8;
  // The launcher page that carries a ticket to the browser (see launcher.js) is deleted when a ticket is used, a short
  // time after each mint even if it never is, at start (a stale one) and on close.
  const launcherTimers = new Set();
  const dropLauncher = () => (launcherPath ? fs.rm(launcherPath, { force: true }).catch(() => {}) : Promise.resolve());

  function send(res, status, body, headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const type = typeof body === 'string' || Buffer.isBuffer(body) ? undefined : 'application/json; charset=utf-8';
    res.writeHead(status, {
      ...(type ? { 'Content-Type': type, 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } : {}),
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  const refuse = (denial) => { throw new HttpError(denial.status, denial.error); };

  async function sendFile(res, real, type, extraHeaders = {}) {
    const { handle, size } = await openRegularFile(real);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, ...extraHeaders });
    await pipeline(handle.createReadStream(), res); // closes the handle when done or on error
  }

  async function sendIndex(res) {
    const file = await confine(webRoot, 'index.html');
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = (await fs.readFile(file, 'utf8')).replaceAll('__CSP_NONCE__', nonce);
    send(res, 200, html, {
      'Content-Type': STATIC_TYPES['.html'],
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        'img-src blob:',
        'media-src blob:',
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join('; '),
    });
  }

  async function serveStatic(res, root, rel) {
    checkRelativePath(rel);
    const type = STATIC_TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new HttpError(404, 'not found');
    await sendFile(res, await confine(root, rel), type);
  }

  async function serveAsset(res, rel) {
    checkRelativePath(rel);
    const type = ASSET_TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new HttpError(415, 'unsupported asset type');
    let assetsRoot;
    try {
      assetsRoot = await fs.realpath(path.join(reviewDir, 'assets'));
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (!assetsRoot.startsWith(reviewDir + path.sep)) throw new HttpError(403, 'assets folder escapes the review folder');
    await sendFile(res, await confine(assetsRoot, rel), type, {
      // The file may be attacker-influenced SVG/HTML: never let it run script if opened directly.
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
  }

  const apiRoutes = {
    '/api/ping': { method: 'GET', handler: (req, res) => send(res, 200, { ok: true }) },
    '/api/state': { method: 'GET', handler: handleState },
    '/api/listener': { method: 'POST', write: true, handler: handleListener },
    '/api/ticket': { method: 'POST', write: true, handler: handleTicket },
    '/api/draft': { method: 'PUT', write: true, handler: handleDraft },
    '/api/submit': { method: 'POST', write: true, handler: handleSubmit },
    '/api/keep': { method: 'POST', write: true, handler: handleKeep },
  };

  async function handleState(req, res) {
    const [doc, draft, meta, rounds, isRepo] = await Promise.all([store.readDoc(), store.readDraft(), store.readMeta(), store.listRounds(), isGitRepo(projectRoot)]);
    const last = rounds.at(-1);
    send(res, 200, {
      app: 'kosmos-review',
      slug,
      reviewPath: relReviewDir,
      doc,
      draft,
      meta,
      rounds,
      round: meta.currentRound,
      status: !draft && last && last.docHash === doc.hash ? 'submitted' : 'open',
      git: { isRepo },
      needsKeepPrompt: isRepo && meta.keep === null,
      listener: listenerStatus(),
    });
  }

  async function handleDraft(req, res) {
    const review = parseReview(await readJsonBody(req));
    send(res, 200, { ok: true, ...(await store.writeDraft(review)) });
  }

  async function handleSubmit(req, res) {
    const review = parseReview(await readJsonBody(req));
    const doc = await store.readDoc();
    if (review.docHash !== doc.hash) {
      throw new HttpError(409, 'the document changed since you opened it; reload the page (your draft is kept)', { currentHash: doc.hash });
    }
    // Whether someone is waiting is read before the round exists: the waiter unregisters the moment it sees the file.
    const listener = listenerStatus();
    send(res, 200, { ok: true, ...(await store.submit(review)), listener });
  }

  async function handleTicket(req, res) {
    const now = Date.now();
    for (const [t, expires] of tickets) if (expires <= now) tickets.delete(t);
    if (tickets.size >= MAX_TICKETS) throw new HttpError(409, 'too many outstanding tickets');
    const ticket = crypto.randomBytes(24).toString('base64url');
    tickets.set(ticket, now + ticketTtlMs);
    if (launcherPath) {
      const timer = setTimeout(() => { launcherTimers.delete(timer); dropLauncher(); }, launcherTtlMs);
      timer.unref();
      launcherTimers.add(timer);
    }
    send(res, 200, { ticket });
  }

  /** The ticket is the credential here, so there is no bearer token; every other write guard still applies. */
  async function handleSession(req, res) {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed', { allow: 'POST' });
    const denied = guard.checkWrite(req);
    if (denied) refuse(denied);
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.ticket)) throw new HttpError(400, 'expected { ticket }');
    const expires = tickets.get(body.ticket);
    tickets.delete(body.ticket); // single use, whatever the outcome
    if (!expires || expires <= Date.now()) throw new HttpError(401, 'invalid or expired ticket');
    touch();
    await dropLauncher(); // the ticket is spent, and so is the page that carries it
    send(res, 200, { token });
  }

  async function handleListener(req, res) {
    const body = await readJsonBody(req);
    const valid = body && typeof body === 'object' && !Array.isArray(body) && typeof body.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.id) && ['beat', 'stop'].includes(body.action);
    if (!valid) throw new HttpError(400, 'expected { id: 8-64 letters/digits/_/-, action: "beat" | "stop" }');
    listenerStatus(); // drop expired leases first
    if (body.pid !== undefined && !(Number.isInteger(body.pid) && body.pid > 0 && body.pid <= 2 ** 31 - 1)) throw new HttpError(400, 'pid must be a positive integer');
    if (body.action === 'stop') listeners.delete(body.id);
    else if (listeners.has(body.id) || listeners.size < MAX_LISTENERS) listeners.set(body.id, { expires: Date.now() + listenerLeaseMs, pid: body.pid });
    else throw new HttpError(409, 'too many listeners');
    send(res, 200, { ok: true, ...listenerStatus() });
  }

  async function handleKeep(req, res) {
    const keep = parseKeep(await readJsonBody(req));
    if (!(await isGitRepo(projectRoot))) {
      send(res, 200, { ok: true, keep, exclude: 'not-a-git-repo' });
      return;
    }
    // One decision at a time: parallel answers must not each append to .git/info/exclude. The append comes
    // before the decision is stored, so a failed append leaves the question open for a retry.
    const exclude = await keepLock(async () => {
      if ((await store.readMeta()).keep !== null) throw new HttpError(409, 'the keep decision was already made');
      const result = keep ? null : await excludeReviewFolder(projectRoot, slug);
      await store.setKeep(keep);
      return result;
    });
    // 'manual' (.git is a file): nothing was written; tell the page the exact line and how to find the file.
    send(res, 200, { ok: true, keep, exclude, ...(exclude === 'manual' ? { manual: manualExcludeInstruction(slug) } : {}) });
  }

  async function handle(req, res) {
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) throw new HttpError(400, 'bad request target');
    const denyHost = guard.checkHost(req);
    if (denyHost) refuse(denyHost);

    const pathname = req.url.split('?')[0].split('#')[0];

    if (pathname === '/healthz') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      return send(res, 200, { app: 'kosmos-review', id, pid: process.pid });
    }

    if (pathname === '/api/session') return handleSession(req, res);

    if (pathname.startsWith('/api/') || pathname.startsWith('/assets/')) {
      const denyRead = guard.checkRead(req) ?? guard.checkToken(req);
      if (denyRead) refuse(denyRead);
      // Only a request that proved it holds the token counts as activity. Rejected requests, /healthz and static
      // files do not: any web page can fire those blind at 127.0.0.1 and would otherwise keep the server alive forever.
      // Listener heartbeats do not either: a waiting agent must not keep the server (and its token) alive by itself.
      if (pathname !== '/api/listener') touch();

      if (pathname.startsWith('/assets/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allow: 'GET' });
        return serveAsset(res, decodePath(pathname.slice('/assets/'.length)));
      }
      const api = apiRoutes[pathname];
      if (!api) throw new HttpError(404, 'not found');
      if (req.method !== api.method) throw new HttpError(405, 'method not allowed', { allow: api.method });
      if (api.write) {
        const denyWrite = guard.checkWrite(req);
        if (denyWrite) refuse(denyWrite);
      }
      return api.handler(req, res);
    }

    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed', { allow: 'GET' });
    if (pathname === '/' || pathname === '/index.html') return sendIndex(res);
    if (pathname.startsWith('/vendor/')) return serveStatic(res, vendorRoot, decodePath(pathname.slice('/vendor/'.length)));
    return serveStatic(res, webRoot, decodePath(pathname.slice(1)));
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = Number.isInteger(err.status) && err.status < 500 ? err.status : 500;
      if (status === 500) console.error(`[kosmos-review] ${req.method} ${req.url.split('?')[0]}: ${err.stack || err}`);
      const headers = { ...(err.extra?.allow ? { Allow: err.extra.allow } : {}), ...(status === 413 ? { Connection: 'close' } : {}) };
      const { allow, ...extra } = err.extra ?? {};
      send(res, status, { error: status === 500 ? 'internal error' : err.message, ...extra }, headers);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  return {
    server,
    async start() {
      webRoot = await fs.realpath(webDir);
      vendorRoot = await fs.realpath(vendorDir);
      await dropLauncher();
      await store.pin();
      await store.ensureMeta();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const { port } = server.address();
      guard = createGuard({ port, token });
      touch();
      return { port };
    },
    async close() {
      clearTimeout(idleTimer);
      launcherTimers.forEach(clearTimeout);
      await dropLauncher();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
