import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../src/security.js';

const guard = createGuard({ port: 4321, token: 'secret-token' });
const req = (headers = {}, method = 'GET') => ({ method, headers });

test('checkHost accepts only the exact loopback hosts with the bound port', () => {
  assert.equal(guard.checkHost(req({ host: '127.0.0.1:4321' })), null);
  assert.equal(guard.checkHost(req({ host: 'localhost:4321' })), null);
  for (const host of ['evil.com:4321', '127.0.0.1:9999', '127.0.0.1', '127.0.0.1:4321.evil.com', 'evil.com', '', undefined, '0.0.0.0:4321', '[::1]:4321']) {
    assert.equal(guard.checkHost(req({ host }))?.status, 403, `host ${host}`);
  }
});

test('checkToken requires the exact bearer token', () => {
  assert.equal(guard.checkToken(req({ authorization: 'Bearer secret-token' })), null);
  for (const authorization of [undefined, '', 'Bearer', 'Bearer wrong', 'Bearer secret-token2', 'Bearer secret-toke', 'secret-token', 'Basic secret-token', 'bearer secret-token']) {
    assert.equal(guard.checkToken(req({ authorization }))?.status, 401, `auth ${authorization}`);
  }
});

test('checkWrite refuses cross-origin and non-JSON writes', () => {
  const json = { 'content-type': 'application/json' };
  assert.equal(guard.checkWrite(req({ ...json, origin: 'http://127.0.0.1:4321' }, 'POST')), null);
  assert.equal(guard.checkWrite(req({ ...json, origin: 'http://localhost:4321' }, 'POST')), null);
  assert.equal(guard.checkWrite(req({ ...json }, 'POST')), null, 'no Origin (non-browser client) is allowed; the token still applies');
  assert.equal(guard.checkWrite(req({ 'content-type': 'application/json; charset=utf-8' }, 'PUT')), null);
  assert.equal(guard.checkWrite(req({ ...json, origin: 'http://evil.com' }, 'POST'))?.status, 403);
  assert.equal(guard.checkWrite(req({ ...json, origin: 'http://127.0.0.1:9999' }, 'POST'))?.status, 403);
  assert.equal(guard.checkWrite(req({ ...json, origin: 'null' }, 'POST'))?.status, 403);
  assert.equal(guard.checkWrite(req({ ...json, 'sec-fetch-site': 'cross-site' }, 'POST'))?.status, 403);
  assert.equal(guard.checkWrite(req({ ...json, 'sec-fetch-site': 'same-site' }, 'POST'))?.status, 403);
  assert.equal(guard.checkWrite(req({ ...json, 'sec-fetch-site': 'same-origin' }, 'POST')), null);
  assert.equal(guard.checkWrite(req({ 'content-type': 'text/plain' }, 'POST'))?.status, 415);
  assert.equal(guard.checkWrite(req({}, 'POST'))?.status, 415);
});

test('checkRead refuses cross-site fetches even when a token were known', () => {
  assert.equal(guard.checkRead(req({ 'sec-fetch-site': 'cross-site' }))?.status, 403);
  assert.equal(guard.checkRead(req({ origin: 'http://evil.com' }))?.status, 403);
  assert.equal(guard.checkRead(req({ 'sec-fetch-site': 'same-origin' })), null);
  assert.equal(guard.checkRead(req({})), null);
});
