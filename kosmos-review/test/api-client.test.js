import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../web/net/client.js';

const reply = (status, body, extra = {}) => ({ ok: status < 400, status, statusText: 'x', json: async () => body, blob: async () => ({ size: 3 }), ...extra });

test('sends the bearer token and JSON body, returns parsed JSON', async () => {
  const calls = [];
  const api = createApiClient({ token: 'tok', fetch: async (url, init) => { calls.push([url, init]); return reply(200, { ok: true }); } });
  assert.deepEqual(await api.saveDraft({ a: 1 }), { ok: true });
  const [url, init] = calls[0];
  assert.equal(url, '/api/draft');
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers.authorization, 'Bearer tok');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.body, '{"a":1}');
  await api.getState();
  assert.equal(calls[1][1].body, undefined);
  assert.equal(calls[1][1].headers['content-type'], undefined);
});

test('HTTP errors become ApiError with status and server message; network failure is status 0', async () => {
  const api = createApiClient({ token: 't', fetch: async () => reply(409, { error: 'changed', currentHash: 'h' }) });
  await assert.rejects(api.submit({}), (e) => e instanceof ApiError && e.status === 409 && e.message === 'changed' && e.body.currentHash === 'h');
  const down = createApiClient({ token: 't', fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.getState(), (e) => e.status === 0 && /cannot reach/.test(e.message));
});

test('assetBlob fetches once with the token, caches the blob, and forgets failures', async () => {
  let fail = true;
  const seen = [];
  const api = createApiClient({
    token: 'tok',
    fetch: async (url, init) => { seen.push([url, init.headers.authorization]); return fail ? reply(404, null) : reply(200, null); },
  });
  await assert.rejects(api.assetBlob('assets/a.png'), ApiError);
  fail = false;
  const blob = await api.assetBlob('assets/a.png');
  assert.equal(blob.size, 3);
  assert.equal(await api.assetBlob('assets/a.png'), blob);
  assert.deepEqual(seen, [['/assets/a.png', 'Bearer tok'], ['/assets/a.png', 'Bearer tok']]);
});

test('keepalive is decided on the byte length, not the character count', async () => {
  const calls = [];
  const api = createApiClient({ token: 't', fetch: async (url, init) => { calls.push(init.keepalive); return reply(200, {}); } });
  await api.saveDraft({ overall: 'x'.repeat(1000) });
  await api.saveDraft({ overall: '\u20ac'.repeat(30000) }); // 30000 chars, about 90000 bytes
  await api.saveDraft({ overall: 'x'.repeat(70000) });
  assert.deepEqual(calls, [true, false, false]);
});

test('ping calls the authenticated /api/ping endpoint, which is what counts as activity on the server', async () => {
  const calls = [];
  const api = createApiClient({ token: 'tok', fetch: async (url, init) => { calls.push([url, init]); return reply(200, { ok: true }); } });
  assert.deepEqual(await api.ping(), { ok: true });
  assert.equal(calls[0][0], '/api/ping');
  assert.equal(calls[0][1].headers.authorization, 'Bearer tok');
  assert.equal(calls[0][1].method, 'GET');
});

test('ping failures become ApiError (status 0 when the server is unreachable)', async () => {
  const down = createApiClient({ token: 't', fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.ping(), (e) => e instanceof ApiError && e.status === 0);
  const gone = createApiClient({ token: 't', fetch: async () => reply(401, { error: 'missing or invalid token' }) });
  await assert.rejects(gone.ping(), (e) => e.status === 401);
});
