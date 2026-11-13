// Reads and writes the files of one review folder: doc.md (read-only), draft.json,
// round-N.json (never overwritten) and meta.json. All names are fixed here or
// derived from integers; no client-supplied path ever reaches the filesystem.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { confine, PathError } from './paths.js';
import { createMutex } from './mutex.js';
import { signRound } from './roundmac.js';
import { parseReview } from './validate.js';

const MAX_DOC_BYTES = 5 * 1024 * 1024;
const ROUND_RE = /^round-([1-9]\d*)\.json$/;
const SCHEMA = 1;

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

const sha256 = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');

/** Numbers of the regular files named round-N.json in a review folder, ascending. Directories and symlinks do not count. */
export async function listRoundNumbers(reviewDir) {
  const entries = await fs.readdir(reviewDir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => ROUND_RE.exec(e.name)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

export function isAnswered(answer) {
  if (answer.type === 'text') return answer.text.trim() !== '';
  return answer.selected.length > 0 || answer.other.trim() !== '';
}

export function createStore({ reviewDir, projectRoot, slug, relReviewDir, roundKey = null }) {
  const rel = relReviewDir ?? `docs/reviews/${slug}`;
  const metaLock = createMutex();
  let identity = null; // { dev, ino } of the review folder when the server started

  /**
   * Every write first proves it still targets the folder the server started on. Node has no openat(), so a
   * path-based write could otherwise follow a symlink swapped in after start (mv demo demo.real; ln -s /elsewhere demo).
   * A swap in the microseconds between this check and the write itself is the window that remains.
   */
  async function assertStable() {
    if (!projectRoot) throw new Error('store was created without a projectRoot; it cannot write');
    if (!identity) await store.pin();
    const link = path.join(projectRoot, 'docs', 'reviews', slug);
    const moved = () => new ConflictError('the review folder was moved or replaced since the server started; restart it with kosmos-review serve');
    let linkStat;
    let real;
    let current;
    try {
      linkStat = await fs.lstat(link);
      real = await fs.realpath(reviewDir);
      current = await fs.stat(reviewDir);
    } catch {
      throw moved();
    }
    if (linkStat.isSymbolicLink() || !linkStat.isDirectory() || real !== reviewDir || current.dev !== identity.dev || current.ino !== identity.ino) throw moved();
  }

  /** temp file + rename (or link, for "create only") so readers never see a partial file. */
  async function writeAtomic(name, text, { exclusive = false } = {}) {
    await assertStable();
    const tmp = path.join(reviewDir, `.${name}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const handle = await fs.open(tmp, 'wx', 0o644);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await assertStable();
      // link() fails with EEXIST instead of replacing: that is what keeps round files immutable.
      if (exclusive) await fs.link(tmp, path.join(reviewDir, name));
      else await fs.rename(tmp, path.join(reviewDir, name));
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  const toJson = (value) => JSON.stringify(value, null, 2) + '\n';

  async function readJson(name) {
    let real;
    try {
      real = await confine(reviewDir, name);
    } catch (err) {
      if (err instanceof PathError && err.status === 404) return null;
      throw err;
    }
    try {
      return JSON.parse(await fs.readFile(real, 'utf8'));
    } catch (err) {
      if (err instanceof SyntaxError || err.code === 'EISDIR') return null;
      throw err;
    }
  }

  const roundNumbers = () => listRoundNumbers(reviewDir);

  async function writeMeta(patch) {
    const meta = { ...(await store.readMeta()), ...patch };
    if (meta.createdAt === null) meta.createdAt = new Date().toISOString();
    await writeAtomic('meta.json', toJson(meta));
    return meta;
  }

  const store = {
    async readDoc() {
      const real = await confine(reviewDir, 'doc.md');
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new PathError('doc.md is not a regular file', 400);
      if (stat.size > MAX_DOC_BYTES) throw new PathError('doc.md is too large', 413);
      const bytes = await fs.readFile(real);
      return { text: bytes.toString('utf8'), hash: sha256(bytes) };
    },

    async pin() {
      const link = path.join(projectRoot, 'docs', 'reviews', slug);
      const [linkStat, current] = await Promise.all([fs.lstat(link), fs.stat(reviewDir)]);
      if (linkStat.isSymbolicLink() || !current.isDirectory()) throw new ConflictError('the review folder is not a plain directory');
      identity = { dev: current.dev, ino: current.ino };
    },

    async readDraft() {
      const draft = await readJson('draft.json');
      if (draft === null || typeof draft !== 'object') return null;
      try {
        return { schema: draft.schema, savedAt: draft.savedAt, ...parseReview(draft) };
      } catch {
        return null; // valid JSON that is not a review: behave as if there were no draft
      }
    },

    async writeDraft(review) {
      const savedAt = new Date().toISOString();
      await writeAtomic('draft.json', toJson({ schema: SCHEMA, savedAt, ...review }));
      return { savedAt };
    },

    async clearDraft() {
      await assertStable();
      await fs.unlink(path.join(reviewDir, 'draft.json')).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },

    async listRounds() {
      const out = [];
      for (const round of await roundNumbers()) {
        let data = null;
        try {
          data = await readJson(`round-${round}.json`);
        } catch {
          data = null;
        }
        out.push({
          round,
          file: `${rel}/round-${round}.json`,
          submittedAt: data?.submittedAt ?? null,
          docHash: data?.docHash ?? null,
          comments: Array.isArray(data?.comments) ? data.comments.length : null,
          answers: Array.isArray(data?.answers) ? data.answers.filter((a) => a.answered).length : null,
        });
      }
      return out;
    },

    /** Writes the next round-N.json without ever replacing an existing file. */
    async submit(review) {
      const submittedAt = new Date().toISOString();
      let round = ((await roundNumbers()).at(-1) ?? 0) + 1;
      for (let attempt = 0; attempt < 50; attempt += 1, round += 1) {
        const body = {
          schema: SCHEMA,
          round,
          slug,
          docFile: `${rel}/doc.md`,
          submittedAt,
          docHash: review.docHash,
          overall: review.overall,
          comments: [...review.comments].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || a.id.localeCompare(b.id)),
          answers: review.answers.map((a) => ({ ...a, answered: isAnswered(a) })),
        };
        if (roundKey) body.mac = signRound(roundKey, body); // lets `wait`/`latest` tell a round the server wrote from a planted file
        try {
          await writeAtomic(`round-${round}.json`, toJson(body), { exclusive: true });
        } catch (err) {
          if (err.code === 'EEXIST') continue; // taken by another submit, or by something that is not a regular file
          throw err;
        }
        // The round file is the commit point. If tidying up fails the review is still submitted, and an error
        // here would make the client resubmit a duplicate round.
        await store.clearDraft().catch((err) => console.error(`[kosmos-review] could not remove draft.json after round ${round}: ${err.message}`));
        await store.writeMetaState().catch((err) => console.error(`[kosmos-review] could not update meta.json after round ${round}: ${err.message}`));
        return { round, file: `${rel}/round-${round}.json` };
      }
      throw new Error('could not allocate a round number');
    },

    /** meta.json with the round counters derived from the files, which are authoritative. */
    async readMeta() {
      const stored = (await readJson('meta.json')) ?? {};
      const rounds = await roundNumbers();
      const last = rounds.at(-1) ?? 0;
      return {
        schema: SCHEMA,
        createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : null,
        keep: typeof stored.keep === 'boolean' ? stored.keep : null,
        keepDecidedAt: typeof stored.keepDecidedAt === 'string' ? stored.keepDecidedAt : null,
        currentRound: last + 1,
        lastSubmittedRound: last,
      };
    },

    // meta.json is read-modify-write, so every change goes through one lock: a concurrent submit
    // must not write back an older "keep" value.
    writeMetaState: (patch = {}) => metaLock(() => writeMeta(patch)),

    ensureMeta: () => metaLock(async () => {
      const existing = await readJson('meta.json');
      return existing && typeof existing.createdAt === 'string' ? store.readMeta() : writeMeta({});
    }),

    setKeep: (keep) => metaLock(async () => {
      if ((await store.readMeta()).keep !== null) throw new ConflictError('the keep decision was already made');
      return writeMeta({ keep, keepDecidedAt: new Date().toISOString() });
    }),
  };
  return store;
}
