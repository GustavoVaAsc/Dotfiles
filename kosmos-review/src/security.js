// Request guards: Host allow-list (DNS rebinding), bearer token, cross-origin refusal.
import crypto from 'node:crypto';

const deny = (status, error) => ({ status, error });

export function createGuard({ port, token }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const tokenBuf = Buffer.from(String(token));

  const sameSiteOk = (headers) => {
    const site = headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  };

  return {
    /** Null when the Host header is one of our loopback names with our port. */
    checkHost(req) {
      const host = req.headers.host;
      return typeof host === 'string' && hosts.has(host.toLowerCase()) ? null : deny(403, 'forbidden host');
    },

    /** Null when "Authorization: Bearer <token>" matches in constant time. */
    checkToken(req) {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return deny(401, 'missing or invalid token');
      const given = Buffer.from(header.slice('Bearer '.length));
      const ok = given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
      return ok ? null : deny(401, 'missing or invalid token');
    },

    /** Reads: refuse anything the browser marks as coming from another site. */
    checkRead(req) {
      const { origin } = req.headers;
      if (origin !== undefined && !origins.has(origin)) return deny(403, 'cross-origin request refused');
      return sameSiteOk(req.headers) ? null : deny(403, 'cross-site request refused');
    },

    /** Writes: same as reads, plus a JSON content type (forces a CORS preflight, which we never grant). */
    checkWrite(req) {
      const refused = this.checkRead(req);
      if (refused) return refused;
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      return type === 'application/json' ? null : deny(415, 'content-type must be application/json');
    },
  };
}
