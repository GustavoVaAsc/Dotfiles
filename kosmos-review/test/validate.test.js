import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, ValidationError, LIMITS } from '../src/validate.js';
import { validReview, comment, answer, HASH } from './helpers.js';

const bad = (body, msg) => assert.throws(() => parseReview(body), (e) => e instanceof ValidationError && (!msg || e.message.includes(msg)), JSON.stringify(body).slice(0, 80));

test('accepts an empty review', () => {
  const r = parseReview(validReview());
  assert.deepEqual(r, { docHash: HASH, overall: '', comments: [], answers: [] });
});

test('keeps a well-formed comment and answer, drops unknown keys', () => {
  const r = parseReview(validReview({
    extra: 1,
    overall: 'ok',
    comments: [{ ...comment(), evil: 'x' }],
    answers: [{ ...answer(), evil: 'x' }],
  }));
  assert.deepEqual(r.comments[0], comment());
  assert.deepEqual(r.answers[0], answer());
  assert.equal('extra' in r, false);
});

test('rejects non-objects and a bad docHash', () => {
  for (const b of [null, [], 'x', 5]) bad(b);
  bad(validReview({ docHash: 'nope' }), 'docHash');
  bad(validReview({ docHash: undefined }), 'docHash');
});

test('rejects malformed comments', () => {
  bad(validReview({ comments: 'x' }), 'comments');
  bad(validReview({ comments: [comment({ startLine: 5, endLine: 2 })] }), 'startLine');
  bad(validReview({ comments: [comment({ startLine: 0 })] }), 'startLine');
  bad(validReview({ comments: [comment({ startLine: 1.5 })] }), 'startLine');
  bad(validReview({ comments: [comment({ text: '   ' })] }), 'text');
  bad(validReview({ comments: [comment({ text: 'x'.repeat(LIMITS.commentText + 1) })] }), 'text');
  bad(validReview({ comments: [comment({ id: '../x' })] }), 'id');
  bad(validReview({ comments: [comment({ docHash: 'x' })] }), 'docHash');
  bad(validReview({ comments: [comment({ quote: 'x'.repeat(LIMITS.quote + 1) })] }), 'quote');
  bad(validReview({ comments: [comment(), comment()] }), 'duplicate');
  bad(validReview({ comments: Array.from({ length: LIMITS.comments + 1 }, (_, i) => comment({ id: 'c' + i })) }), 'comments');
});

test('rejects malformed answers', () => {
  bad(validReview({ answers: [answer({ type: 'radio' })] }), 'type');
  bad(validReview({ answers: [answer({ selected: [{ index: -1, label: 'A' }] })] }), 'index');
  bad(validReview({ answers: [answer({ selected: [{ index: 0 }] })] }), 'label');
  bad(validReview({ answers: [answer({ other: 5 })] }), 'other');
  bad(validReview({ answers: [answer({ text: 'x'.repeat(LIMITS.answerText + 1) })] }), 'text');
  bad(validReview({ answers: [answer(), answer()] }), 'duplicate');
  bad(validReview({ answers: [answer({ id: 'has space' })] }), 'id');
});

test('rejects an overlong overall comment', () => {
  bad(validReview({ overall: 'x'.repeat(LIMITS.overall + 1) }), 'overall');
});
