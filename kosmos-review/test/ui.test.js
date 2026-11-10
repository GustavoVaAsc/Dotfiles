// Runs the real component tree (Preact + htm + the app's own modules) against a minimal fake DOM and a fake
// API client. It is not a browser: layout, hover, CSS and Mermaid are not exercised here.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakeDom, Element_, find, findAll, byText, fire, settle } from './fake-dom.js';

register('./importmap-hooks.mjs', import.meta.url);

let dom; let preact; let html; let App; let createMarkdown; let markdownit; let hljs;

before(async () => {
  dom = installFakeDom();
  preact = await import('preact');
  ({ html } = await import('../web/lib/html.js'));
  ({ App } = await import('../web/components/App.js'));
  ({ createMarkdown } = await import('../web/lib/markdown.js'));
  markdownit = (await import('#markdown-it')).default;
  hljs = (await import('#highlight.js')).default;
});
after(() => dom.restore());

const DOC = [
  '# Plan', '', 'First paragraph.', '', '```kosmos-question', 'id: db', 'type: single', 'prompt: Which `db`?',
  'options:', '  - Postgres', '  - SQLite', '```', '', '```kosmos-question', 'id: why', 'type: text', 'prompt: Why?', '```', '', '- item', '',
].join('\n');
const HASH = 'sha256:' + 'c'.repeat(64);

function fakeApi(overrides = {}) {
  const calls = { saveDraft: [], submit: [], setKeep: [], ping: 0 };
  const state = {
    app: 'kosmos-review', slug: 'demo', reviewPath: 'docs/reviews/demo', doc: { text: DOC, hash: HASH }, draft: null,
    meta: {}, rounds: [], round: 1, status: 'open', git: { isRepo: false }, needsKeepPrompt: false, ...overrides.state,
  };
  return {
    calls,
    state,
    getState: async () => structuredClone(state),
    saveDraft: async (p) => { calls.saveDraft.push(p); return { ok: true }; },
    submit: overrides.submit ?? (async (p) => { calls.submit.push(p); state.rounds = [{ round: 1 }]; state.status = 'submitted'; state.draft = null; state.round = 2; return { ok: true, round: 1, file: 'docs/reviews/demo/round-1.json' }; }),
    setKeep: async (k) => { calls.setKeep.push(k); return { ok: true }; },
    ping: overrides.ping ?? (async () => { calls.ping += 1; return { ok: true }; }),
    assetBlob: async () => ({ size: 1 }),
  };
}

const mounted = [];
afterEach(() => { while (mounted.length) preact.render(null, mounted.pop()); }); // a failing test must not leave timers running

async function mount(api, props = {}) {
  const root = new Element_('div');
  mounted.push(root);
  dom.document.body.appendChild(root);
  const markdown = createMarkdown({ markdownit, hljs });
  preact.render(html`<${App} api=${api} markdown=${markdown} ...${props} />`, root);
  await settle();
  return { root, text: () => root.textContent, unmount: () => preact.render(null, root) };
}

const input = (node, value) => { node.value = value; fire(node, 'input', { target: node }); };

test('renders the document, the question widgets and the side panel', async () => {
  const { root, unmount } = await mount(fakeApi());
  const html_ = root.toHTML();
  assert.ok(html_.includes('data-line-start="1" data-line-end="1"'), 'heading is anchored');
  assert.ok(html_.includes('id="question-db"'));
  assert.equal(findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'radio').length, 2);
  assert.ok(find(root, (n) => n.localName === 'textarea' && n.getAttribute('aria-label') === 'Why?'));
  assert.ok(html_.includes('Which <code>db</code>?'), 'inline markdown in the prompt');
  assert.ok(root.textContent.includes('0 of 2 questions answered'));
  assert.ok(root.textContent.includes('Round 1'));
  unmount();
});

test('answering a question autosaves the draft with labels and the document hash', async () => {
  const api = fakeApi();
  const { root, unmount } = await mount(api);
  const radios = findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'radio');
  radios[1].checked = true;
  fire(radios[1], 'change', { target: radios[1] });
  await settle(900);
  assert.equal(api.calls.saveDraft.length, 1);
  const draft = api.calls.saveDraft[0];
  assert.equal(draft.docHash, HASH);
  assert.deepEqual(draft.answers.find((a) => a.id === 'db').selected, [{ index: 1, label: 'SQLite' }]);
  assert.equal(draft.answers.find((a) => a.id === 'why').selected.length, 0);
  assert.ok(root.textContent.includes('1 of 2 questions answered'));
  unmount();
});

test('add a comment by line range, save it, autosave it, then submit the review', async () => {
  const api = fakeApi();
  const { root, text, unmount } = await mount(api);

  const [from, to] = findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'number');
  input(from, '3');
  input(to, '3');
  await settle(); // let the inputs' state commit, as real events would be spaced out
  fire(find(root, (n) => n.localName === 'form'), 'submit');
  await settle();
  assert.ok(text().includes('New comment'));
  assert.ok(text().includes('Line 3'));
  assert.ok(text().includes('First paragraph.'), 'the quote of the anchored source');

  const area = find(root, (n) => n.localName === 'textarea' && n.getAttribute('placeholder') === 'What should change, and how?');
  input(area, 'Reword this.');
  await settle();
  fire(byText(root, 'button', 'Save comment'), 'click');
  await settle(900);

  assert.ok(text().includes('Reword this.'));
  assert.equal(api.calls.saveDraft.at(-1).comments.length, 1);
  const saved = api.calls.saveDraft.at(-1).comments[0];
  assert.deepEqual([saved.startLine, saved.endLine, saved.quote, saved.docHash, saved.text], [3, 3, 'First paragraph.', HASH, 'Reword this.']);

  fire(byText(root, 'button', 'Submit review'), 'click');
  await settle(150);
  assert.equal(api.calls.submit.length, 1);
  assert.equal(api.calls.submit[0].comments[0].text, 'Reword this.');
  assert.equal(api.calls.submit[0].answers.length, 2, 'unanswered questions are still reported');
  assert.ok(text().includes('review submitted'), 'tells the user what to say to the agent');
  assert.ok(text().includes('Start another round'));
  assert.ok(findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'radio').every((n) => n.hasAttribute('disabled')), 'locked after submit');
  unmount();
});

test('a saved draft is restored on load: comments, answers and overall note', async () => {
  const draft = {
    schema: 1, docHash: HASH, overall: 'Looks mostly fine',
    comments: [{ id: 'c4', startLine: 3, endLine: 3, quote: 'First paragraph.', docHash: HASH, text: 'Restored comment', createdAt: '2026-01-01T00:00:00Z' }],
    answers: [{ id: 'db', type: 'single', prompt: 'Which `db`?', selected: [{ index: 1, label: 'SQLite' }], other: '', text: '' }],
  };
  const { root, text, unmount } = await mount(fakeApi({ state: { draft } }));
  assert.ok(text().includes('Restored comment'));
  assert.ok(text().includes('1 comment'));
  assert.ok(text().includes('1 of 2 questions answered'));
  const radios = findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'radio');
  assert.equal(radios[1].getAttribute('checked'), 'true');
  assert.ok(find(root, (n) => n.localName === 'textarea' && n.getAttribute('placeholder')?.startsWith('Anything that')).getAttribute('value') === 'Looks mostly fine');
  unmount();
});

test('a draft made on an older version of the document is flagged', async () => {
  const draft = {
    schema: 1, docHash: 'sha256:' + 'd'.repeat(64), overall: '',
    comments: [{ id: 'c1', startLine: 3, endLine: 3, quote: 'old', docHash: 'sha256:' + 'd'.repeat(64), text: 'old note', createdAt: 'x' }], answers: [],
  };
  const { text, unmount } = await mount(fakeApi({ state: { draft } }));
  assert.ok(text().includes('earlier version'));
  unmount();
});

test('a submit rejected because the document changed offers a reload instead of losing the draft', async () => {
  const api = fakeApi({ submit: async () => { const e = new Error('the document changed since you opened it; reload the page (your draft is kept)'); e.status = 409; throw e; } });
  const { root, text, unmount } = await mount(api);
  fire(byText(root, 'button', 'Submit review'), 'click'); // no comments: window.confirm (stubbed to true) lets it through
  await settle(150);
  assert.ok(text().includes('the document changed'));
  assert.ok(byText(root, 'button', 'Reload document'));
  unmount();
});

test('the keep prompt appears when the server asks and is dismissed after answering', async () => {
  const api = fakeApi({ state: { git: { isRepo: true }, needsKeepPrompt: true } });
  const { root, text, unmount } = await mount(api);
  assert.ok(text().includes('Keep this review in the repo?'));
  fire(byText(root, 'button', 'Do not keep'), 'click');
  await settle();
  assert.deepEqual(api.calls.setKeep, [false]);
  assert.ok(!text().includes('Keep this review in the repo?'));
  unmount();
});

test('an unauthorized load explains how to get a fresh URL', async () => {
  const api = fakeApi();
  api.getState = async () => { const e = new Error('missing or invalid token'); e.status = 401; throw e; };
  const { text, unmount } = await mount(api);
  assert.ok(text().includes('Access token rejected'));
  assert.ok(text().includes('Open the URL the agent printed'));
  unmount();
});

test('question problems in the document are shown in place and counted in a notice', async () => {
  const bad = '# T\n\n```kosmos-question\nid: x\ntype: radio\nprompt: P\n```\n';
  const { root, text, unmount } = await mount(fakeApi({ state: { doc: { text: bad, hash: HASH } } }));
  assert.ok(text().includes('Question block has problems'));
  assert.ok(text().includes('1 problem(s)'));
  assert.ok(find(root, (n) => n.localName === 'section' && (n.getAttribute('class') ?? '').includes('question-invalid')));
  unmount();
});

test('hovering a block shows the gutter button; clicking opens a comment on that block, Shift+click extends it', async () => {
  const api = fakeApi();
  const { root, text, unmount } = await mount(api);
  const article = find(root, (n) => n.localName === 'article');
  const block = (start, end) => {
    const el = new Element_('p');
    el.dataset = { lineStart: String(start), lineEnd: String(end) };
    el.closest = () => el;
    article.appendChild(el);
    return el;
  };

  const first = block(3, 3);
  fire(article, 'mouseover', { target: first });
  await settle();
  const button = find(root, (n) => n.localName === 'button' && (n.getAttribute('class') ?? '').includes('gutter-add'));
  assert.ok(button, 'the + appears');
  fire(button, 'click', { shiftKey: false });
  await settle();
  assert.ok(text().includes('Line 3'));

  const second = block(19, 19);
  fire(article, 'mouseover', { target: second });
  await settle();
  fire(find(root, (n) => n.localName === 'button' && (n.getAttribute('class') ?? '').includes('gutter-add')), 'click', { shiftKey: true });
  await settle();
  assert.ok(text().includes('Lines 3-19'), 'range grew to cover both blocks');
  assert.ok(text().includes('First paragraph.'), 'quote covers the merged range');
  unmount();
});

// ---- fix round 1 ----

test('submit saves the edits made in the last moments first, so a rejected submit loses nothing', async () => {
  const api = fakeApi({ submit: async () => { const e = new Error('changed'); e.status = 409; throw e; } });
  const { root, unmount } = await mount(api);
  const radios = findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'radio');
  radios[0].checked = true;
  fire(radios[0], 'change', { target: radios[0] });
  await settle(80); // effects have run (autosave is scheduled) but the 700 ms delay has not elapsed
  assert.equal(api.calls.saveDraft.length, 0);
  fire(byText(root, 'button', 'Submit review'), 'click');
  await settle(150);
  assert.equal(api.calls.saveDraft.length, 1, 'the pending draft was flushed before submitting');
  assert.deepEqual(api.calls.saveDraft[0].answers.find((a) => a.id === 'db').selected, [{ index: 0, label: 'Postgres' }]);
  unmount();
});

test('while the page is open it pings the server so the idle timer does not strand the tab', async () => {
  const api = fakeApi();
  const { unmount } = await mount(api, { heartbeatMs: 25 });
  await settle(160);
  assert.ok(api.calls.ping >= 3, `pings: ${api.calls.ping}`);
  unmount();
  const seen = api.calls.ping;
  await settle(100);
  assert.equal(api.calls.ping, seen, 'stops pinging after unmount');
});

test('when the heartbeat fails the page says the server is gone and that the draft is safe', async () => {
  const api = fakeApi({ ping: async () => { throw new Error('cannot reach the review server'); } });
  const { text, unmount } = await mount(api, { heartbeatMs: 25 });
  await settle(120);
  assert.ok(text().includes('Lost contact with the review server'));
  assert.ok(text().includes('kosmos-review serve'));
  unmount();
});

test('after submit there is one banner, and the page summarises what was submitted instead of an empty form', async () => {
  const api = fakeApi();
  api.submit = async (p) => {
    api.calls.submit.push(p);
    api.state.rounds = [{ round: 1, file: 'docs/reviews/demo/round-1.json', comments: 1, answers: 2 }];
    api.state.status = 'submitted'; api.state.draft = null; api.state.round = 2;
    return { ok: true, round: 1, file: 'docs/reviews/demo/round-1.json' };
  };
  const { root, text, unmount } = await mount(api);
  const [from] = findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'number');
  const to = findAll(root, (n) => n.localName === 'input' && n.getAttribute('type') === 'number')[1];
  input(from, '3'); input(to, '3');
  await settle();
  fire(find(root, (n) => n.localName === 'form'), 'submit');
  await settle();
  input(find(root, (n) => n.localName === 'textarea' && n.getAttribute('placeholder') === 'What should change, and how?'), 'note');
  await settle();
  fire(byText(root, 'button', 'Save comment'), 'click');
  await settle(120);
  fire(byText(root, 'button', 'Submit review'), 'click');
  await settle(200);
  assert.equal(text().split('Tell the agent').length - 1, 1, 'a single banner');
  assert.ok(text().includes('Round 1 submitted'));
  assert.ok(text().includes('docs/reviews/demo/round-1.json'));
  assert.ok(text().includes('1 comment'));
  assert.ok(text().includes('2 questions answered'));
  assert.ok(!text().includes('Round 2'), 'does not show the next, still-empty round while locked');
  unmount();
});

// ---- fix round 2 ----

test('the lost-contact notice clears by itself when a later ping succeeds', async () => {
  let down = true;
  const api = fakeApi({ ping: async () => { if (down) throw new Error('down'); return { ok: true }; } });
  const { text, unmount } = await mount(api, { heartbeatMs: 25 });
  await settle(100);
  assert.ok(text().includes('Lost contact with the review server'), 'shown while pings fail');
  down = false;
  await settle(150);
  assert.ok(!text().includes('Lost contact'), 'cleared after the server answered again');
  unmount();
});

test('a lost-contact notice does not clear an unrelated notice', async () => {
  const api = fakeApi({ submit: async () => { const e = new Error('Submit failed for another reason'); e.status = 500; throw e; } });
  const { root, text, unmount } = await mount(api, { heartbeatMs: 25 });
  fire(byText(root, 'button', 'Submit review'), 'click');
  await settle(150);
  assert.ok(text().includes('Submit failed'));
  await settle(100); // several successful pings later
  assert.ok(text().includes('Submit failed'), 'the submit error is still shown');
  unmount();
});

// ---- fix round 3 ----

test('a failed ping does not replace a notice that is already showing (e.g. a rejected submit)', async () => {
  const api = fakeApi({
    submit: async () => { const e = new Error('the document changed since you opened it'); e.status = 409; throw e; },
    ping: async () => { throw new Error('down'); },
  });
  const { root, text, unmount } = await mount(api, { heartbeatMs: 25 });
  await settle(100);
  assert.ok(text().includes('Lost contact'), 'with no other notice the lost-contact one is shown');
  // clear it by letting the submit error take over: the submit handler sets its own notice
  fire(byText(root, 'button', 'Submit review'), 'click');
  await settle(150);
  assert.ok(text().includes('the document changed'), 'the submit notice replaced it');
  assert.ok(byText(root, 'button', 'Reload document'), 'its Reload action is still there');
  await settle(120); // several more failed pings
  assert.ok(text().includes('the document changed'));
  assert.ok(byText(root, 'button', 'Reload document'));
  assert.ok(!text().includes('Lost contact'), 'the ping did not overwrite it');
  unmount();
});

test('"Do not keep" in a worktree shows the exact line to add and the command that finds the file', async () => {
  const api = fakeApi({ state: { git: { isRepo: true }, needsKeepPrompt: true } });
  api.setKeep = async (k) => { api.calls.setKeep.push(k); return { ok: true, keep: k, exclude: 'manual', manual: { line: '/docs/reviews/demo/', command: 'git rev-parse --git-path info/exclude' } }; };
  const { root, text, unmount } = await mount(api);
  fire(byText(root, 'button', 'Do not keep'), 'click');
  await settle();
  assert.ok(!text().includes('Keep this review in the repo?'));
  assert.ok(text().includes('/docs/reviews/demo/'));
  assert.ok(text().includes('git rev-parse --git-path info/exclude'));
  assert.ok(text().includes('nothing was written automatically'));
  unmount();
});
