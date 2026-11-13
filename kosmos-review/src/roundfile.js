// Reading a round file for an agent. The file lives in the repository, so it is untrusted until proven otherwise:
// opened without following symlinks, size-capped, parsed, authenticated with the per-review key, checked against the
// round schema and rebuilt from known fields. Only then is anything of it handed on.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { verifyRoundMac } from './roundmac.js';
import { parseRound } from './validate.js';

export const MAX_ROUND_BYTES = 4 * 1024 * 1024;

/** @returns {Promise<{ok:true, round:object} | {ok:false, reason:string}>} A refusal carries a reason, never any content. */
export async function readVerifiedRound(file, key, { slug } = {}) {
  // The round number lives in the file name, and the signed content has to agree with it: a genuine round copied
  // to a newer name (round-4.json -> round-9.json) must not pass as a new submission.
  const named = /^round-([1-9][0-9]*)\.json$/.exec(path.basename(file));
  if (!named) return { ok: false, reason: 'its name is not round-N.json' };
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants;
  let handle;
  try {
    handle = await fs.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'it cannot be opened safely (missing, or a symlink)' };
  }
  let text;
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: 'it is not a regular file' };
    if (st.size > MAX_ROUND_BYTES) return { ok: false, reason: `it is larger than ${MAX_ROUND_BYTES} bytes` };
    text = (await handle.readFile({ encoding: 'utf8' })).slice(0, MAX_ROUND_BYTES);
  } catch {
    return { ok: false, reason: 'it cannot be read' };
  } finally {
    await handle.close();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'it is not valid JSON' };
  }
  if (!key) return { ok: false, reason: 'no verification key for this review was found; a different HOME or XDG_STATE_HOME than the one `serve` used, or a round from before signing, gives this, so it need not be tampering, but it cannot be trusted either' };
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.mac !== 'string') return { ok: false, reason: 'it has no MAC' };
  if (!verifyRoundMac(key, parsed)) return { ok: false, reason: 'its MAC does not match' };
  let round;
  try {
    round = parseRound(parsed);
  } catch {
    return { ok: false, reason: 'it does not match the round schema' };
  }
  if (round.round !== Number(named[1])) return { ok: false, reason: 'its round number does not match its file name' };
  if (slug !== undefined && round.slug !== slug) return { ok: false, reason: 'its slug does not match this review' };
  return { ok: true, round };
}

/** The round as pretty JSON that cannot contain an angle bracket, so no wrapper tag can be closed from inside it. */
export const renderRound = (round) => JSON.stringify(round, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
