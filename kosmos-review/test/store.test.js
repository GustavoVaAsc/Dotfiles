import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { PathError } from '../src/paths.js';
import { parseReview } from '../src/validate.js';
import { tmpProject, tmpDir, validReview, comment, answer, SAMPLE_DOC } from './helpers.js';

const open = async (opts) => {
  const p = await tmpProject(opts);
  const store = createStore({ reviewDir: p.reviewDir, projectRoot: p.root, slug: p.slug, relReviewDir: 'docs/reviews/' + p.slug });
  await store.pin();
  return { p, store };
};
const ls = async (dir) => (await fs.readdir(dir)).sort();

test('readDoc returns the text and the sha256 of the bytes', async () => {
  const { p, store } = await open();
  try {
    const doc = await store.readDoc();
    assert.equal(doc.text, SAMPLE_DOC);
    assert.equal(doc.hash, 'sha256:' + crypto.createHash('sha256').update(SAMPLE_DOC).digest('hex'));
  } finally { await p.cleanup(); }
});

test('first submit writes round-1.json; the next writes round-2.json', async () => {
  const { p, store } = await open();
  try {
    const doc = await store.readDoc();
    const r1 = await store.submit(validReview({ docHash: doc.hash, overall: 'first' }));
    assert.equal(r1.round, 1);
    assert.equal(r1.file, 'docs/reviews/demo/round-1.json');
    const r2 = await store.submit(validReview({ docHash: doc.hash, overall: 'second' }));
    assert.equal(r2.round, 2);
    assert.deepEqual((await ls(p.reviewDir)).filter((n) => n.startsWith('round-')), ['round-1.json', 'round-2.json']);
    const saved = JSON.parse(await fs.readFile(path.join(p.reviewDir, 'round-1.json'), 'utf8'));
    assert.equal(saved.overall, 'first');
  } finally { await p.cleanup(); }
});

test('submit never overwrites an existing round file', async () => {
  const { p, store } = await open();
  try {
    await fs.writeFile(path.join(p.reviewDir, 'round-1.json'), '{"planted":true}');
    await fs.writeFile(path.join(p.reviewDir, 'round-3.json'), '{"planted":true}');
    const r = await store.submit(validReview());
    assert.equal(r.round, 4, 'numbering continues after the highest existing round');
    assert.equal(await fs.readFile(path.join(p.reviewDir, 'round-1.json'), 'utf8'), '{"planted":true}');
    assert.equal(await fs.readFile(path.join(p.reviewDir, 'round-3.json'), 'utf8'), '{"planted":true}');
  } finally { await p.cleanup(); }
});

test('concurrent submits get distinct rounds and none is lost', async () => {
  const { p, store } = await open();
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.submit(validReview({ overall: 'n' + i }))));
    assert.deepEqual(results.map((r) => r.round).sort(), [1, 2, 3, 4, 5, 6]);
    const overalls = new Set();
    for (const r of results) overalls.add(JSON.parse(await fs.readFile(path.join(p.reviewDir, `round-${r.round}.json`), 'utf8')).overall);
    assert.equal(overalls.size, 6);
  } finally { await p.cleanup(); }
});

test('round file has the documented schema and server-computed answered flags', async () => {
  const { p, store } = await open();
  try {
    const doc = await store.readDoc();
    await store.submit(validReview({
      docHash: doc.hash,
      comments: [comment({ docHash: doc.hash })],
      answers: [
        answer({ id: 'q1' }),
        answer({ id: 'q2', type: 'single', selected: [] }),
        answer({ id: 'q3', type: 'multi', selected: [], other: 'mine' }),
        answer({ id: 'q4', type: 'text', selected: [], text: 'free' }),
        answer({ id: 'q5', type: 'text', selected: [], text: '  ' }),
      ],
    }));
    const saved = JSON.parse(await fs.readFile(path.join(p.reviewDir, 'round-1.json'), 'utf8'));
    assert.equal(saved.schema, 1);
    assert.equal(saved.round, 1);
    assert.equal(saved.slug, 'demo');
    assert.equal(saved.docFile, 'docs/reviews/demo/doc.md');
    assert.equal(saved.docHash, doc.hash);
    assert.match(saved.submittedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(saved.comments.length, 1);
    assert.deepEqual(saved.answers.map((a) => a.answered), [true, false, true, true, false]);
  } finally { await p.cleanup(); }
});

test('submit clears the draft and updates meta.json', async () => {
  const { p, store } = await open();
  try {
    await store.writeDraft(validReview({ overall: 'wip' }));
    assert.ok(await store.readDraft());
    await store.submit(validReview());
    assert.equal(await store.readDraft(), null);
    const meta = JSON.parse(await fs.readFile(path.join(p.reviewDir, 'meta.json'), 'utf8'));
    assert.equal(meta.lastSubmittedRound, 1);
    assert.equal(meta.currentRound, 2);
  } finally { await p.cleanup(); }
});

test('draft saves and restores, last write wins, no temp files are left', async () => {
  const { p, store } = await open();
  try {
    assert.equal(await store.readDraft(), null);
    await store.writeDraft(validReview({ overall: 'one', comments: [comment()] }));
    await store.writeDraft(validReview({ overall: 'two', comments: [comment(), comment({ id: 'c2' })] }));
    const d = await store.readDraft();
    assert.equal(d.overall, 'two');
    assert.equal(d.comments.length, 2);
    assert.match(d.savedAt, /^\d{4}-/);
    assert.deepEqual((await ls(p.reviewDir)).filter((n) => n.includes('tmp')), []);
  } finally { await p.cleanup(); }
});

test('a corrupt draft.json reads as no draft instead of crashing the page', async () => {
  const { p, store } = await open();
  try {
    await fs.writeFile(path.join(p.reviewDir, 'draft.json'), '{not json');
    assert.equal(await store.readDraft(), null);
  } finally { await p.cleanup(); }
});

test('writeDraft replaces a planted draft.json symlink instead of writing through it', async () => {
  const { p, store } = await open();
  const outside = await tmpDir();
  try {
    const target = path.join(outside.dir, 'victim.txt');
    await fs.writeFile(target, 'untouched');
    await fs.symlink(target, path.join(p.reviewDir, 'draft.json'));
    await store.writeDraft(validReview({ overall: 'x' }));
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
    assert.equal((await store.readDraft()).overall, 'x');
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('readDraft refuses a draft.json symlink that escapes the review folder', async () => {
  const { p, store } = await open();
  const outside = await tmpDir();
  try {
    await fs.writeFile(path.join(outside.dir, 'x.json'), '{"secret":1}');
    await fs.symlink(path.join(outside.dir, 'x.json'), path.join(p.reviewDir, 'draft.json'));
    await assert.rejects(store.readDraft(), PathError);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('submit does not follow a planted round-N.json symlink', async () => {
  const { p, store } = await open();
  const outside = await tmpDir();
  try {
    const target = path.join(outside.dir, 'victim.txt');
    await fs.writeFile(target, 'untouched');
    await fs.symlink(target, path.join(p.reviewDir, 'round-1.json'));
    const r = await store.submit(validReview());
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
    assert.equal(r.round, 2);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('listRounds only counts canonical round-N.json files, sorted numerically', async () => {
  const { p, store } = await open();
  try {
    for (const n of ['round-10.json', 'round-2.json', 'round-01.json', 'round-x.json', 'round-3.json.bak', 'round-0.json']) {
      await fs.writeFile(path.join(p.reviewDir, n), JSON.stringify({ schema: 1, submittedAt: '2026-01-01T00:00:00Z', comments: [], answers: [] }));
    }
    assert.deepEqual((await store.listRounds()).map((r) => r.round), [2, 10]);
  } finally { await p.cleanup(); }
});

test('ensureMeta creates meta.json once with keep unset', async () => {
  const { p, store } = await open();
  try {
    const m1 = await store.ensureMeta();
    assert.equal(m1.keep, null);
    assert.equal(m1.currentRound, 1);
    assert.equal(m1.lastSubmittedRound, 0);
    const m2 = await store.ensureMeta();
    assert.equal(m2.createdAt, m1.createdAt);
  } finally { await p.cleanup(); }
});

test('setKeep persists the decision and refuses to change it', async () => {
  const { p, store } = await open();
  try {
    await store.setKeep(false);
    assert.equal((await store.readMeta()).keep, false);
    await assert.rejects(store.setKeep(true), (e) => e.status === 409);
  } finally { await p.cleanup(); }
});

test('the store writes only inside the review folder', async () => {
  const { p, store } = await open();
  try {
    await store.ensureMeta();
    await store.writeDraft(validReview());
    await store.submit(validReview());
    assert.deepEqual(await ls(p.root), ['docs']);
    assert.deepEqual(await ls(path.join(p.root, 'docs')), ['reviews']);
    assert.deepEqual(await ls(path.join(p.root, 'docs', 'reviews')), ['demo']);
    assert.deepEqual(await ls(p.reviewDir), ['assets', 'doc.md', 'meta.json', 'round-1.json']);
  } finally { await p.cleanup(); }
});

// ---- fix round 1 ----

test('writes are refused (409) after the review folder is swapped for a symlink to somewhere else', async () => {
  const { p, store } = await open();
  const outside = await tmpDir();
  try {
    await fs.rename(p.reviewDir, p.reviewDir + '.real');
    await fs.symlink(outside.dir, p.reviewDir);
    const conflict = (e) => e.status === 409;
    await assert.rejects(store.writeDraft(validReview()), conflict);
    await assert.rejects(store.submit(validReview()), conflict);
    await assert.rejects(store.clearDraft(), conflict);
    await assert.rejects(store.writeMetaState(), conflict);
    assert.deepEqual(await ls(outside.dir), [], 'nothing was written through the symlink');
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('writes are refused (409) when the folder is replaced by a different directory at the same path', async () => {
  const { p, store } = await open();
  try {
    await fs.rename(p.reviewDir, p.reviewDir + '.real');
    await fs.mkdir(p.reviewDir);
    await fs.writeFile(path.join(p.reviewDir, 'doc.md'), '# other');
    await assert.rejects(store.writeDraft(validReview()), (e) => e.status === 409);
    assert.deepEqual(await ls(p.reviewDir), ['doc.md']);
  } finally { await p.cleanup(); }
});

test('writes are refused when a parent directory is swapped for a symlink after start', async () => {
  const { p, store } = await open();
  const outside = await tmpDir();
  try {
    await fs.mkdir(path.join(outside.dir, 'demo'));
    await fs.rename(path.join(p.root, 'docs', 'reviews'), path.join(p.root, 'docs', 'reviews.real'));
    await fs.symlink(outside.dir, path.join(p.root, 'docs', 'reviews'));
    await assert.rejects(store.writeDraft(validReview()), (e) => e.status === 409);
    assert.deepEqual(await ls(path.join(outside.dir, 'demo')), []);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('listRounds and numbering count only regular files named round-N.json', async () => {
  const { p, store } = await open();
  const outside = await tmpDir();
  try {
    const body = JSON.stringify({ schema: 1, submittedAt: '2026-01-01T00:00:00Z', comments: [], answers: [] });
    await fs.writeFile(path.join(p.reviewDir, 'round-1.json'), body);
    await fs.mkdir(path.join(p.reviewDir, 'round-7.json'));
    await fs.writeFile(path.join(outside.dir, 'x.json'), body);
    await fs.symlink(path.join(outside.dir, 'x.json'), path.join(p.reviewDir, 'round-9.json'));
    assert.deepEqual((await store.listRounds()).map((r) => r.round), [1]);
    const r = await store.submit(validReview());
    assert.equal(r.round, 2);
  } finally { await p.cleanup(); await outside.cleanup(); }
});

test('submit still succeeds once the round file exists, even if clearing the draft or updating meta fails', async () => {
  const { p, store } = await open();
  try {
    await fs.mkdir(path.join(p.reviewDir, 'draft.json')); // unlink() of a directory fails
    await fs.mkdir(path.join(p.reviewDir, 'meta.json')); // rename() over a directory fails
    const r = await store.submit(validReview({ overall: 'kept' }));
    assert.equal(r.round, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(p.reviewDir, 'round-1.json'), 'utf8')).overall, 'kept');
  } finally { await p.cleanup(); }
});

test('concurrent keep decisions and meta writes never lose the keep value', async () => {
  const { p, store } = await open();
  try {
    await store.ensureMeta();
    await Promise.all([store.setKeep(false), ...Array.from({ length: 5 }, () => store.submit(validReview()))]);
    const meta = await store.readMeta();
    assert.equal(meta.keep, false);
    assert.equal(meta.lastSubmittedRound, 5);
  } finally { await p.cleanup(); }
});

test('readDraft returns null for a draft that is valid JSON but not a valid review', async () => {
  const { p, store } = await open();
  try {
    await fs.writeFile(path.join(p.reviewDir, 'draft.json'), JSON.stringify({ schema: 1, docHash: 'nope', comments: 'x' }));
    assert.equal(await store.readDraft(), null);
    await store.writeDraft(validReview({ overall: 'ok' }));
    const d = await store.readDraft();
    assert.equal(d.overall, 'ok');
    assert.match(d.savedAt, /^\d{4}-/);
    assert.deepEqual(parseReview(d), { docHash: d.docHash, overall: 'ok', comments: [], answers: [] });
  } finally { await p.cleanup(); }
});
