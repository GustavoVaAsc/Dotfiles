import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { openCommand, openBrowser } from '../src/opener.js';

// The browser is handed a file:// launcher in the private state directory, never a URL that carries a ticket or token.
const URL_ = 'file:///run/user/1000/kosmos-review/0123456789abcdef.open.html';
const yes = () => true;
const fakeSpawn = () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() { calls.at(-1).unref = true; } };
  };
  return { spawn, calls };
};

test('Linux with a display uses xdg-open; macOS uses open', () => {
  assert.deepEqual(openCommand({ platform: 'linux', env: { DISPLAY: ':0' }, exists: yes }), { command: '/usr/bin/xdg-open' });
  assert.deepEqual(openCommand({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, exists: yes }), { command: '/usr/bin/xdg-open' });
  assert.deepEqual(openCommand({ platform: 'darwin', env: {}, exists: yes }), { command: '/usr/bin/open' });
});

test('Linux without DISPLAY or WAYLAND_DISPLAY (SSH, headless) skips silently; unknown platforms are unsupported', () => {
  assert.deepEqual(openCommand({ platform: 'linux', env: {}, exists: yes }), { skip: 'no-display' });
  assert.deepEqual(openCommand({ platform: 'linux', env: { DISPLAY: '', WAYLAND_DISPLAY: '' }, exists: yes }), { skip: 'no-display' });
  assert.deepEqual(openCommand({ platform: 'win32', env: { DISPLAY: ':0' }, exists: yes }), { skip: 'unsupported-platform' });
});

test('opens detached, with the URL as one argv element and no shell', () => {
  const { spawn, calls } = fakeSpawn();
  const r = openBrowser(URL_, { expected: URL_, platform: 'linux', env: { DISPLAY: ':0' }, spawn, exists: yes });
  assert.deepEqual(r, { opened: true, reason: 'xdg-open' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/xdg-open', 'an absolute path, not looked up on PATH');
  assert.deepEqual(calls[0].args, [URL_]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.ok(!calls[0].options.shell, 'never through a shell');
  assert.equal(calls[0].unref, true, 'the CLI does not wait for the browser');
});

test('does not spawn at all without a display', () => {
  const { spawn, calls } = fakeSpawn();
  assert.deepEqual(openBrowser(URL_, { expected: URL_, platform: 'linux', env: {}, spawn, exists: yes }), { opened: false, reason: 'no-display' });
  assert.equal(calls.length, 0);
});

test('refuses anything that is not our loopback URL (no argv option injection, no foreign hosts)', () => {
  for (const bad of ['http://127.0.0.1:43949/#ticket=abcDEF123_-xyzabcDEF123_-xyz', 'http://127.0.0.1:43949/#token=abcDEF123_-xyzabcDEF123_-xyz', 'file:///etc/passwd', 'file:///tmp/x/0123456789abcdef.open.html?x=1', 'file:///tmp/x/0123456789abcdef.open.html#y', 'file:///tmp/x/../0123456789abcdef.open.html', 'file://host/tmp/0123456789abcdef.open.html', 'file:///tmp/a b/0123456789abcdef.open.html\n', '--help', '-n http://127.0.0.1:1/', 'http://evil.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1:1/ --new-window', '']) {
    const { spawn, calls } = fakeSpawn();
    assert.deepEqual(openBrowser(bad, { expected: URL_, platform: 'linux', env: { DISPLAY: ':0' }, spawn, exists: yes }), { opened: false, reason: 'bad-url' }, JSON.stringify(bad));
    assert.equal(calls.length, 0);
  }
});

test('a spawn that throws or errors asynchronously never throws out of openBrowser', async () => {
  const thrower = () => { throw new Error('ENOENT'); };
  assert.deepEqual(openBrowser(URL_, { expected: URL_, platform: 'linux', env: { DISPLAY: ':0' }, spawn: thrower, exists: yes }), { opened: false, reason: 'spawn-failed' });
  let onError;
  const spawn = () => ({ on(ev, fn) { if (ev === 'error') onError = fn; }, unref() {} });
  assert.equal(openBrowser(URL_, { expected: URL_, platform: 'linux', env: { DISPLAY: ':0' }, spawn, exists: yes }).opened, true);
  assert.doesNotThrow(() => onError(new Error('xdg-open not found')), 'an async spawn error is swallowed');
});

test('the opener never receives a token or a ticket: only the launcher file URL is accepted', () => {
  const { spawn, calls } = fakeSpawn();
  const r = openBrowser('http://127.0.0.1:43949/#token=SECRETSECRETSECRETSECRET', { expected: URL_, platform: 'linux', env: { DISPLAY: ':0' }, spawn, exists: yes });
  assert.deepEqual(r, { opened: false, reason: 'bad-url' });
  assert.equal(calls.length, 0);
});

test('a missing opener binary is reported instead of searching PATH', () => {
  const { spawn, calls } = fakeSpawn();
  assert.deepEqual(openBrowser(URL_, { expected: URL_, platform: 'linux', env: { DISPLAY: ':0' }, spawn, exists: () => false }), { opened: false, reason: 'opener-missing' });
  assert.equal(calls.length, 0);
});

// ---- fix round 3 ----

test('a state directory with @ = , ( ) or other legal path characters is accepted: the URL is checked against the exact expected one, not a character class', () => {
  for (const dir of ['/run/user/1000/kosmos@host', '/home/u/a=b,c/(x)', "/home/u/it's here/ü 日本", '/tmp/x+y~z/a b', '/tmp/100%/sure']) {
    const expected = pathToFileURL(`${dir}/0123456789abcdef.open.html`).href;
    const { spawn, calls } = fakeSpawn();
    assert.deepEqual(openBrowser(expected, { expected, platform: 'linux', env: { DISPLAY: ':0' }, spawn, exists: yes }), { opened: true, reason: 'xdg-open' }, dir);
    assert.deepEqual(calls[0].args, [expected]);
  }
});

test('only the exact expected URL is opened: anything different, or no expectation at all, is refused', () => {
  const expected = pathToFileURL('/run/user/1000/kosmos@x/0123456789abcdef.open.html').href;
  const attempt = (url, exp) => { const { spawn, calls } = fakeSpawn(); const r = openBrowser(url, { expected: exp, platform: 'linux', env: { DISPLAY: ':0' }, spawn, exists: yes }); return [r, calls.length]; };
  assert.deepEqual(attempt(expected + '?x=1', expected), [{ opened: false, reason: 'bad-url' }, 0]);
  assert.deepEqual(attempt(expected.replace('kosmos@x', 'kosmos@y'), expected), [{ opened: false, reason: 'bad-url' }, 0]);
  assert.deepEqual(attempt(expected, undefined), [{ opened: false, reason: 'bad-url' }, 0], 'no expectation, no opening');
  assert.deepEqual(attempt('--help', '--help'), [{ opened: false, reason: 'bad-url' }, 0], 'an expectation that is not a file URL is refused too');
  assert.deepEqual(attempt('http://127.0.0.1:1/#ticket=abcDEF123_-xyzabcDEF123_-xyz', 'http://127.0.0.1:1/#ticket=abcDEF123_-xyzabcDEF123_-xyz'), [{ opened: false, reason: 'bad-url' }, 0], 'nor a ticket URL');
});
