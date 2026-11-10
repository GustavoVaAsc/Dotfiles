// The only module that talks to the review server. fetch is injected so it can be tested.

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KiB (bytes, not characters)
const encoder = new TextEncoder();

export function createApiClient({ token, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), base = '' }) {
  const auth = { authorization: `Bearer ${token}` };

  async function request(method, path, body) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: text === undefined ? auth : { ...auth, 'content-type': 'application/json' },
        body: text,
        cache: 'no-store',
        keepalive: text !== undefined && encoder.encode(text).length < KEEPALIVE_LIMIT,
      });
    } catch (err) {
      throw new ApiError(0, 'cannot reach the review server (it may have stopped after being idle)', err);
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* non-JSON error body */ }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
    return data;
  }

  const assetBlobs = new Map();

  return {
    getState: () => request('GET', '/api/state'),
    saveDraft: (review) => request('PUT', '/api/draft', review),
    submit: (review) => request('POST', '/api/submit', review),
    setKeep: (keep) => request('POST', '/api/keep', { keep }),

    /** Heartbeat. Authenticated, because only token-bearing requests count as activity for the server's idle timer. */
    ping: () => request('GET', '/api/ping'),

    /**
     * The Blob for "assets/<file>", fetched once with the token and cached. The caller makes (and revokes)
     * the object URL, so a re-rendered chunk can get a fresh one without downloading again.
     */
    assetBlob(assetPath) {
      if (!assetBlobs.has(assetPath)) {
        const pending = (async () => {
          const res = await fetchImpl(`${base}/${assetPath}`, { headers: auth, cache: 'no-store' });
          if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`.trim());
          return res.blob();
        })();
        pending.catch(() => assetBlobs.delete(assetPath));
        assetBlobs.set(assetPath, pending);
      }
      return assetBlobs.get(assetPath);
    },
  };
}
