import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SAMPLE_DOC = '# Title\n\nHello world.\n\n- one\n- two\n';

/** Creates a temp project with docs/reviews/<slug>/doc.md. Returns real paths. */
export async function tmpProject({ git = false, doc = SAMPLE_DOC, slug = 'demo' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kr-test-')));
  const reviewDir = path.join(root, 'docs', 'reviews', slug);
  await fs.mkdir(path.join(reviewDir, 'assets'), { recursive: true });
  if (doc !== null) await fs.writeFile(path.join(reviewDir, 'doc.md'), doc);
  if (git) {
    await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await fs.mkdir(path.join(root, '.git', 'objects'));
    await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }
  return {
    root,
    reviewDir,
    slug,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function tmpDir(prefix = 'kr-aux-') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export const HASH = 'sha256:' + 'a'.repeat(64);

export function validReview(overrides = {}) {
  return {
    docHash: HASH,
    overall: '',
    comments: [],
    answers: [],
    ...overrides,
  };
}

export function comment(overrides = {}) {
  return {
    id: 'c1',
    startLine: 1,
    endLine: 2,
    quote: 'Title Hello world.',
    docHash: HASH,
    text: 'Please reword.',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function answer(overrides = {}) {
  return {
    id: 'q1',
    type: 'single',
    prompt: 'Pick one',
    selected: [{ index: 0, label: 'A' }],
    other: '',
    text: '',
    ...overrides,
  };
}
