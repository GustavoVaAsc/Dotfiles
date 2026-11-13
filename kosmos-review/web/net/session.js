// The access token travels in the URL fragment (never sent to a server or in a Referer),
// is kept in sessionStorage for reloads, and is removed from the address bar.

const KEY = 'kosmos-review-token';
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

function safe(fn) {
  try {
    return fn();
  } catch {
    return null; // storage can be blocked
  }
}

export function initSession({ location, history, storage }) {
  const match = /(?:^#|&)token=([^&]*)/.exec(location.hash);
  if (match && TOKEN_RE.test(match[1])) {
    safe(() => storage.setItem(KEY, match[1]));
    history.replaceState(null, '', location.pathname + location.search);
    return match[1];
  }
  const stored = safe(() => storage.getItem(KEY));
  return stored && TOKEN_RE.test(stored) ? stored : null;
}

const TICKET_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The browser is started with #ticket=<single-use ticket> instead of the token (a command line is readable by other
 * local users). Reads it and removes it from the address bar at once; null when there is none or it is malformed.
 */
export function takeTicket({ location, history }) {
  const match = /(?:^#|&)ticket=([^&]*)/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return TICKET_RE.test(match[1]) ? match[1] : null;
}

/** Swaps the ticket for the token (once, server side), keeps the token for reloads. Null on any failure. */
export async function exchangeTicket(ticket, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), storage }) {
  try {
    const res = await fetchImpl('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }), cache: 'no-store' });
    if (!res.ok) return null;
    const { token } = await res.json();
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    safe(() => storage.setItem(KEY, token));
    return token;
  } catch {
    return null;
  }
}
