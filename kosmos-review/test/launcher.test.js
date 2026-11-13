import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeLauncher, removeLauncher } from '../src/launcher.js';
import { tmpDir } from './helpers.js';

const TICKET_URL = 'http://127.0.0.1:43949/#ticket=abcDEF123_-xyzabcDEF123_-xyz';

test('writes a private launcher page that redirects to the ticket URL and returns its file:// URL', async () => {
  const t = await tmpDir();
  try {
    const { file, url } = await writeLauncher(t.dir, '0123456789abcdef', TICKET_URL);
    assert.equal(file, path.join(t.dir, '0123456789abcdef.open.html'));
    assert.equal(url, `file://${file}`);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'only the owner can read the ticket');
    const html = await fs.readFile(file, 'utf8');
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0;url=${TICKET_URL}">`));
    assert.ok(html.includes(`href="${TICKET_URL}"`), 'with a plain link as the fallback');
  } finally { await t.cleanup(); }
});

test('only our own loopback ticket URL can be written into the launcher (no HTML injection, no other targets)', async () => {
  const t = await tmpDir();
  try {
    for (const bad of ['http://evil.example/', 'javascript:alert(1)', `${TICKET_URL}"><script>x</script>`, 'http://127.0.0.1:1/#token=abcDEF123_-xyzabcDEF123_-xyz', '']) {
      await assert.rejects(writeLauncher(t.dir, '0123456789abcdef', bad), /ticket URL/, JSON.stringify(bad));
    }
    assert.deepEqual(await fs.readdir(t.dir), []);
  } finally { await t.cleanup(); }
});

test('writing again replaces the file, never follows a symlink planted at its name, and the id is validated', async () => {
  const t = await tmpDir();
  const outside = await tmpDir();
  try {
    const victim = path.join(outside.dir, 'victim');
    await fs.writeFile(victim, 'untouched');
    await fs.symlink(victim, path.join(t.dir, '0123456789abcdef.open.html'));
    await writeLauncher(t.dir, '0123456789abcdef', TICKET_URL);
    assert.equal(await fs.readFile(victim, 'utf8'), 'untouched');
    assert.ok((await fs.readFile(path.join(t.dir, '0123456789abcdef.open.html'), 'utf8')).includes('refresh'));
    await assert.rejects(writeLauncher(t.dir, '../x', TICKET_URL));
  } finally { await t.cleanup(); await outside.cleanup(); }
});

test('removeLauncher deletes it and tolerates it being gone', async () => {
  const t = await tmpDir();
  try {
    const { file } = await writeLauncher(t.dir, '0123456789abcdef', TICKET_URL);
    await removeLauncher(t.dir, '0123456789abcdef');
    await assert.rejects(fs.stat(file));
    await removeLauncher(t.dir, '0123456789abcdef');
  } finally { await t.cleanup(); }
});
