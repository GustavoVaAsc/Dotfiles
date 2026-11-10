import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFor, mergeRanges, rangesOverlap } from '../web/lib/anchors.js';

const DOC = '# Title\n\nFirst   paragraph\nwraps here.\n\n- item one\n- item two\n';

test('quoteFor collapses whitespace over the line range', () => {
  assert.equal(quoteFor(DOC, 3, 4), 'First paragraph wraps here.');
  assert.equal(quoteFor(DOC, 1, 1), '# Title');
});

test('quoteFor truncates long text with an ellipsis and handles CRLF and out-of-range lines', () => {
  assert.equal(quoteFor('x'.repeat(500), 1, 1, 20), 'x'.repeat(19) + '…');
  assert.equal(quoteFor('a\r\nb\r\nc', 1, 2), 'a b');
  assert.equal(quoteFor('a\nb', 5, 9), '');
});

test('mergeRanges takes the outer bounds', () => {
  assert.deepEqual(mergeRanges({ startLine: 5, endLine: 6 }, { startLine: 2, endLine: 3 }), { startLine: 2, endLine: 6 });
});

test('rangesOverlap is inclusive', () => {
  assert.equal(rangesOverlap({ startLine: 1, endLine: 3 }, { startLine: 3, endLine: 4 }), true);
  assert.equal(rangesOverlap({ startLine: 1, endLine: 2 }, { startLine: 3, endLine: 4 }), false);
});
