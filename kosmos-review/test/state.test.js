import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from '../web/state/reducer.js';
import { buildReview, restoreAnswers, answeredCount, isAnswered } from '../web/state/payload.js';
import { createAutosaver } from '../web/state/autosave.js';
import { initSession, takeTicket, exchangeTicket } from '../web/net/session.js';

const HASH = 'sha256:' + 'b'.repeat(64);
const NOW = '2026-01-02T03:04:05.000Z';
const QUESTIONS = [
  { id: 'q1', type: 'single', prompt: 'P1', options: ['A', 'B'] },
  { id: 'q2', type: 'multi', prompt: 'P2', options: ['X', 'Y', 'Z'] },
  { id: 'q3', type: 'text', prompt: 'P3', options: [] },
];

test('reducer: composer opens, extends to the outer range, and closes', () => {
  let s = reducer(initialState, { type: 'openComposer', startLine: 5, endLine: 6, quote: 'q' });
  assert.deepEqual(s.composer, { id: null, startLine: 5, endLine: 6, quote: 'q', text: '' });
  s = reducer(s, { type: 'extendComposer', startLine: 2, endLine: 3, quote: 'q2' });
  assert.deepEqual([s.composer.startLine, s.composer.endLine, s.composer.quote], [2, 6, 'q2']);
  s = reducer(s, { type: 'closeComposer' });
  assert.equal(s.composer, null);
});

test('reducer: extendComposer without an open composer opens one; it never extends an edit', () => {
  let s = reducer(initialState, { type: 'extendComposer', startLine: 2, endLine: 3, quote: 'q' });
  assert.equal(s.composer.startLine, 2);
  s = reducer(initialState, { type: 'openComposer', startLine: 1, endLine: 1, quote: 'q' });
  s = reducer(s, { type: 'saveComment', text: 'hi', docHash: HASH, now: NOW });
  s = reducer(s, { type: 'editComment', id: s.comments[0].id });
  const range = [s.composer.startLine, s.composer.endLine];
  s = reducer(s, { type: 'extendComposer', startLine: 9, endLine: 9, quote: 'z' });
  assert.deepEqual([s.composer.startLine, s.composer.endLine], range);
});

test('reducer: saving a comment stores range, quote, hash and marks the draft dirty', () => {
  let s = reducer(initialState, { type: 'openComposer', startLine: 3, endLine: 4, quote: 'quoted' });
  s = reducer(s, { type: 'saveComment', text: '  fix this  ', docHash: HASH, now: NOW });
  assert.equal(s.composer, null);
  assert.equal(s.dirty, true);
  assert.deepEqual(s.comments, [{ id: 'c1', startLine: 3, endLine: 4, quote: 'quoted', docHash: HASH, text: 'fix this', createdAt: NOW }]);
});

test('reducer: empty comment text is not saved', () => {
  let s = reducer(initialState, { type: 'openComposer', startLine: 1, endLine: 1, quote: 'q' });
  s = reducer(s, { type: 'saveComment', text: '   ', docHash: HASH, now: NOW });
  assert.deepEqual(s.comments, []);
  assert.ok(s.composer, 'composer stays open');
});

test('reducer: comment ids never collide after deletes; edit keeps range and updates text', () => {
  let s = initialState;
  for (const t of ['a', 'b', 'c']) {
    s = reducer(s, { type: 'openComposer', startLine: 1, endLine: 1, quote: 'q' });
    s = reducer(s, { type: 'saveComment', text: t, docHash: HASH, now: NOW });
  }
  s = reducer(s, { type: 'deleteComment', id: 'c2' });
  s = reducer(s, { type: 'openComposer', startLine: 2, endLine: 2, quote: 'q' });
  s = reducer(s, { type: 'saveComment', text: 'd', docHash: HASH, now: NOW });
  assert.deepEqual(s.comments.map((c) => c.id), ['c1', 'c3', 'c4']);
  s = reducer(s, { type: 'editComment', id: 'c3' });
  assert.equal(s.composer.text, 'c');
  s = reducer(s, { type: 'saveComment', text: 'c edited', docHash: HASH, now: NOW });
  assert.equal(s.comments.find((c) => c.id === 'c3').text, 'c edited');
  assert.equal(s.comments.length, 3);
});

test('reducer: answers merge patches; overall is stored', () => {
  let s = reducer(initialState, { type: 'setAnswer', id: 'q1', patch: { selected: [1] } });
  s = reducer(s, { type: 'setAnswer', id: 'q1', patch: { other: 'x' } });
  assert.deepEqual(s.answers.q1, { selected: [1], other: 'x', text: '' });
  s = reducer(s, { type: 'setOverall', text: 'all good' });
  assert.equal(s.overall, 'all good');
  assert.equal(s.dirty, true);
});

test('reducer: restore loads a draft without marking it dirty; reset clears everything', () => {
  let s = reducer(initialState, { type: 'restore', comments: [{ id: 'c7' }], answers: { q1: { selected: [0], other: '', text: '' } }, overall: 'o' });
  assert.equal(s.dirty, false);
  assert.equal(s.comments.length, 1);
  s = reducer(s, { type: 'openComposer', startLine: 1, endLine: 1, quote: 'q' });
  s = reducer(s, { type: 'saveComment', text: 'next', docHash: HASH, now: NOW });
  assert.equal(s.comments[1].id, 'c8', 'ids continue after restored ones');
  s = reducer(s, { type: 'reset' });
  assert.deepEqual(s, initialState);
});

test('payload: builds one answer per question, including unanswered ones, with labels', () => {
  const state = { ...initialState, overall: 'ov', comments: [], answers: { q1: { selected: [1], other: '', text: '' }, q2: { selected: [2, 0], other: 'mine', text: '' } } };
  const review = buildReview(state, QUESTIONS, HASH);
  assert.equal(review.docHash, HASH);
  assert.equal(review.overall, 'ov');
  assert.deepEqual(review.answers.map((a) => a.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(review.answers[0], { id: 'q1', type: 'single', prompt: 'P1', selected: [{ index: 1, label: 'B' }], other: '', text: '' });
  assert.deepEqual(review.answers[1].selected, [{ index: 0, label: 'X' }, { index: 2, label: 'Z' }], 'sorted by index');
  assert.deepEqual(review.answers[2].selected, []);
});

test('payload: restoreAnswers matches by label so reordered or removed options are handled', () => {
  const wire = [
    { id: 'q1', type: 'single', prompt: 'P1', selected: [{ index: 0, label: 'B' }], other: '', text: '' },
    { id: 'q2', type: 'multi', prompt: 'P2', selected: [{ index: 0, label: 'X' }, { index: 1, label: 'GONE' }], other: 'o', text: '' },
    { id: 'q3', type: 'text', prompt: 'P3', selected: [], other: '', text: 'free' },
    { id: 'old', type: 'text', prompt: 'removed question', selected: [], other: '', text: 'x' },
  ];
  const answers = restoreAnswers(wire, QUESTIONS);
  assert.deepEqual(answers.q1, { selected: [1], other: '', text: '' });
  assert.deepEqual(answers.q2, { selected: [0], other: 'o', text: '' });
  assert.deepEqual(answers.q3, { selected: [], other: '', text: 'free' });
  assert.equal('old' in answers, false);
});

test('payload: answered detection and count', () => {
  assert.equal(isAnswered(QUESTIONS[0], { selected: [0], other: '', text: '' }), true);
  assert.equal(isAnswered(QUESTIONS[0], { selected: [], other: ' ', text: '' }), false);
  assert.equal(isAnswered(QUESTIONS[1], { selected: [], other: 'x', text: '' }), true);
  assert.equal(isAnswered(QUESTIONS[2], { selected: [], other: '', text: 'x' }), true);
  assert.equal(isAnswered(QUESTIONS[2], undefined), false);
  assert.equal(answeredCount(QUESTIONS, { q3: { selected: [], other: '', text: 'x' } }), 1);
});

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    set: (fn, ms) => { pending.set(++n, { fn, ms }); return n; },
    clear: (id) => pending.delete(id),
    fire: () => { const [[id, t]] = [...pending]; pending.delete(id); return t.fn(); },
    count: () => pending.size,
  };
}

test('autosave: debounces to the latest payload', async () => {
  const timers = fakeTimers();
  const saved = [];
  const a = createAutosaver({ save: async (p) => { saved.push(p); }, delay: 500, setTimer: timers.set, clearTimer: timers.clear });
  a.schedule({ v: 1 }); a.schedule({ v: 2 }); a.schedule({ v: 3 });
  assert.equal(timers.count(), 1);
  await timers.fire();
  assert.deepEqual(saved, [{ v: 3 }]);
});

test('autosave: a change during an in-flight save is saved afterwards, never concurrently', async () => {
  const timers = fakeTimers();
  const saved = []; let active = 0; let maxActive = 0; let release;
  const a = createAutosaver({
    save: async (p) => { active++; maxActive = Math.max(maxActive, active); saved.push(p); await new Promise((r) => { release = r; }); active--; },
    delay: 10, setTimer: timers.set, clearTimer: timers.clear,
  });
  a.schedule({ v: 1 });
  const first = timers.fire();
  a.schedule({ v: 2 });
  const second = timers.fire();
  release();
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([first, second]);
  await a.idle();
  assert.deepEqual(saved, [{ v: 1 }, { v: 2 }]);
  assert.equal(maxActive, 1);
});

test('autosave: reports status and keeps the latest payload after a failure; flush saves now; cancel drops', async () => {
  const timers = fakeTimers();
  const states = []; let fail = true; const saved = [];
  const a = createAutosaver({
    save: async (p) => { if (fail) throw new Error('boom'); saved.push(p); },
    delay: 10, setTimer: timers.set, clearTimer: timers.clear, onStatus: (s) => states.push(s),
  });
  a.schedule({ v: 1 });
  await timers.fire();
  assert.deepEqual(states, ['saving', 'error']);
  fail = false;
  await a.flush();
  assert.deepEqual(saved, [{ v: 1 }], 'a failed payload is retried on flush');
  assert.equal(states.at(-1), 'saved');
  a.schedule({ v: 2 });
  a.cancel();
  assert.equal(timers.count(), 0);
  await a.flush();
  assert.deepEqual(saved, [{ v: 1 }]);
});

test('session: reads the token from the URL fragment, stores it, and strips it from the address bar', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const calls = [];
  const loc = { hash: '#token=abc_DEF-123', pathname: '/', search: '' };
  const history = { replaceState: (...a) => calls.push(a) };
  assert.equal(initSession({ location: loc, history, storage }), 'abc_DEF-123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], '/');
  assert.equal(initSession({ location: { hash: '', pathname: '/', search: '' }, history, storage }), 'abc_DEF-123', 'survives a reload via sessionStorage');
});

test('session: no token anywhere returns null; a malformed fragment is ignored', () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('should not store'); } };
  const history = { replaceState: () => {} };
  assert.equal(initSession({ location: { hash: '', pathname: '/', search: '' }, history, storage }), null);
  assert.equal(initSession({ location: { hash: '#token=<script>', pathname: '/', search: '' }, history, storage }), null);
});

// ---- fix round 1 (found by the headless-browser smoke test) ----

test('reducer: an answer patch may be a function of the previous answer, so two clicks in one tick both count', () => {
  const toggle = (i) => (prev) => ({ selected: [...prev.selected, i] });
  let s = reducer(initialState, { type: 'setAnswer', id: 'q2', patch: toggle(0) });
  s = reducer(s, { type: 'setAnswer', id: 'q2', patch: toggle(2) });
  assert.deepEqual(s.answers.q2.selected, [0, 2]);
});

// ---- fix round 1 (ticket bootstrap) ----

test('takeTicket reads #ticket=, removes it from the address bar at once, and ignores malformed values', () => {
  const calls = [];
  const history = { replaceState: (...a) => calls.push(a) };
  assert.equal(takeTicket({ location: { hash: '#ticket=abcDEF123_-abcDEF123_-abcDEF123', pathname: '/', search: '' }, history }), 'abcDEF123_-abcDEF123_-abcDEF123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], '/');
  assert.equal(takeTicket({ location: { hash: '#ticket=<script>', pathname: '/', search: '' }, history }), null);
  assert.equal(takeTicket({ location: { hash: '#token=abcDEF123_-', pathname: '/', search: '' }, history }), null);
  assert.equal(takeTicket({ location: { hash: '', pathname: '/', search: '' }, history }), null);
});

test('exchangeTicket posts the ticket as JSON, stores the token for reloads, and returns null on any failure', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const seen = [];
  const ok = async (url, init) => { seen.push([url, init]); return { ok: true, json: async () => ({ token: 'tok_abcdef123456' }) }; };
  assert.equal(await exchangeTicket('t'.repeat(40), { fetch: ok, storage }), 'tok_abcdef123456');
  assert.equal(seen[0][0], '/api/session');
  assert.equal(seen[0][1].method, 'POST');
  assert.equal(seen[0][1].headers['content-type'], 'application/json');
  assert.equal(JSON.parse(seen[0][1].body).ticket, 't'.repeat(40));
  assert.equal(store.get('kosmos-review-token'), 'tok_abcdef123456');
  assert.equal(await exchangeTicket('x', { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }), storage }), null);
  assert.equal(await exchangeTicket('x', { fetch: async () => { throw new Error('down'); }, storage }), null);
  assert.equal(await exchangeTicket('x', { fetch: async () => ({ ok: true, json: async () => ({ token: '<bad>' }) }), storage }), null);
});
