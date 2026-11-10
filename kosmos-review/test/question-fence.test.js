import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestion } from '../web/lib/question-fence.js';

const ok = (body) => {
  const r = parseQuestion(body, { firstLine: 10 });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.question;
};
const fails = (body, ...needles) => {
  const r = parseQuestion(body, { firstLine: 10 });
  assert.equal(r.ok, false, 'expected a parse failure');
  const text = r.errors.map((e) => `${e.line}: ${e.message}`).join('\n');
  for (const n of needles) assert.ok(text.includes(n), `"${n}" not in:\n${text}`);
  return r.errors;
};

test('single choice with a list of options', () => {
  const q = ok('id: auth\ntype: single\nprompt: Which auth?\noptions:\n  - JWT\n  - Sessions\n  - OAuth: only\n');
  assert.deepEqual(q, { id: 'auth', type: 'single', prompt: 'Which auth?', options: ['JWT', 'Sessions', 'OAuth: only'] });
});

test('multi choice; options may start at column 0; comments and blank lines are skipped', () => {
  const q = ok('# why\nid: m1\n\ntype: multi\nprompt: Pick any\noptions:\n- a\n# skipped\n- b\n');
  assert.deepEqual(q.options, ['a', 'b']);
  assert.equal(q.type, 'multi');
});

test('text question has no options', () => {
  assert.deepEqual(ok('id: t.1\ntype: text\nprompt: Why?'), { id: 't.1', type: 'text', prompt: 'Why?', options: [] });
});

test('plain scalars keep # and : inside the value; quoted scalars use JSON/YAML escapes', () => {
  const q = ok('id: x\ntype: single\nprompt: Issue #42: fix now?\noptions:\n  - "Yes, \\"now\\""\n  - \'It\'\'s fine\'\n');
  assert.equal(q.prompt, 'Issue #42: fix now?');
  assert.deepEqual(q.options, ['Yes, "now"', "It's fine"]);
});

test('a prompt can continue on indented lines (folded with a space)', () => {
  const q = ok('id: x\ntype: text\nprompt: First part\n  second part\n');
  assert.equal(q.prompt, 'First part second part');
});

test('CRLF line endings are accepted', () => {
  assert.equal(ok('id: x\r\ntype: text\r\nprompt: Hi\r\n').prompt, 'Hi');
});

test('JSON bodies are accepted and validated the same way', () => {
  const q = ok('{"id":"j1","type":"multi","prompt":"P","options":["a","b"]}');
  assert.deepEqual(q, { id: 'j1', type: 'multi', prompt: 'P', options: ['a', 'b'] });
  fails('{"id":"j1","type":"multi","prompt":"P","options":["a"]}', 'at least 2');
  fails('{"id": 5, "type":"text","prompt":"P"}', 'id');
  fails('{not json', 'JSON');
  fails('[1,2]', 'object');
});

test('missing required fields are reported with the fence line', () => {
  const errs = fails('type: text\nprompt: Hi', 'id');
  assert.ok(errs.every((e) => Number.isInteger(e.line) && e.line >= 9));
  fails('id: x\nprompt: Hi', 'type');
  fails('id: x\ntype: text', 'prompt');
  fails('', 'id');
});

test('bad type and bad id', () => {
  const errs = fails('id: x\ntype: radio\nprompt: Hi', 'type');
  assert.equal(errs[0].line, 11, 'points at the type line');
  fails('id: has space\ntype: text\nprompt: Hi', 'id');
  fails('id: ../x\ntype: text\nprompt: Hi', 'id');
  fails(`id: ${'a'.repeat(65)}\ntype: text\nprompt: Hi`, 'id');
});

test('options rules', () => {
  fails('id: x\ntype: single\nprompt: P', 'options');
  fails('id: x\ntype: single\nprompt: P\noptions:\n  - only', 'at least 2');
  fails('id: x\ntype: single\nprompt: P\noptions:\n  - a\n  - a', 'duplicate');
  fails('id: x\ntype: single\nprompt: P\noptions:\n  - a\n  - ', 'empty');
  fails('id: x\ntype: text\nprompt: P\noptions:\n  - a\n  - b', 'options');
  fails('id: x\ntype: single\nprompt: P\noptions: a, b', 'list');
  fails(`id: x\ntype: multi\nprompt: P\noptions:\n${Array.from({ length: 31 }, (_, i) => `  - o${i}`).join('\n')}`, 'at most');
});

test('strictness: unknown keys, duplicate keys, stray lines, bad quoting', () => {
  fails('id: x\ntype: text\nprompt: P\nrequired: true', 'unknown key');
  fails('id: x\nid: y\ntype: text\nprompt: P', 'duplicate key');
  fails('id: x\ntype: text\nprompt: P\nthis is not a pair', 'expected');
  fails('id: x\ntype: single\nprompt: P\noptions:\n  - "unterminated\n  - b', 'quote');
  fails('id: x\ntype: text\nprompt: "also bad', 'quote');
  fails('  indented first\nid: x\ntype: text\nprompt: P', 'indent');
});

test('reports every problem, not only the first', () => {
  const errs = fails('type: radio\nbogus: 1', 'unknown key', 'type', 'id', 'prompt');
  assert.ok(errs.length >= 4);
});

test('limits: prompt and option length', () => {
  fails(`id: x\ntype: text\nprompt: ${'p'.repeat(2001)}`, 'prompt');
  fails(`id: x\ntype: single\nprompt: P\noptions:\n  - ${'o'.repeat(301)}\n  - b`, 'option');
});
