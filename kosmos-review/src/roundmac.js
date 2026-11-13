// The review server signs every round it writes with a per-review key kept outside the repository, so a file that
// merely looks like a round (planted by a checkout, another tool, or an injected agent) can be told apart.
import crypto from 'node:crypto';

/** JSON with sorted keys at every level: the same data always gives the same bytes, whatever the key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const MAC_RE = /^hmac-sha256:([0-9a-f]{64})$/;
const hmac = (key, round) => {
  const { mac, ...rest } = round; // the MAC is over everything except itself
  return crypto.createHmac('sha256', key).update(canonicalJson(rest)).digest();
};

export const signRound = (key, round) => `hmac-sha256:${hmac(key, round).toString('hex')}`;

export function verifyRoundMac(key, round) {
  if (!key || round === null || typeof round !== 'object' || typeof round.mac !== 'string') return false;
  const match = MAC_RE.exec(round.mac);
  return match !== null && crypto.timingSafeEqual(Buffer.from(match[1], 'hex'), hmac(key, round));
}
