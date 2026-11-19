// Exercises the pure logic and event wiring of pi/agent/extensions/thinking-hint.ts. Skipped when the extension or
// Node's TypeScript support is not available. Only `import type` is used by the extension, so no Pi install is needed.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(HERE, '../../pi/agent/extensions/thinking-hint.ts');
const skip = !fs.existsSync(EXTENSION) ? 'extension not present' : !process.features.typescript ? 'Node without TypeScript support' : false;
const load = () => import(pathToFileURL(EXTENSION).href);

test('sanitize strips escapes, control characters and newlines', { skip }, async () => {
  const { sanitize } = await load();
  assert.equal(sanitize('a\x1b[31mred\x1b[0m b'), 'a' + 'red b');
  assert.equal(sanitize('x\x1b]0;evil title\x07y'), 'xy');
  assert.equal(sanitize('x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\'), 'xlink');
  assert.equal(sanitize('a\r\nb\tc\x00d\x7fe\x9b~f'), 'a b c d ef');
  // Bidi and invisible format characters cannot reorder or hide label text.
  assert.equal(sanitize('a\u202Eb\u200Bc\u2066d\u2069e\u061Cf\u2060g\uFEFFh'), 'a b c d e f g h');
  assert.equal(sanitize('x\u200Dy'), 'x y');
});

test('lastLine picks the last non-empty line and tail truncates with an ellipsis', { skip }, async () => {
  const { lastLine, tail, formatLabel } = await load();
  assert.equal(lastLine('one\ntwo\n  \n\x1b[0m\n'), 'two');
  assert.equal(tail('short'), 'short');
  const t = tail('x'.repeat(100), 60);
  assert.equal(Array.from(t).length, 60);
  assert.ok(t.startsWith('…'));
  assert.equal(formatLabel(12999, 'a\nb'), 'Thinking · 12s · b');
  assert.equal(formatLabel(0, ''), 'Thinking · 0s');
});

test('label is throttled, then restored to the default when the message ends', { skip }, async () => {
  const { default: ext } = await load();
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const handlers = {};
    ext({ on: (n, h) => { handlers[n] = h; } });
    const labels = [];
    const ctx = { mode: 'tui', ui: { setHiddenThinkingLabel: (l) => labels.push(l) } };
    const upd = (assistantMessageEvent) => handlers.message_update({ assistantMessageEvent }, ctx);
    await upd({ type: 'thinking_start' });
    for (let i = 0; i < 50; i += 1) await upd({ type: 'thinking_delta', delta: `tok${i} ` });
    assert.deepEqual(labels, ['Thinking · 0s']);
    mock.timers.tick(1000);
    assert.equal(labels.length, 2); // 4 ticks, one changed label
    assert.match(labels[1], /^Thinking · 1s · …tok40 .*tok49$/);
    await handlers.message_end({}, ctx);
    assert.equal(labels.at(-1), undefined);
    const n = labels.length;
    mock.timers.tick(1000);
    assert.equal(labels.length, n);
  } finally { mock.timers.reset(); }
});

test('does nothing outside the TUI', { skip }, async () => {
  const { default: ext } = await load();
  const handlers = {};
  ext({ on: (n, h) => { handlers[n] = h; } });
  const ctx = { mode: 'print', ui: { setHiddenThinkingLabel: () => assert.fail('called') } };
  await handlers.message_update({ assistantMessageEvent: { type: 'thinking_start' } }, ctx);
  await handlers.message_end({}, ctx);
});
