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
