// Exercises pi/agent/extensions/preset.ts (the `/preset` command): the pure logic (name and preset validation, model
// resolution, the settings merge), the locked settings update against temp files, the checked-in presets, and the
// command wiring against a fake `pi`. Nothing here touches ~/.pi: every file lives in a temp dir. Skipped when the
// extension or Node's TypeScript support is not available. Only `import type` is used by the extension, so no Pi
// install is needed.
// The `contract:` tests run the real pi-subagents lease code against ours. Unlike pi-extension.test.js they FAIL, not
// skip, when that package is missing: a silent skip would let our copy of its lock protocol drift unnoticed on the
// machine that actually uses it. PRESET_CONTRACT=skip is the explicit, visible opt-out for machines without Pi.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpDir } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const EXTENSION = path.join(REPO, 'pi/agent/extensions/preset.ts');
const PRESETS = path.join(REPO, 'pi/agent/presets');
const AGENTS = path.join(REPO, 'kosmos-pi/agents');
const skip = !fs.existsSync(EXTENSION) ? 'extension not present' : !process.features.typescript ? 'Node without TypeScript support' : false;
const load = () => import(pathToFileURL(EXTENSION).href);
// The installed pi-subagents, whose lease protocol `updateSettingsFile` must interoperate with. Read before any test
// points PI_CODING_AGENT_DIR at a scratch dir.
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const SUBAGENTS_LEASE = path.join(PI_AGENT_DIR, 'npm', 'node_modules', 'pi-subagents', 'src', 'shared', 'file-lease.js');

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
async function scratch() {
  const t = await tmpDir('preset-test-');
  cleanups.push(t.cleanup);
  return t.dir;
}

const PRESET = {
  description: 'demo',
  main: { model: 'prov/main-model', thinking: 'medium' },
  agents: {
    'kosmos.coder': { model: 'prov/coder-model', thinking: 'low' },
    'kosmos.reviewer': { model: 'prov/rev-model', thinking: 'high' },
  },
};
const SETTINGS = {
  defaultProvider: 'old',
  defaultModel: 'old-model',
  defaultThinkingLevel: 'low',
  hideThinkingBlock: true,
  packages: ['npm:a'],
  subagents: {
    maxThinking: 'high',
    defaultExtensions: [],
    agentOverrides: {
      researcher: { disabled: true },
      'evidence-auditor': { disabled: true },
      'kosmos.coder': { model: 'old/m', thinking: 'high', tools: ['read'], extensions: ['x.ts'] },
    },
  },
};
const clone = (v) => JSON.parse(JSON.stringify(v));

test('isValidPresetName accepts safe names only', { skip }, async () => {
  const { isValidPresetName } = await load();
  for (const ok of ['minimax', 'mimo', 'a', '0x', 'a-b_c', 'a'.repeat(64)]) assert.equal(isValidPresetName(ok), true, ok);
  const bad = ['', 'A', 'Mimo', '../x', 'a/b', 'a\\b', '.hidden', '-a', '_a', 'a.json', 'a b', 'a\nb', 'a\0b', 'a'.repeat(65), '~', '*', 'é'];
  for (const name of bad) assert.equal(isValidPresetName(name), false, JSON.stringify(name));
  for (const notString of [undefined, null, 5, {}, ['a']]) assert.equal(isValidPresetName(notString), false);
});

test('parseModelRef splits provider from model id at the first slash', { skip }, async () => {
  const { parseModelRef } = await load();
  assert.deepEqual(parseModelRef('minimax/MiniMax-M3.1-Flash'), { provider: 'minimax', id: 'MiniMax-M3.1-Flash' });
  assert.deepEqual(parseModelRef('openrouter/openai/gpt-5-mini'), { provider: 'openrouter', id: 'openai/gpt-5-mini' });
  for (const bad of ['', 'noslash', '/id', 'prov/', 'a b/c', 'prov/a b', 'prov/a\nb', 5, undefined]) {
    assert.throws(() => parseModelRef(bad), /model/i, JSON.stringify(bad));
  }
});

test('validatePreset returns a normalised preset for a valid shape', { skip }, async () => {
  const { validatePreset } = await load();
  const p = validatePreset(clone(PRESET));
  assert.deepEqual(p, PRESET);
  const minimal = validatePreset({ main: { model: 'a/b', thinking: 'off' } });
  assert.deepEqual(minimal.agents, {});
  assert.equal(minimal.description, undefined);
  // An agent entry may set only one of the two fields.
  assert.deepEqual(validatePreset({ main: PRESET.main, agents: { x: { thinking: 'low' } } }).agents, { x: { thinking: 'low' } });
});

test('validatePreset rejects every malformed shape', { skip }, async () => {
  const { validatePreset } = await load();
  const main = PRESET.main;
  const cases = {
    'not an object': 'x',
    array: [],
    null: null,
    'no main': { agents: {} },
    'main not object': { main: 'a/b' },
    'main without model': { main: { thinking: 'low' } },
    'main without thinking': { main: { model: 'a/b' } },
    'main bad model': { main: { model: 'nope', thinking: 'low' } },
    'main bad thinking': { main: { model: 'a/b', thinking: 'ultra' } },
    'main thinking not string': { main: { model: 'a/b', thinking: 3 } },
    'unknown top-level key': { main, extra: 1 },
    'unknown main key': { main: { ...main, fast: true } },
    'agents array': { main, agents: [] },
    'agents null': { main, agents: null },
    'agent entry not object': { main, agents: { x: 'a/b' } },
    'agent entry empty': { main, agents: { x: {} } },
    'agent unknown key': { main, agents: { x: { model: 'a/b', disabled: true } } },
    'agent bad model': { main, agents: { x: { model: 'bad' } } },
    'agent bad thinking': { main, agents: { x: { thinking: 'ultra' } } },
    'agent bad name': { main, agents: { '../x': { model: 'a/b' } } },
    'agent proto name': { main, agents: JSON.parse('{"__proto__": {"model": "a/b"}}') },
    'description not string': { main, description: 3 },
    'description too long': { main, description: 'x'.repeat(201) },
    'description control chars': { main, description: 'a\x1b[31mred' },
  };
  for (const [label, raw] of Object.entries(cases)) assert.throws(() => validatePreset(raw), (e) => e instanceof Error && e.message.length > 0, label);
});

test('resolveModels resolves main and agent models, naming every unknown one', { skip }, async () => {
  const { resolveModels, validatePreset } = await load();
  const preset = validatePreset(clone(PRESET));
  const known = new Map([['prov/main-model', { provider: 'prov', id: 'main-model' }], ['prov/coder-model', {}], ['prov/rev-model', {}]]);
  const find = (provider, id) => known.get(`${provider}/${id}`);
  assert.deepEqual(resolveModels(preset, find), { provider: 'prov', id: 'main-model' });
  known.delete('prov/main-model');
  known.delete('prov/rev-model');
  assert.throws(() => resolveModels(preset, find), (e) => /prov\/main-model/.test(e.message) && /prov\/rev-model/.test(e.message) && !/coder-model/.test(e.message));
});

test('applyPresetToSettings sets the defaults and merges only model and thinking', { skip }, async () => {
  const { applyPresetToSettings, validatePreset } = await load();
  const input = clone(SETTINGS);
  const out = applyPresetToSettings(input, 'demo', validatePreset(clone(PRESET)));
  assert.deepEqual(input, SETTINGS, 'input is not mutated');
  assert.equal(out.defaultProvider, 'prov');
  assert.equal(out.defaultModel, 'main-model');
  assert.equal(out.defaultThinkingLevel, 'medium');
  assert.equal(out.kosmosActivePreset, 'demo');
  assert.deepEqual(out.subagents.agentOverrides['kosmos.coder'], { model: 'prov/coder-model', thinking: 'low', tools: ['read'], extensions: ['x.ts'] });
  assert.deepEqual(out.subagents.agentOverrides['kosmos.reviewer'], { model: 'prov/rev-model', thinking: 'high' });
  // Everything else is byte-for-byte what it was.
  const { defaultProvider, defaultModel, defaultThinkingLevel, kosmosActivePreset, ...rest } = out;
  const { defaultProvider: _p, defaultModel: _m, defaultThinkingLevel: _t, ...restIn } = SETTINGS;
  assert.deepEqual({ ...rest, subagents: { ...rest.subagents, agentOverrides: undefined } }, { ...restIn, subagents: { ...restIn.subagents, agentOverrides: undefined } });
});

test('applyPresetToSettings keeps the disabled-builtin entries (security control)', { skip }, async () => {
  const { applyPresetToSettings, validatePreset } = await load();
  const preset = validatePreset({
    main: PRESET.main,
    // Preset keys that are close to, but not, the builtin names; and the bare builtin names themselves are not
    // special-cased: a preset that names them merges model/thinking only and never drops `disabled`.
    agents: { 'kosmos.researcher': { model: 'prov/r', thinking: 'low' }, researcher: { model: 'prov/x', thinking: 'low' } },
  });
  const out = applyPresetToSettings(clone(SETTINGS), 'demo', preset);
  assert.deepEqual(out.subagents.agentOverrides.researcher, { disabled: true, model: 'prov/x', thinking: 'low' });
  assert.deepEqual(out.subagents.agentOverrides['evidence-auditor'], { disabled: true });
  assert.deepEqual(out.subagents.agentOverrides['kosmos.researcher'], { model: 'prov/r', thinking: 'low' });
  // The shipped presets never name the builtins, so they cannot touch them at all.
  const shipped = applyPresetToSettings(clone(SETTINGS), 'demo', validatePreset(clone(PRESET)));
  assert.deepEqual(shipped.subagents.agentOverrides.researcher, { disabled: true });
  assert.deepEqual(shipped.subagents.agentOverrides['evidence-auditor'], { disabled: true });
});

test('applyPresetToSettings creates missing subagents structure and keeps unlisted agents', { skip }, async () => {
  const { applyPresetToSettings, validatePreset } = await load();
  const preset = validatePreset(clone(PRESET));
  const fresh = applyPresetToSettings({}, 'demo', preset);
  assert.deepEqual(fresh.subagents.agentOverrides['kosmos.coder'], { model: 'prov/coder-model', thinking: 'low' });
  const noAgents = applyPresetToSettings({ subagents: { maxThinking: 'high' } }, 'demo', validatePreset({ main: PRESET.main }));
  assert.deepEqual(noAgents.subagents, { maxThinking: 'high' }, 'a preset without agents leaves subagents alone');
  const other = applyPresetToSettings({ subagents: { agentOverrides: { 'kosmos.other': { model: 'k/k' } } } }, 'demo', preset);
  assert.deepEqual(other.subagents.agentOverrides['kosmos.other'], { model: 'k/k' });
});

test('applyPresetToSettings refuses to guess at a malformed settings shape', { skip }, async () => {
  const { applyPresetToSettings, validatePreset } = await load();
  const preset = validatePreset(clone(PRESET));
  for (const bad of [
    { subagents: [] },
    { subagents: 'x' },
    { subagents: { agentOverrides: [] } },
    { subagents: { agentOverrides: 'x' } },
    { subagents: { agentOverrides: { 'kosmos.coder': 'x' } } },
    { subagents: { agentOverrides: { 'kosmos.coder': ['x'] } } },
  ]) assert.throws(() => applyPresetToSettings(bad, 'demo', preset), /subagents|agentOverrides/, JSON.stringify(bad));
});

test('applyPresetToSettings rejects agent thinking above subagents.maxThinking', { skip }, async () => {
  const { applyPresetToSettings, validatePreset } = await load();
  const preset = validatePreset({ main: PRESET.main, agents: { 'kosmos.coder': { thinking: 'xhigh' } } });
  assert.throws(() => applyPresetToSettings({ subagents: { maxThinking: 'high' } }, 'demo', preset), /xhigh.*maxThinking.*high|maxThinking/);
  // At the ceiling, below it, and with no ceiling set, it is fine.
  const atCeiling = validatePreset({ main: PRESET.main, agents: { 'kosmos.coder': { thinking: 'high' } } });
  assert.doesNotThrow(() => applyPresetToSettings({ subagents: { maxThinking: 'high' } }, 'demo', atCeiling));
  assert.doesNotThrow(() => applyPresetToSettings({}, 'demo', preset));
  // The main session level is not a subagent and is not capped by it.
  const mainHigh = validatePreset({ main: { model: 'a/b', thinking: 'xhigh' } });
  assert.doesNotThrow(() => applyPresetToSettings({ subagents: { maxThinking: 'high' } }, 'demo', mainHigh));
});

test('presetSummary lists the main session and every agent', { skip }, async () => {
  const { presetSummary, validatePreset } = await load();
  const lines = presetSummary('demo', validatePreset(clone(PRESET)));
  assert.equal(lines[0], 'Preset demo applied');
  assert.ok(lines.some((l) => l.includes('main') && l.includes('prov/main-model') && l.includes('medium')));
  assert.ok(lines.some((l) => l.includes('kosmos.coder') && l.includes('prov/coder-model') && l.includes('low')));
  assert.ok(lines.some((l) => l.includes('kosmos.reviewer') && l.includes('high')));
});

test('loadPreset and listPresets read only safe names from the presets dir', { skip }, async () => {
  const { loadPreset, listPresets } = await load();
  const dir = await scratch();
  fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify(PRESET));
  fs.writeFileSync(path.join(dir, 'two.json'), JSON.stringify({ main: PRESET.main }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'bad-shape.json'), JSON.stringify({ main: 1 }));
  fs.writeFileSync(path.join(dir, 'Upper.json'), JSON.stringify(PRESET));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'adir.json'));
  fs.writeFileSync(path.join(dir, '..', path.basename(dir) + '-outside.json'), JSON.stringify(PRESET));
  cleanups.push(async () => fs.rmSync(path.join(dir, '..', path.basename(dir) + '-outside.json'), { force: true }));
  fs.symlinkSync(path.join(dir, 'one.json'), path.join(dir, 'link.json'));

  assert.deepEqual(loadPreset(dir, 'one'), PRESET);
  for (const bad of ['../' + path.basename(dir) + '-outside', 'one.json', 'Upper', 'missing', 'broken', 'bad-shape', 'adir', 'link', '']) {
    assert.throws(() => loadPreset(dir, bad), (e) => e.message.length > 0, JSON.stringify(bad));
  }
  const list = listPresets(dir);
  assert.deepEqual(list.map((p) => p.name), ['bad-shape', 'broken', 'one', 'two']);
  assert.equal(list.find((p) => p.name === 'one').description, 'demo');
  assert.ok(list.find((p) => p.name === 'broken').error);
  assert.ok(list.find((p) => p.name === 'bad-shape').error);
  assert.equal(list.find((p) => p.name === 'two').error, undefined);
  assert.deepEqual(listPresets(path.join(dir, 'does-not-exist')), []);
});

test('loadPreset rejects an oversized file', { skip }, async () => {
  const { loadPreset } = await load();
  const dir = await scratch();
  fs.writeFileSync(path.join(dir, 'big.json'), JSON.stringify({ ...PRESET, description: 'x'.repeat(10), pad: 'y'.repeat(200000) }));
  assert.throws(() => loadPreset(dir, 'big'), /large|size/i);
});

test('updateSettingsFile rewrites atomically under the locks and keeps the mode', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(SETTINGS, null, 2), { mode: 0o640 });
  await updateSettingsFile(file, (s) => ({ ...s, defaultModel: 'new' }));
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.defaultModel, 'new');
  assert.deepEqual(after.subagents, SETTINGS.subagents);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'no temp file and no lock left behind');
});

test('updateSettingsFile leaves the file untouched on any failure', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify(SETTINGS, null, 2);
  fs.writeFileSync(file, original);
  await assert.rejects(updateSettingsFile(file, () => { throw new Error('boom'); }), /boom/);
  await assert.rejects(updateSettingsFile(file, () => 'not an object'), /object/);
  await assert.rejects(updateSettingsFile(file, () => [1]), /object/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, '{ not json');
  await assert.rejects(updateSettingsFile(file, (s) => s), /settings/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.writeFileSync(file, '[]');
  await assert.rejects(updateSettingsFile(file, (s) => s), /object/);
  await assert.rejects(updateSettingsFile(path.join(dir, 'missing.json'), (s) => s), /settings/i);
  assert.equal(fs.existsSync(path.join(dir, 'missing.json')), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json'], 'no temp or lock leftovers');
});

test('updateSettingsFile writes through a symlinked settings file', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const real = path.join(dir, 'real.json');
  const link = path.join(dir, 'settings.json');
  fs.writeFileSync(real, '{"a":1}');
  fs.symlinkSync(real, link);
  await updateSettingsFile(link, (s) => ({ ...s, b: 2 }));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { a: 1, b: 2 });
});

test('updateSettingsFile waits for a held lock, then gives up without writing', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  // Pi's own lock (proper-lockfile): a fresh `settings.json.lock` directory.
  fs.mkdirSync(`${file}.lock`);
  await assert.rejects(updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 150 }), /lock/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  // Released while we wait: the update goes through.
  setTimeout(() => fs.rmdirSync(`${file}.lock`), 80);
  await updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 2000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 2 });
  // pi-subagents' own lease: a live owner blocks us the same way.
  const lease = `${file}.write-lock`;
  fs.mkdirSync(lease);
  fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ token: 'live-owner', pid: process.pid, hostname: (await import('node:os')).hostname() }));
  await assert.rejects(updateSettingsFile(file, (s) => ({ ...s, c: 3 }), { timeoutMs: 150 }), /lock/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 2 });
});

test('updateSettingsFile reclaims stale locks', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  // proper-lockfile treats a lock directory untouched for 10 s as stale.
  fs.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  // A pi-subagents lease whose owner process is gone.
  const lease = `${file}.write-lock`;
  fs.mkdirSync(lease);
  fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ token: 'dead-owner', pid: 2 ** 22 + 12345, hostname: (await import('node:os')).hostname() }));
  await updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 2000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 2 });
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(fs.existsSync(lease), false);
});

test('concurrent updateSettingsFile calls do not lose each other\'s changes', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"n":0}');
  await Promise.all(Array.from({ length: 8 }, () => updateSettingsFile(file, (s) => ({ ...s, n: s.n + 1 }), { timeoutMs: 5000 })));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 8);
});

test('the checked-in presets are valid and mirror the agent frontmatter', { skip }, async () => {
  const { loadPreset, listPresets } = await load();
  assert.deepEqual(listPresets(PRESETS).map((p) => [p.name, p.error]), [['mimo', undefined], ['minimax', undefined]]);
  const agentFiles = fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md'));
  assert.ok(agentFiles.length >= 6);
  const frontmatter = (file) => Object.fromEntries(fs.readFileSync(path.join(AGENTS, file), 'utf8').split('---')[1].split('\n').map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  const minimax = loadPreset(PRESETS, 'minimax');
  const mimo = loadPreset(PRESETS, 'mimo');
  assert.deepEqual(minimax.main, { model: 'minimax/MiniMax-M3.1-Flash', thinking: 'medium' });
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, 'pi/agent/settings.json'), 'utf8'));
  assert.equal(`${settings.defaultProvider}/${settings.defaultModel}`, minimax.main.model, 'minimax preset is the checked-in default');
  assert.equal(settings.defaultThinkingLevel, minimax.main.thinking);
  const names = [];
  for (const file of agentFiles) {
    const fm = frontmatter(file);
    const runtime = fm.package ? `${fm.package}.${fm.name}` : fm.name;
    names.push(runtime);
    assert.deepEqual(minimax.agents[runtime], { model: fm.model, thinking: fm.thinking }, `minimax mirrors ${file}`);
    assert.ok(mimo.agents[runtime], `mimo covers ${runtime}`);
    assert.match(mimo.agents[runtime].model, /^xiaomi-token-plan-sgp\/mimo-v2\.6-(flash|pro)$/);
  }
  assert.deepEqual(Object.keys(minimax.agents).sort(), names.sort(), 'no preset entry for a missing agent');
  assert.deepEqual(Object.keys(mimo.agents).sort(), names.sort());
  assert.deepEqual(mimo.main, { model: 'xiaomi-token-plan-sgp/mimo-v2.6-flash', thinking: 'medium' });
  const expected = {
    'kosmos.orchestrator': ['mimo-v2.6-pro', 'medium'], 'kosmos.code-reviewer': ['mimo-v2.6-pro', 'medium'], 'kosmos.security-auditor': ['mimo-v2.6-pro', 'high'],
    'kosmos.coder': ['mimo-v2.6-flash', 'medium'], 'kosmos.docs-writer': ['mimo-v2.6-flash', 'low'], 'kosmos.researcher': ['mimo-v2.6-flash', 'medium'],
  };
  for (const [agent, [id, thinking]] of Object.entries(expected)) assert.deepEqual(mimo.agents[agent], { model: `xiaomi-token-plan-sgp/${id}`, thinking }, agent);
  // Applying either to the checked-in settings keeps the disabled builtins and stays under the ceiling.
  const { applyPresetToSettings } = await load();
  for (const preset of [minimax, mimo]) {
    const out = applyPresetToSettings(clone(settings), 'x', preset);
    assert.deepEqual(out.subagents.agentOverrides.researcher, { disabled: true });
    assert.deepEqual(out.subagents.agentOverrides['evidence-auditor'], { disabled: true });
  }
});

// --- command wiring ---------------------------------------------------------

/** A fake `pi` plus a fake command context; `calls` records everything the command asks Pi to do. */
async function harness({ previousModel = { provider: 'old', id: 'old-model' }, settings = SETTINGS, presets = { demo: PRESET }, models = ['prov/main-model', 'prov/coder-model', 'prov/rev-model'], authFor = () => true, setModelResult = true } = {}) {
  const { default: ext } = await load();
  const agentDir = await scratch();
  const presetsDir = path.join(agentDir, 'presets');
  fs.mkdirSync(presetsDir);
  for (const [name, p] of Object.entries(presets)) fs.writeFileSync(path.join(presetsDir, `${name}.json`), typeof p === 'string' ? p : JSON.stringify(p));
  const settingsFile = path.join(agentDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const previousEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanups.push(async () => { if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousEnv; });
  const calls = [];
  let level = 'high';
  const commands = {};
  ext({
    registerCommand: (name, options) => { commands[name] = options; },
    setModel: async (m) => { calls.push(['setModel', `${m.provider}/${m.id}`]); return typeof setModelResult === 'function' ? setModelResult(calls.filter((c) => c[0] === 'setModel').length) : setModelResult; },
    setThinkingLevel: (l) => { calls.push(['setThinkingLevel', l]); level = l; },
    getThinkingLevel: () => level,
  });
  const notes = [];
  const ctx = {
    model: previousModel ?? undefined,
    hasUI: true,
    ui: { notify: (message, type) => notes.push({ message, type }) },
    modelRegistry: {
      find: (provider, id) => (models.includes(`${provider}/${id}`) ? { provider, id } : undefined),
      getAvailable: () => models.map((ref) => ({ provider: ref.slice(0, ref.indexOf('/')), id: ref.slice(ref.indexOf('/') + 1) })).filter((m) => authFor(m)),
      hasConfiguredAuth: (m) => authFor(m),
    },
  };
  return { command: commands.preset, calls, notes, ctx, agentDir, settingsFile, presetsDir, read: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')), raw: () => fs.readFileSync(settingsFile, 'utf8') };
}

test('registers /preset and completes preset names', { skip }, async () => {
  const h = await harness({ presets: { demo: PRESET, minimax: PRESET, broken: '{ nope' } });
  assert.ok(h.command, 'registered');
  assert.ok(h.command.description);
  const names = (items) => items.map((i) => i.value);
  assert.deepEqual(names(await h.command.getArgumentCompletions('')), ['demo', 'minimax', 'save', 'new', 'delete']);
  assert.deepEqual(names(await h.command.getArgumentCompletions('mi')), ['minimax']);
  assert.equal(await h.command.getArgumentCompletions('zzz'), null);
  assert.equal(await h.command.getArgumentCompletions('../'), null);
});

test('/preset <name> swaps the session, persists the defaults and merges the overrides', { skip }, async () => {
  const h = await harness();
  await h.command.handler('demo', h.ctx);
  assert.deepEqual(h.calls, [['setModel', 'prov/main-model'], ['setThinkingLevel', 'medium']], 'thinking is set after the model, which resets it');
  const s = h.read();
  assert.equal(s.defaultProvider, 'prov');
  assert.equal(s.defaultModel, 'main-model');
  assert.equal(s.defaultThinkingLevel, 'medium');
  assert.equal(s.kosmosActivePreset, 'demo');
  assert.deepEqual(s.subagents.agentOverrides.researcher, { disabled: true });
  assert.deepEqual(s.subagents.agentOverrides['evidence-auditor'], { disabled: true });
  assert.deepEqual(s.subagents.agentOverrides['kosmos.coder'].tools, ['read']);
  assert.equal(s.subagents.agentOverrides['kosmos.coder'].model, 'prov/coder-model');
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].type, 'info');
  assert.match(h.notes[0].message, /demo/);
  assert.match(h.notes[0].message, /kosmos\.reviewer/);
});

test('/preset trims the name', { skip }, async () => {
  const h = await harness();
  await h.command.handler('  demo  ', h.ctx);
  assert.equal(h.read().kosmosActivePreset, 'demo');
});

test('/preset with no argument lists presets and marks the active one', { skip }, async () => {
  const h = await harness({ settings: { ...SETTINGS, kosmosActivePreset: 'beta' }, presets: { alpha: { ...PRESET, description: 'first one' }, beta: PRESET, broken: '{ nope' } });
  const before = h.raw();
  await h.command.handler('', h.ctx);
  assert.deepEqual(h.calls, []);
  assert.equal(h.raw(), before);
  const text = h.notes.map((n) => n.message).join('\n');
  assert.match(text, /alpha/);
  assert.match(text, /first one/);
  assert.match(text, /beta/);
  assert.match(text, /broken/);
  assert.match(text, /active: beta/i);
  assert.match(text, /\* beta|beta.*\(active\)/);
});

test('/preset with no argument and no active preset says so', { skip }, async () => {
  const h = await harness();
  await h.command.handler('', h.ctx);
  assert.match(h.notes[0].message, /no active preset|active: none/i);
  const empty = await harness({ presets: {} });
  await empty.command.handler('', empty.ctx);
  assert.match(empty.notes[0].message, /no presets/i);
});

test('/preset changes nothing when the name is unsafe or unknown', { skip }, async () => {
  const h = await harness();
  const before = h.raw();
  for (const bad of ['../demo', 'demo.json', 'Demo', 'a/b', 'demo extra', 'nope', '/etc/passwd']) {
    await h.command.handler(bad, h.ctx);
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.raw(), before);
  assert.equal(h.notes.length, 7);
  assert.ok(h.notes.every((n) => n.type === 'error'));
});

test('/preset changes nothing when a preset model is not in the registry', { skip }, async () => {
  const h = await harness({ models: ['prov/main-model', 'prov/coder-model'] }); // reviewer model missing
  const before = h.raw();
  await h.command.handler('demo', h.ctx);
  assert.deepEqual(h.calls, []);
  assert.equal(h.raw(), before);
  assert.equal(h.notes[0].type, 'error');
  assert.match(h.notes[0].message, /prov\/rev-model/);
  assert.match(h.notes[0].message, /not (changed|applied)|nothing/i);
});

test('/preset changes nothing for an invalid or unreadable preset file', { skip }, async () => {
  const h = await harness({ presets: { bad: { main: { model: 'prov/main-model' } }, broken: '{ nope' } });
  const before = h.raw();
  await h.command.handler('bad', h.ctx);
  await h.command.handler('broken', h.ctx);
  assert.deepEqual(h.calls, []);
  assert.equal(h.raw(), before);
  assert.ok(h.notes.every((n) => n.type === 'error'));
});

test('/preset changes nothing when the main model has no credentials', { skip }, async () => {
  const h = await harness({ authFor: () => false });
  const before = h.raw();
  await h.command.handler('demo', h.ctx);
  assert.deepEqual(h.calls, []);
  assert.equal(h.raw(), before);
  assert.match(h.notes[0].message, /auth|credential|key/i);
});

test('/preset writes nothing when Pi refuses the model', { skip }, async () => {
  const h = await harness({ setModelResult: false });
  const before = h.raw();
  await h.command.handler('demo', h.ctx);
  assert.deepEqual(h.calls, [['setModel', 'prov/main-model']]);
  assert.equal(h.raw(), before);
  assert.equal(h.notes[0].type, 'error');
});

test('/preset does not touch the session when the settings merge would fail', { skip }, async () => {
  const h = await harness({ settings: { ...SETTINGS, subagents: { maxThinking: 'low' } } }); // coder low ok, reviewer high over the ceiling
  const before = h.raw();
  await h.command.handler('demo', h.ctx);
  assert.deepEqual(h.calls, []);
  assert.equal(h.raw(), before);
  assert.match(h.notes[0].message, /maxThinking/);
  const bad = await harness({ settings: { ...SETTINGS, subagents: [] } });
  await bad.command.handler('demo', bad.ctx);
  assert.deepEqual(bad.calls, []);
});

test('/preset restores the session when the settings file cannot be written', { skip, timeout: 15000 }, async () => {
  const h = await harness();
  fs.mkdirSync(`${h.settingsFile}.lock`); // Pi holds the lock for longer than we wait
  const before = h.raw();
  await h.command.handler('demo', h.ctx);
  assert.equal(h.raw(), before);
  assert.deepEqual(h.calls, [['setModel', 'prov/main-model'], ['setThinkingLevel', 'medium'], ['setModel', 'old/old-model'], ['setThinkingLevel', 'high']]);
  assert.equal(h.notes[0].type, 'error');
  assert.match(h.notes[0].message, /lock/i);
});

// --- review fixes -------------------------------------------------------------

test('a settings JSON syntax error reports the position, never the file content', { skip }, async () => {
  const { updateSettingsFile, readSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  for (const body of ['{"apiKey": "SECRET-VALUE-123" oops}', '{"apiKey": SECRET-VALUE-123}', 'SECRET-VALUE-123', '{"a": 1,\n  "k": "SECRET-VALUE-123" "x"}']) {
    fs.writeFileSync(file, body);
    for (const run of [() => readSettingsFile(file), () => updateSettingsFile(file, (s) => s)]) {
      await assert.rejects(Promise.resolve().then(run), (e) => {
        assert.doesNotMatch(e.message, /SECRET|oops/);
        assert.match(e.message, /settings\.json/);
        assert.match(e.message, /line \d+ column \d+|position \d+|unknown position/);
        return true;
      });
    }
  }
});

test('a preset JSON syntax error reports the position, never the file content', { skip }, async () => {
  const { loadPreset } = await load();
  const dir = await scratch();
  fs.writeFileSync(path.join(dir, 'leaky.json'), '{"main": "SECRET-VALUE-123" oops}');
  assert.throws(() => loadPreset(dir, 'leaky'), (e) => !/SECRET|oops/.test(e.message) && /leaky/.test(e.message) && /line \d+ column \d+|position \d+/.test(e.message));
});

test('loadPreset refuses a FIFO or a symlink without blocking, and bounds the read', { skip }, async () => {
  const { loadPreset } = await load();
  const dir = await scratch();
  const fifo = path.join(dir, 'pipe.json');
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0, 'mkfifo is needed for this test');
  assert.throws(() => loadPreset(dir, 'pipe'), /regular file/); // must return at once: a blocking open would hang the test
  fs.symlinkSync('/etc/hostname', path.join(dir, 'lnk.json'));
  assert.throws(() => loadPreset(dir, 'lnk'), /regular file|symbolic/);
  // Exactly at the limit is read; one byte over is refused.
  const body = JSON.stringify(PRESET);
  fs.writeFileSync(path.join(dir, 'edge.json'), body + ' '.repeat(64 * 1024 - body.length));
  assert.deepEqual(loadPreset(dir, 'edge'), PRESET);
  fs.writeFileSync(path.join(dir, 'over.json'), body + ' '.repeat(64 * 1024 - body.length + 1));
  assert.throws(() => loadPreset(dir, 'over'), /too large/);
});

test('applyPresetToSettings refuses when a provider override would re-enable a blocked builtin', { skip }, async () => {
  const { applyPresetToSettings, validatePreset } = await load();
  const preset = validatePreset(clone(PRESET));
  const withProvider = (byProvider) => ({ ...clone(SETTINGS), subagents: { ...clone(SETTINGS.subagents), agentOverridesByProvider: byProvider } });
  for (const bad of [
    { openrouter: { researcher: { disabled: false } } },
    { a: { 'evidence-auditor': { disabled: 'no' } }, b: {} },
    { a: { researcher: { disabled: null } } },
  ]) assert.throws(() => applyPresetToSettings(withProvider(bad), 'demo', preset), /agentOverridesByProvider.*disabled/, JSON.stringify(bad));
  // The refusal does not depend on the preset naming agents.
  assert.throws(() => applyPresetToSettings(withProvider({ a: { researcher: { disabled: false } } }), 'demo', validatePreset({ main: PRESET.main })), /agentOverridesByProvider/);
  // Fine: still disabled, an entry that does not mention `disabled`, other agents, other shapes.
  for (const ok of [{ a: { researcher: { disabled: true } } }, { a: { researcher: { model: 'x/y' } } }, { a: { 'kosmos.coder': { disabled: false } } }, { a: 'junk' }, {}]) {
    assert.doesNotThrow(() => applyPresetToSettings(withProvider(ok), 'demo', preset), JSON.stringify(ok));
  }
});

test('a lock that cannot be released never masks the real error, and the others are still released', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  const wedge = () => fs.writeFileSync(path.join(`${file}.lock`, 'stuck'), ''); // rmdir of a non-empty dir fails
  const unwedge = () => fs.rmSync(`${file}.lock`, { recursive: true, force: true });
  await assert.rejects(updateSettingsFile(file, () => { wedge(); throw new Error('boom'); }), (e) => /^boom/.test(e.message) && /could not release settings\.json\.lock/.test(e.message));
  assert.equal(fs.existsSync(`${file}.write-lock`), false, 'the other lock was still released');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  unwedge();
  // After a successful write a release problem is a warning, not a failure.
  const warnings = await updateSettingsFile(file, (s) => { wedge(); return { ...s, b: 2 }; });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /settings\.json\.lock/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 2 });
  assert.equal(fs.existsSync(`${file}.write-lock`), false);
  unwedge();
  assert.deepEqual(await updateSettingsFile(file, (s) => s), []);
});

test('/preset does not report "nothing changed" when the session cannot be put back', { skip }, async () => {
  // Pi refuses to switch back to the previous model.
  const refuse = await harness({ setModelResult: (n) => n === 1 });
  fs.mkdirSync(`${refuse.settingsFile}.lock`);
  const before = refuse.raw();
  await refuse.command.handler('demo', refuse.ctx);
  assert.equal(refuse.raw(), before);
  assert.deepEqual(refuse.calls.filter((c) => c[0] === 'setModel').map((c) => c[1]), ['prov/main-model', 'old/old-model']);
  assert.equal(refuse.notes[0].type, 'error');
  assert.match(refuse.notes[0].message, /could not be switched back/);
  assert.match(refuse.notes[0].message, /prov\/main-model/);
  assert.doesNotMatch(refuse.notes[0].message, /Nothing was changed/);
  // There was no previous model at all.
  const none = await harness({ previousModel: null });
  fs.mkdirSync(`${none.settingsFile}.lock`);
  await none.command.handler('demo', none.ctx);
  assert.match(none.notes[0].message, /no previous model/);
  assert.doesNotMatch(none.notes[0].message, /Nothing was changed/);
  assert.deepEqual(none.calls.filter((c) => c[0] === 'setModel').length, 1);
  // Switching back throws.
  const boom = await harness({ setModelResult: (n) => { if (n === 2) throw new Error('registry gone'); return true; } });
  fs.mkdirSync(`${boom.settingsFile}.lock`);
  await boom.command.handler('demo', boom.ctx);
  assert.match(boom.notes[0].message, /registry gone/);
  assert.doesNotMatch(boom.notes[0].message, /Nothing was changed/);
}, { timeout: 30000 });

// --- contract with the real pi-subagents lease -----------------------------------

const contractOptOut = process.env.PRESET_CONTRACT === 'skip' ? 'skipped by opt-out (PRESET_CONTRACT=skip)' : false;
async function subagentsLease() {
  assert.ok(fs.existsSync(SUBAGENTS_LEASE), `pi-subagents is not installed at ${SUBAGENTS_LEASE}. This test runs its real file-lease.js against our lock; run bin/install-kosmos-pi.sh (or set PI_CODING_AGENT_DIR) before the tests.`);
  return import(pathToFileURL(SUBAGENTS_LEASE).href);
}
const DEAD_PID = 2 ** 22 + 12345;
const leaseDirs = (dir) => fs.readdirSync(dir).filter((f) => /write-lock/.test(f)).sort();
/** A lease dir the way pi-subagents lays it out. */
function writeLease(lock, owner) {
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ hostname: os.hostname(), ...owner }));
}

test('contract: pi-subagents sees our lease as held, and we see theirs as held', { skip: skip || contractOptOut }, async () => {
  const theirs = await subagentsLease();
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');

  // Ours held: their withFileLease cannot take it (single attempt).
  let seen;
  await updateSettingsFile(file, (s) => {
    try { theirs.withFileLease(file, () => {}, 0); seen = 'acquired'; } catch (e) { seen = e instanceof theirs.FileLeaseBusyError ? 'busy' : `other: ${e}`; }
    return s;
  });
  assert.equal(seen, 'busy');
  assert.equal(theirs.withFileLease(file, () => 'ok', 0), 'ok', 'released after the update');

  // Theirs held: we give up without writing, then go through once it is released.
  const release = theirs.tryLease(`${file}.write-lock`);
  assert.equal(typeof release, 'function');
  const beforeTheirs = fs.readFileSync(file, 'utf8');
  await assert.rejects(updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 150 }), /locked/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeTheirs);
  release();
  await updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 1000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 2 });
  assert.deepEqual(leaseDirs(dir), []);
});

test('contract: the owner.json we write is what their tryLease reads', { skip: skip || contractOptOut }, async () => {
  const theirs = await subagentsLease();
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}');
  let owner;
  let mode;
  await updateSettingsFile(file, (s) => { owner = JSON.parse(fs.readFileSync(`${file}.write-lock/owner.json`, 'utf8')); mode = fs.statSync(`${file}.write-lock`).mode & 0o777; return s; });
  assert.match(owner.token, /^[A-Za-z0-9-]{1,64}$/);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.hostname, os.hostname());
  if (process.platform === 'linux') assert.match(owner.processStart, /^\d+$/, 'processStart lets pi-subagents detect PID reuse');
  assert.equal(mode, 0o700);
  // Ours and theirs agree on which process a lease belongs to: theirs does not evict a lease of this live process.
  const alive = { token: 'live-1', pid: process.pid, hostname: os.hostname(), ...(owner.processStart ? { processStart: owner.processStart } : {}) };
  writeLease(`${file}.write-lock`, alive);
  assert.throws(() => theirs.withFileLease(file, () => {}, 0), theirs.FileLeaseBusyError);
  await assert.rejects(updateSettingsFile(file, (s) => s, { timeoutMs: 100 }), /locked/);
});

test('contract: a lease left by a dead pi-subagents process is reclaimed by us, and retired like theirs', { skip: skip || contractOptOut }, async () => {
  const theirs = await subagentsLease();
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { tryLease } from ${JSON.stringify(pathToFileURL(SUBAGENTS_LEASE).href)}; if (!tryLease(${JSON.stringify(`${file}.write-lock`)})) process.exit(3); process.exit(0);`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const token = JSON.parse(fs.readFileSync(`${file}.write-lock/owner.json`, 'utf8')).token;
  await updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 1000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 2 });
  // The dead lease is kept, renamed, as the fence their recovery also leaves.
  assert.deepEqual(leaseDirs(dir), [`settings.json.write-lock.retired-${token}`]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `settings.json.write-lock.retired-${token}`, 'owner.json'), 'utf8')).token, token);
  assert.equal(theirs.withFileLease(file, () => 'ok', 0), 'ok');
});

test('contract: a lease left by our dead process is reclaimed by pi-subagents', { skip: skip || contractOptOut }, async () => {
  const theirs = await subagentsLease();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  const script = `import { updateSettingsFile } from ${JSON.stringify(EXTENSION_URL())}; await updateSettingsFile(${JSON.stringify(file)}, () => process.exit(0));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const owner = JSON.parse(fs.readFileSync(`${file}.write-lock/owner.json`, 'utf8'));
  assert.notEqual(owner.pid, process.pid);
  assert.equal(theirs.withFileLease(file, () => 'reclaimed', 0), 'reclaimed');
  assert.deepEqual(leaseDirs(dir), [`settings.json.write-lock.retired-${owner.token}`]);
  // Pi's lock dir from the dead process is fresh, so neither side may evict it before it goes stale.
  assert.ok(fs.existsSync(`${file}.lock`));
});

function EXTENSION_URL() { return pathToFileURL(EXTENSION).href; }

test('contract: a reused PID (different process start) is a dead owner for both sides', { skip: skip || contractOptOut || (process.platform !== 'linux' && 'needs /proc') }, async () => {
  const theirs = await subagentsLease();
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  const reused = (token) => ({ token, pid: process.pid, processStart: '1' });
  writeLease(`${file}.write-lock`, reused('reuse-theirs'));
  assert.equal(theirs.withFileLease(file, () => 'ok', 0), 'ok');
  fs.rmSync(`${file}.write-lock.retired-reuse-theirs`, { recursive: true });
  writeLease(`${file}.write-lock`, reused('reuse-ours'));
  await updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 1000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, b: 2 });
  assert.deepEqual(leaseDirs(dir), ['settings.json.write-lock.retired-reuse-ours']);
});

test('contract: leases neither side may evict stay held for both', { skip: skip || contractOptOut }, async () => {
  const theirs = await subagentsLease();
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"a":1}');
  const lock = `${file}.write-lock`;
  const cases = {
    'token outside the allowed charset': { token: 'bad token!', pid: DEAD_PID },
    'another host': { token: 'far-away', pid: DEAD_PID, hostname: 'some-other-host.invalid' },
    'unusable pid': { token: 'no-pid', pid: -1 },
  };
  for (const [label, owner] of Object.entries(cases)) {
    writeLease(lock, owner);
    assert.throws(() => theirs.withFileLease(file, () => {}, 0), theirs.FileLeaseBusyError, `theirs: ${label}`);
    await assert.rejects(updateSettingsFile(file, (s) => s, { timeoutMs: 100 }), /locked/, `ours: ${label}`);
    fs.rmSync(lock, { recursive: true });
  }
  // A dead owner whose retired fence already exists: both treat the lease as held and leave the fence alone.
  writeLease(lock, { token: 'fenced-1', pid: DEAD_PID });
  writeLease(`${lock}.retired-fenced-1`, { token: 'fenced-1', pid: DEAD_PID });
  assert.throws(() => theirs.withFileLease(file, () => {}, 0), theirs.FileLeaseBusyError);
  await assert.rejects(updateSettingsFile(file, (s) => s, { timeoutMs: 100 }), /locked/);
  assert.ok(fs.existsSync(`${lock}.retired-fenced-1/owner.json`));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
});

test('stale-lock reclaim that moved a live holder\'s lock re-creates it with mkdir and never overwrites a newer lock', { skip }, async () => {
  const { updateSettingsFile } = await load();
  const dir = await scratch();
  const file = path.join(dir, 'settings.json');
  const lock = `${file}.lock`;
  fs.writeFileSync(file, '{"a":1}');
  const realStat = fs.statSync;
  // The first look at the lock says "stale" (as if it were old when checked); the lock is in fact fresh by the time it is renamed.
  const staleOnce = () => {
    let first = true;
    mock.method(fs, 'statSync', (target, ...rest) => {
      if (first && target === lock) { first = false; return { mtimeMs: Date.now() - 60_000 }; }
      return realStat(target, ...rest);
    });
  };
  const leftovers = () => fs.readdirSync(dir).filter((f) => f.includes('.stale-'));
  try {
    // 1. Nobody else took the name: the live lock is put back (as a new directory) and keeps blocking us.
    fs.mkdirSync(lock);
    staleOnce();
    await assert.rejects(updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 150 }), /locked/);
    mock.restoreAll();
    assert.ok(fs.statSync(lock).isDirectory());
    assert.deepEqual(leftovers(), []);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
    fs.rmdirSync(lock);

    // 2. A newer holder takes the name right after the move: its lock is left alone (EEXIST), not replaced.
    fs.mkdirSync(lock);
    staleOnce();
    let newerIno;
    const realRmdir = fs.rmdirSync;
    mock.method(fs, 'rmdirSync', (target, ...rest) => {
      realRmdir(target, ...rest);
      if (String(target).includes('.stale-') && newerIno === undefined) { fs.mkdirSync(lock); newerIno = realStat(lock).ino; }
    });
    await assert.rejects(updateSettingsFile(file, (s) => ({ ...s, b: 2 }), { timeoutMs: 150 }), /locked/);
    mock.restoreAll();
    assert.ok(newerIno !== undefined);
    assert.equal(fs.statSync(lock).ino, newerIno, 'the newer lock is the one still in place');
    assert.deepEqual(leftovers(), []);
  } finally { mock.restoreAll(); }
});

// --- saving, creating and deleting presets ------------------------------------------

const FAKE_AGENTS = {
  coder: { model: 'm/coder-fm', thinking: 'low' },
  reviewer: { model: 'm/rev-fm', thinking: 'medium' },
};

/** A fake Dotfiles repo: kosmos-pi/agents/*.md, pi/agent/presets/ and pi/agent/settings.json. */
async function fakeRepo({ agents = FAKE_AGENTS, presets = true } = {}) {
  const root = await scratch();
  const agentsDir = path.join(root, 'kosmos-pi', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [name, fm] of Object.entries(agents)) {
    const lines = ['---', `name: ${name}`, 'package: kosmos', 'description: x', ...(fm.model ? [`model: ${fm.model}`] : []), ...(fm.thinking ? [`thinking: ${fm.thinking}`] : []), '---', '', 'body', 'model: not-this-one'];
    fs.writeFileSync(path.join(agentsDir, `${name}.md`), lines.join('\n') + '\n');
  }
  fs.mkdirSync(path.join(root, 'pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pi', 'agent', 'settings.json'), '{}');
  const presetsDir = path.join(root, 'pi', 'agent', 'presets');
  if (presets) fs.mkdirSync(presetsDir);
  return { root, pkg: path.join(root, 'kosmos-pi'), agentsDir, presetsDir };
}

const SAVE_MODELS = ['old/old-model', 'old/m', 'm/rev-fm', 'm/coder-fm', 'prov/main-model', 'prov/coder-model', 'prov/rev-model'];
const withRepo = (repo, extra = {}) => ({ ...clone(SETTINGS), packages: ['npm:a', `file:${repo.pkg}`], ...extra });

/** Replace the UI dialogs of a harness by a script; an answer is a value or a function of { title, options, message }. */
function script(h, answers) {
  const prompts = [];
  for (const kind of ['select', 'input', 'confirm']) {
    h.ctx.ui[kind] = async (title, second) => {
      const entry = { kind, title, ...(Array.isArray(second) ? { options: second } : { message: second }) };
      prompts.push(entry);
      if (answers.length === 0) throw new Error(`unexpected ${kind} prompt: ${title}`);
      const answer = answers.shift();
      return typeof answer === 'function' ? answer(entry) : answer;
    };
  }
  return prompts;
}

const EXPECTED_SAVED = {
  description: 'my desc',
  main: { model: 'old/old-model', thinking: 'high' },
  agents: { 'kosmos.coder': { model: 'old/m', thinking: 'high' }, 'kosmos.reviewer': { model: 'm/rev-fm', thinking: 'medium' } },
};

test('reserved subcommand names are not preset names', { skip }, async () => {
  const { isValidPresetName, RESERVED_NAMES, loadPreset } = await load();
  assert.deepEqual([...RESERVED_NAMES].sort(), ['delete', 'new', 'save']);
  for (const name of RESERVED_NAMES) assert.equal(isValidPresetName(name), false, name);
  for (const ok of ['saved', 'new-york', 'delete_me', 'mysave', 'newer']) assert.equal(isValidPresetName(ok), true, ok);
  assert.throws(() => loadPreset('/nonexistent', 'save'), /reserved/);
});

test('presetToJson writes the shipped format byte for byte', { skip }, async () => {
  const { presetToJson, loadPreset, validatePreset } = await load();
  for (const name of ['minimax', 'mimo']) {
    assert.equal(presetToJson(loadPreset(PRESETS, name)), fs.readFileSync(path.join(PRESETS, `${name}.json`), 'utf8'), name);
  }
  // Key order is fixed whatever the order of the input object, and a missing description is left out.
  const text = presetToJson(validatePreset({ agents: { x: { thinking: 'low', model: 'a/b' } }, main: { thinking: 'low', model: 'a/b' } }));
  assert.deepEqual(Object.keys(JSON.parse(text)), ['main', 'agents']);
  assert.deepEqual(Object.keys(JSON.parse(text).main), ['model', 'thinking']);
  assert.deepEqual(Object.keys(JSON.parse(text).agents.x), ['model', 'thinking']);
  assert.ok(text.endsWith('}\n'));
});

test('parseAgentFrontmatter reads the top-level keys of the frontmatter only', { skip }, async () => {
  const { parseAgentFrontmatter } = await load();
  const text = '---\nname: coder\npackage: kosmos\nmodel: "minimax/M"\nthinking: \'low\'\ntoolBudget: {"soft": 1}\nextra:\n  model: nested\n---\n\nmodel: from-body\nthinking: high\n';
  assert.deepEqual(parseAgentFrontmatter(text), { name: 'coder', package: 'kosmos', model: 'minimax/M', thinking: 'low' });
  assert.deepEqual(parseAgentFrontmatter('---\r\nname: a\r\nmodel: x/y\r\n---\r\n'), { name: 'a', model: 'x/y' });
  assert.deepEqual(parseAgentFrontmatter('no frontmatter\nname: a'), {});
  assert.deepEqual(parseAgentFrontmatter('---\nname: a\nmodel: never closed'), {});
});

test('readKosmosAgents lists the runtime names with their frontmatter model and thinking', { skip }, async () => {
  const { readKosmosAgents } = await load();
  const repo = await fakeRepo({ agents: { ...FAKE_AGENTS, bare: { model: 'm/x' } } });
  fs.writeFileSync(path.join(repo.agentsDir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(repo.agentsDir, 'nameless.md'), '---\nmodel: a/b\n---\n');
  const agents = readKosmosAgents(repo.agentsDir);
  assert.deepEqual(agents.map((a) => a.name), ['kosmos.bare', 'kosmos.coder', 'kosmos.reviewer']);
  assert.deepEqual(agents.find((a) => a.name === 'kosmos.coder'), { name: 'kosmos.coder', model: 'm/coder-fm', thinking: 'low' });
  assert.deepEqual(agents.find((a) => a.name === 'kosmos.bare'), { name: 'kosmos.bare', model: 'm/x' });
  assert.throws(() => readKosmosAgents(path.join(repo.root, 'missing')), /agents/);
  // The real agents of this repo: every one has a runtime name and, today, both fields.
  const real = readKosmosAgents(AGENTS);
  assert.deepEqual(real.map((a) => a.name).sort(), Object.keys(loadPresetSync('minimax').agents).sort());
});
function loadPresetSync(name) { return JSON.parse(fs.readFileSync(path.join(PRESETS, `${name}.json`), 'utf8')); }

test('findKosmosPackageDir takes the absolute file: entry that ends in kosmos-pi', { skip }, async () => {
  const { findKosmosPackageDir } = await load();
  const find = (packages) => findKosmosPackageDir({ packages });
  assert.equal(find(['npm:x', 'file:/home/u/Dotfiles/kosmos-pi']), '/home/u/Dotfiles/kosmos-pi');
  assert.equal(find(['file:/home/u/Dotfiles/kosmos-pi/']), '/home/u/Dotfiles/kosmos-pi');
  assert.equal(find(['file:/a/other', 'file:/b/kosmos-pi', 'file:/c/kosmos-pi']), '/b/kosmos-pi');
  for (const none of [[], ['file:kosmos-pi'], ['file:./x/kosmos-pi'], ['file:/a/kosmos-pi-2'], ['npm:kosmos-pi'], [5, null, {}], 'file:/a/kosmos-pi', undefined]) {
    assert.equal(find(none), undefined, JSON.stringify(none));
  }
  assert.equal(findKosmosPackageDir({}), undefined);
});

test('locatePresetStores derives the repo store and refuses anything that is not a real directory', { skip }, async () => {
  const { locatePresetStores } = await load();
  const agentDir = await scratch();
  const repo = await fakeRepo();
  const settings = { packages: [`file:${repo.pkg}`] };
  const ok = locatePresetStores(settings, agentDir);
  assert.equal(ok.local, path.join(agentDir, 'presets'));
  assert.equal(ok.repo, repo.presetsDir);
  assert.equal(ok.agentsDir, repo.agentsDir);
  assert.equal(ok.repoProblem, undefined);

  // No file: entry: local only, the agents come from the installed package copy when there is one.
  const none = locatePresetStores({}, agentDir);
  assert.equal(none.repo, undefined);
  assert.match(none.repoProblem, /kosmos-pi/);
  assert.equal(none.agentsDir, undefined);
  const installed = path.join(agentDir, 'npm', 'node_modules', 'kosmos-pi', 'agents');
  fs.mkdirSync(installed, { recursive: true });
  assert.equal(locatePresetStores({}, agentDir).agentsDir, installed);

  // The presets dir is missing, a symlink, or a file.
  const missing = await fakeRepo({ presets: false });
  assert.equal(locatePresetStores({ packages: [`file:${missing.pkg}`] }, agentDir).repo, undefined);
  assert.match(locatePresetStores({ packages: [`file:${missing.pkg}`] }, agentDir).repoProblem, /presets/);
  const linked = await fakeRepo({ presets: false });
  const elsewhere = await scratch();
  fs.symlinkSync(elsewhere, linked.presetsDir);
  const viaLink = locatePresetStores({ packages: [`file:${linked.pkg}`] }, agentDir);
  assert.equal(viaLink.repo, undefined);
  assert.match(viaLink.repoProblem, /symbolic link|symlink/);
  const asFile = await fakeRepo({ presets: false });
  fs.writeFileSync(asFile.presetsDir, 'x');
  assert.equal(locatePresetStores({ packages: [`file:${asFile.pkg}`] }, agentDir).repo, undefined);
  // A path that does not look like the Dotfiles repo (no pi/agent/settings.json next to kosmos-pi) is not trusted.
  const stranger = await scratch();
  fs.mkdirSync(path.join(stranger, 'kosmos-pi', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(stranger, 'pi', 'agent', 'presets'), { recursive: true });
  assert.equal(locatePresetStores({ packages: [`file:${path.join(stranger, 'kosmos-pi')}`] }, agentDir).repo, undefined);
});

test('snapshotPreset: the override wins, then the frontmatter, and the result is always complete', { skip }, async () => {
  const { snapshotPreset, validatePreset } = await load();
  const agents = [{ name: 'kosmos.coder', model: 'm/coder-fm', thinking: 'low' }, { name: 'kosmos.reviewer', model: 'm/rev-fm', thinking: 'medium' }, { name: 'kosmos.plain', model: 'm/p' }];
  const settings = { subagents: { defaultThinking: 'medium', agentOverrides: { 'kosmos.coder': { model: 'o/c', tools: ['read'] }, 'kosmos.reviewer': { thinking: 'high' }, researcher: { disabled: true } } } };
  const main = { model: 'a/b', thinking: 'low' };
  const p = snapshotPreset({ main, agents, settings, description: 'd' });
  assert.deepEqual(p, validatePreset({ description: 'd', main, agents: {
    'kosmos.coder': { model: 'o/c', thinking: 'low' },
    'kosmos.reviewer': { model: 'm/rev-fm', thinking: 'high' },
    'kosmos.plain': { model: 'm/p', thinking: 'medium' }, // thinking from subagents.defaultThinking
  } }));
  assert.equal(snapshotPreset({ main, agents, settings }).description, undefined);
  // Unknown to settings and frontmatter: say which agent and which field, instead of saving an incomplete preset.
  assert.throws(() => snapshotPreset({ main, agents: [{ name: 'kosmos.x', thinking: 'low' }], settings: {} }), /kosmos\.x.*model/);
  assert.throws(() => snapshotPreset({ main, agents: [{ name: 'kosmos.x', model: 'a/b' }], settings: {} }), /kosmos\.x.*thinking/);
  assert.throws(() => snapshotPreset({ main, agents: [{ name: 'kosmos.x', model: 'inherit', thinking: 'low' }], settings: {} }), /kosmos\.x/);
  assert.throws(() => snapshotPreset({ main, agents: [{ name: 'kosmos.x', model: 'a/b', thinking: 'low' }], settings: { subagents: { agentOverrides: { 'kosmos.x': { thinking: false } } } } }), /kosmos\.x.*thinking/);
  assert.throws(() => snapshotPreset({ main: { model: 'bad', thinking: 'low' }, agents, settings }), /model/);
  assert.throws(() => snapshotPreset({ main, agents: [], settings }), /no agents/i);
  assert.throws(() => snapshotPreset({ main, agents, settings, description: 'a\nb' }), /description/);
});

test('choiceList puts the current value first and marks it', { skip }, async () => {
  const { choiceList } = await load();
  assert.deepEqual(choiceList(['a', 'b', 'c'], 'b'), [{ label: 'b (current)', value: 'b' }, { label: 'a', value: 'a' }, { label: 'c', value: 'c' }]);
  assert.deepEqual(choiceList(['a', 'b'], undefined), [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]);
  // A current value that is not on offer is still offered, first, with the reason.
  assert.deepEqual(choiceList(['a'], 'z', 'not available'), [{ label: 'z (current, not available)', value: 'z' }, { label: 'a', value: 'a' }]);
  assert.deepEqual(choiceList(['a', 'a'], 'a').map((c) => c.value), ['a']);
});

test('writePresetFiles writes every store atomically, with the shipped file mode', { skip }, async () => {
  const { writePresetFiles } = await load();
  const one = await scratch();
  const two = await scratch();
  const written = writePresetFiles([one, two], 'mine', '{"a":1}\n');
  assert.deepEqual(written, [path.join(one, 'mine.json'), path.join(two, 'mine.json')]);
  for (const dir of [one, two]) {
    assert.equal(fs.readFileSync(path.join(dir, 'mine.json'), 'utf8'), '{"a":1}\n');
    assert.equal(fs.statSync(path.join(dir, 'mine.json')).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(dir), ['mine.json'], 'no temp file left');
  }
  writePresetFiles([one, two], 'mine', '{"a":2}\n');
  assert.equal(fs.readFileSync(path.join(two, 'mine.json'), 'utf8'), '{"a":2}\n');
});

test('writePresetFiles refuses an unsafe target and then changes no store', { skip }, async () => {
  const { writePresetFiles } = await load();
  const one = await scratch();
  const two = await scratch();
  fs.writeFileSync(path.join(one, 'mine.json'), 'ONE');
  // A symlink at the target in the second store: it is neither followed nor replaced.
  const secret = path.join(await scratch(), 'secret.txt');
  fs.writeFileSync(secret, 'SECRET');
  fs.symlinkSync(secret, path.join(two, 'mine.json'));
  assert.throws(() => writePresetFiles([one, two], 'mine', 'NEW'), /symbolic link|not a regular file/);
  assert.equal(fs.readFileSync(path.join(one, 'mine.json'), 'utf8'), 'ONE', 'the first store is untouched too');
  assert.equal(fs.readFileSync(secret, 'utf8'), 'SECRET');
  assert.ok(fs.lstatSync(path.join(two, 'mine.json')).isSymbolicLink());
  // A directory at the target, a store that is a symlink or missing, an unsafe name.
  fs.rmSync(path.join(two, 'mine.json'));
  fs.mkdirSync(path.join(two, 'mine.json'));
  assert.throws(() => writePresetFiles([one, two], 'mine', 'NEW'), /not a regular file/);
  fs.rmdirSync(path.join(two, 'mine.json'));
  const linkedStore = path.join(await scratch(), 'store');
  fs.symlinkSync(two, linkedStore);
  assert.throws(() => writePresetFiles([one, linkedStore], 'mine', 'NEW'), /symbolic link/);
  assert.throws(() => writePresetFiles([one, path.join(one, 'nope')], 'mine', 'NEW'), /store|directory|exist/i);
  for (const bad of ['../x', 'Mine', 'save', 'a/b', '']) assert.throws(() => writePresetFiles([one], bad, 'NEW'), /name/i, bad);
  assert.equal(fs.readFileSync(path.join(one, 'mine.json'), 'utf8'), 'ONE');
  assert.deepEqual(fs.readdirSync(one), ['mine.json'], 'no temp file left');
  assert.deepEqual(fs.readdirSync(two), [], 'no temp file left');
});

test('removePresetFiles deletes regular files only', { skip }, async () => {
  const { removePresetFiles } = await load();
  const one = await scratch();
  const two = await scratch();
  fs.writeFileSync(path.join(one, 'mine.json'), '1');
  assert.deepEqual(removePresetFiles([one, two], 'mine'), [path.join(one, 'mine.json')]);
  assert.deepEqual(fs.readdirSync(one), []);
  fs.mkdirSync(path.join(one, 'dir.json'));
  assert.throws(() => removePresetFiles([one], 'dir'), /not a regular file/);
  const target = path.join(await scratch(), 't');
  fs.writeFileSync(target, 'T');
  fs.symlinkSync(target, path.join(one, 'ln.json'));
  assert.throws(() => removePresetFiles([one], 'ln'), /not a regular file|symbolic/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'T');
  assert.throws(() => removePresetFiles([one], '../x'), /name/i);
});

test('/preset save snapshots the session, the overrides and the frontmatter into both stores', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  const prompts = script(h, ['  my desc  ', false]);
  await h.command.handler('save mine', h.ctx);
  const { presetToJson, validatePreset } = await load();
  const expected = presetToJson(validatePreset(clone(EXPECTED_SAVED)));
  for (const dir of [repo.presetsDir, h.presetsDir]) assert.equal(fs.readFileSync(path.join(dir, 'mine.json'), 'utf8'), expected, dir);
  assert.deepEqual(prompts.map((p) => p.kind), ['input', 'confirm']);
  assert.match(prompts[0].title, /description/i);
  assert.match(prompts[1].title, /apply/i);
  assert.deepEqual(h.calls, [], 'declining the offer applies nothing');
  const settingsAfter = h.read();
  assert.equal(settingsAfter.kosmosActivePreset, undefined);
  assert.equal(h.notes.at(-1).type, 'info');
  assert.match(h.notes.at(-1).message, /mine/);
  assert.ok(h.notes.at(-1).message.includes(repo.presetsDir), 'the notice names the repo copy');
  assert.doesNotMatch(h.notes.at(-1).message, /install-kosmos-pi/);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), ['mine.json']);
});

test('/preset save allows an empty description and then applies it when asked', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  script(h, ['', true]);
  await h.command.handler('save mine', h.ctx);
  const saved = JSON.parse(fs.readFileSync(path.join(h.presetsDir, 'mine.json'), 'utf8'));
  assert.equal('description' in saved, false);
  assert.deepEqual(h.calls, [['setModel', 'old/old-model'], ['setThinkingLevel', 'high']]);
  assert.equal(h.read().kosmosActivePreset, 'mine');
  assert.equal(h.read().subagents.agentOverrides['kosmos.reviewer'].model, 'm/rev-fm');
});

test('/preset save writes only the local store, and warns, when the repo cannot be derived', { skip }, async () => {
  const repo = await fakeRepo();
  const installed = (agentDir) => { const d = path.join(agentDir, 'npm', 'node_modules', 'kosmos-pi'); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.symlinkSync(repo.pkg, d); };
  // 1. No file: entry in packages, agents found through the installed package.
  const noEntry = await harness({ settings: clone(SETTINGS), models: SAVE_MODELS });
  installed(noEntry.agentDir);
  script(noEntry, ['', false]);
  await noEntry.command.handler('save mine', noEntry.ctx);
  assert.ok(fs.existsSync(path.join(noEntry.presetsDir, 'mine.json')));
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
  assert.equal(noEntry.notes.at(-1).type, 'warning');
  assert.match(noEntry.notes.at(-1).message, /install-kosmos-pi\.sh/);
  assert.match(noEntry.notes.at(-1).message, /delet/);
  // 2. The repo presets dir is a symlink.
  const linked = await fakeRepo({ presets: false });
  fs.symlinkSync(await scratch(), linked.presetsDir);
  const viaLink = await harness({ settings: withRepo(linked), models: SAVE_MODELS });
  script(viaLink, ['', false]);
  await viaLink.command.handler('save mine', viaLink.ctx);
  assert.ok(fs.existsSync(path.join(viaLink.presetsDir, 'mine.json')));
  assert.deepEqual(fs.readdirSync(fs.realpathSync(linked.presetsDir)), []);
  assert.match(viaLink.notes.at(-1).message, /install-kosmos-pi\.sh/);
});

test('/preset save writes nothing when the agents cannot be found or are incomplete', { skip }, async () => {
  // No kosmos-pi anywhere.
  const lost = await harness({ settings: clone(SETTINGS), models: SAVE_MODELS });
  script(lost, []);
  await lost.command.handler('save mine', lost.ctx);
  assert.deepEqual(fs.readdirSync(lost.presetsDir), ['demo.json']);
  assert.equal(lost.notes[0].type, 'error');
  assert.match(lost.notes[0].message, /kosmos-pi/);
  // An agent without model and thinking anywhere.
  const repo = await fakeRepo({ agents: { coder: { thinking: 'low' }, reviewer: FAKE_AGENTS.reviewer } });
  const h = await harness({ settings: withRepo(repo, { subagents: { agentOverrides: {} } }), models: SAVE_MODELS });
  script(h, []);
  await h.command.handler('save mine', h.ctx);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
  assert.deepEqual(fs.readdirSync(h.presetsDir), ['demo.json']);
  assert.match(h.notes[0].message, /kosmos\.coder.*model/);
  // No current model.
  const bare = await harness({ settings: withRepo(repo), models: SAVE_MODELS, previousModel: null });
  script(bare, []);
  await bare.command.handler('save mine', bare.ctx);
  assert.match(bare.notes[0].message, /no model|current model/i);
  assert.deepEqual(fs.readdirSync(h.presetsDir), ['demo.json']);
});

test('/preset save with a bad name, extra words or no name writes nothing', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  const prompts = script(h, []);
  for (const args of ['save', 'save ', 'save Mine', 'save ../x', 'save a b', 'save save', 'save new', 'save delete', 'save a.json']) await h.command.handler(args, h.ctx);
  assert.equal(prompts.length, 0);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
  assert.deepEqual(fs.readdirSync(h.presetsDir), ['demo.json']);
  assert.equal(h.notes.length, 9);
  assert.ok(h.notes.every((n) => n.type === 'error'));
  assert.match(h.notes[0].message, /usage|name/i);
});

test('/preset save asks before overwriting, and a no writes nothing', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS, presets: { demo: PRESET } });
  fs.writeFileSync(path.join(repo.presetsDir, 'demo.json'), 'REPO-COPY');
  const prompts = script(h, [false]);
  await h.command.handler('save demo', h.ctx);
  assert.deepEqual(prompts.map((p) => p.kind), ['confirm']);
  assert.match(prompts[0].title + (prompts[0].message ?? ''), /demo/);
  assert.match(prompts[0].title + (prompts[0].message ?? ''), /overwrit|replace/i);
  assert.equal(fs.readFileSync(path.join(repo.presetsDir, 'demo.json'), 'utf8'), 'REPO-COPY');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.presetsDir, 'demo.json'), 'utf8')), PRESET);
  // A yes goes on to the description, and replaces both copies. The copy that exists in one store only counts too.
  fs.rmSync(path.join(repo.presetsDir, 'demo.json'));
  script(h, [true, 'again', false]);
  await h.command.handler('save demo', h.ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo.presetsDir, 'demo.json'), 'utf8')).description, 'again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.presetsDir, 'demo.json'), 'utf8')).description, 'again');
});

test('/preset save: cancelling the description, or giving an unusable one, writes nothing', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  script(h, [undefined]);
  await h.command.handler('save mine', h.ctx);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
  assert.match(h.notes.at(-1).message, /cancel/i);
  // An unusable description is asked again with the reason, and a cancel there still aborts.
  const again = script(h, ['bad\u001b[31mline', undefined]);
  await h.command.handler('save mine', h.ctx);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
  assert.deepEqual(fs.readdirSync(h.presetsDir), ['demo.json']);
  assert.equal(again.length, 2);
  assert.match(again[1].title, /one line.*control characters/);
  assert.match(h.notes.at(-1).message, /cancel/i);
  // Without an interactive UI there is nobody to ask.
  h.ctx.hasUI = false;
  const prompts = script(h, []);
  await h.command.handler('save mine', h.ctx);
  assert.equal(prompts.length, 0);
  assert.match(h.notes.at(-1).message, /interactive/i);
});

test('/preset new walks the picker for main and every agent and saves the result', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS, authFor: (m) => !(m.provider === 'old' && m.id === 'm') });
  const pick = (value) => ({ options }) => { const hit = options.find((o) => o === value || o.startsWith(`${value} (`)); assert.ok(hit, `${value} offered in ${JSON.stringify(options)}`); return hit; };
  const prompts = script(h, [
    'picked',
    pick('prov/main-model'), pick('xhigh'),
    pick('prov/coder-model'), pick('low'),
    pick('old/old-model'), pick('medium'),
    false,
  ]);
  await h.command.handler('new mine', h.ctx);
  // The description comes first, so a bad one is found before the 12 selections, not after.
  assert.deepEqual(prompts.map((p) => p.kind), ['input', 'select', 'select', 'select', 'select', 'select', 'select', 'confirm']);
  prompts.shift();
  const saved = JSON.parse(fs.readFileSync(path.join(h.presetsDir, 'mine.json'), 'utf8'));
  assert.deepEqual(saved, {
    description: 'picked',
    main: { model: 'prov/main-model', thinking: 'xhigh' },
    agents: { 'kosmos.coder': { model: 'prov/coder-model', thinking: 'low' }, 'kosmos.reviewer': { model: 'old/old-model', thinking: 'medium' } },
  });
  assert.equal(fs.readFileSync(path.join(repo.presetsDir, 'mine.json'), 'utf8'), fs.readFileSync(path.join(h.presetsDir, 'mine.json'), 'utf8'));
  // Titles say what is being chosen; the current value is first and marked.
  assert.match(prompts[0].title, /main/i);
  assert.match(prompts[0].title, /model/i);
  assert.equal(prompts[0].options[0], 'old/old-model (current)');
  assert.deepEqual(prompts[0].options.slice(1).sort(), SAVE_MODELS.filter((m) => m !== 'old/old-model' && m !== 'old/m').sort());
  assert.equal(prompts[1].options[0], 'high (current)');
  assert.deepEqual(prompts[1].options.slice(1), ['off', 'minimal', 'low', 'medium', 'xhigh', 'max']);
  assert.match(prompts[2].title, /kosmos\.coder/);
  assert.equal(prompts[2].options[0], 'old/m (current, not available)', 'the effective override is offered even if Pi cannot use it right now');
  assert.equal(prompts[3].options[0], 'high (current)');
  // Agents are capped by subagents.maxThinking (high), the main session is not.
  assert.deepEqual(prompts[3].options.slice(1), ['off', 'minimal', 'low', 'medium']);
  assert.match(prompts[4].title, /kosmos\.reviewer/);
  assert.equal(prompts[4].options[0], 'm/rev-fm (current)');
});

test('/preset new offers only models with credentials', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS, authFor: (m) => m.provider !== 'prov' });
  const prompts = script(h, ['', () => undefined]);
  await h.command.handler('new mine', h.ctx);
  prompts.shift();
  assert.ok(prompts[0].options.every((o) => !o.startsWith('prov/')));
  assert.ok(prompts[0].options.length >= 3);
  const none = await harness({ settings: withRepo(repo), models: SAVE_MODELS, authFor: () => false });
  const quiet = script(none, []);
  await none.command.handler('new mine', none.ctx);
  assert.equal(quiet.length, 0);
  assert.match(none.notes[0].message, /no models|credentials/i);
});

test('/preset new: cancelling any prompt aborts and writes nothing', { skip }, async () => {
  const repo = await fakeRepo();
  const first = ({ options }) => options[0];
  // The description and the 6 selects can each be the one that is cancelled.
  for (let cancelAt = 0; cancelAt < 7; cancelAt += 1) {
    const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
    const answers = ['d', first, first, first, first, first, first];
    answers[cancelAt] = undefined;
    const prompts = script(h, answers);
    await h.command.handler('new mine', h.ctx);
    assert.equal(prompts.length, cancelAt + 1, `stops at prompt ${cancelAt}`);
    assert.deepEqual(fs.readdirSync(repo.presetsDir), [], `cancel at ${cancelAt}`);
    assert.deepEqual(fs.readdirSync(h.presetsDir), ['demo.json']);
    assert.deepEqual(h.calls, []);
    assert.match(h.notes.at(-1).message, /cancel/i);
    assert.notEqual(h.notes.at(-1).type, 'error');
  }
});

test('/preset new asks before overwriting, before it starts the picker', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  const prompts = script(h, [false]);
  await h.command.handler('new demo', h.ctx);
  assert.deepEqual(prompts.map((p) => p.kind), ['confirm']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.presetsDir, 'demo.json'), 'utf8')), PRESET);
  const bad = script(h, []);
  await h.command.handler('new Bad/Name', h.ctx);
  await h.command.handler('new', h.ctx);
  assert.equal(bad.length, 0);
});

test('/preset delete confirms, then removes both copies', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), presets: { demo: PRESET, keep: PRESET } });
  for (const dir of [repo.presetsDir]) { fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify(PRESET)); fs.writeFileSync(path.join(dir, 'keep.json'), JSON.stringify(PRESET)); }
  const no = script(h, [false]);
  await h.command.handler('delete demo', h.ctx);
  assert.equal(no[0].kind, 'confirm');
  assert.match(no[0].title + no[0].message, /demo/);
  assert.ok((no[0].title + no[0].message).includes(repo.presetsDir), 'the confirmation names the repo copy');
  assert.ok(fs.existsSync(path.join(h.presetsDir, 'demo.json')) && fs.existsSync(path.join(repo.presetsDir, 'demo.json')));
  script(h, [true]);
  await h.command.handler('delete demo', h.ctx);
  assert.deepEqual(fs.readdirSync(h.presetsDir), ['keep.json']);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), ['keep.json']);
  assert.equal(h.notes.at(-1).type, 'info');
  assert.doesNotMatch(h.notes.at(-1).message, /install-kosmos-pi/);
});

test('/preset delete refuses the active preset, unknown and unsafe names', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo, { kosmosActivePreset: 'demo' }) });
  fs.writeFileSync(path.join(repo.presetsDir, 'demo.json'), JSON.stringify(PRESET));
  const prompts = script(h, []);
  for (const args of ['delete demo', 'delete nope', 'delete ../demo', 'delete Demo', 'delete', 'delete save', 'delete demo extra']) await h.command.handler(args, h.ctx);
  assert.equal(prompts.length, 0, 'refused before asking');
  assert.ok(fs.existsSync(path.join(h.presetsDir, 'demo.json')) && fs.existsSync(path.join(repo.presetsDir, 'demo.json')));
  assert.equal(h.notes.length, 7);
  assert.ok(h.notes.every((n) => n.type === 'error'));
  assert.match(h.notes[0].message, /active/);
});

test('/preset delete from the local store only warns that an install brings a repo copy back', { skip }, async () => {
  const h = await harness({ settings: clone(SETTINGS) });
  script(h, [true]);
  await h.command.handler('delete demo', h.ctx);
  assert.deepEqual(fs.readdirSync(h.presetsDir), []);
  assert.equal(h.notes.at(-1).type, 'warning');
  assert.match(h.notes.at(-1).message, /repo/i);
  assert.match(h.notes.at(-1).message, /install-kosmos-pi\.sh/);
});

test('/preset completes subcommands, and preset names after delete', { skip }, async () => {
  const h = await harness({ presets: { demo: PRESET, minimax: PRESET, broken: '{ nope' } });
  const values = async (prefix) => ((await h.command.getArgumentCompletions(prefix)) ?? []).map((i) => i.value);
  assert.deepEqual(await values(''), ['demo', 'minimax', 'save', 'new', 'delete']);
  assert.deepEqual(await values('de'), ['demo', 'delete']);
  assert.deepEqual(await values('s'), ['save']);
  assert.deepEqual(await values('delete '), ['delete demo', 'delete minimax']);
  assert.deepEqual(await values('delete mi'), ['delete minimax']);
  assert.deepEqual(await values('delete x'), []);
  assert.deepEqual(await values('save '), []);
  assert.deepEqual(await values('new '), []);
  assert.deepEqual(await values('demo '), []);
  assert.deepEqual(await values('delete ../'), []);
  assert.deepEqual(await values('zzz'), []);
});

test('/preset save: an unusable description is asked again, then accepted', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  const prompts = script(h, ['x'.repeat(201), 'bad\nline', '  fine  ', false]);
  await h.command.handler('save mine', h.ctx);
  assert.deepEqual(prompts.map((p) => p.kind), ['input', 'input', 'input', 'confirm']);
  assert.match(prompts[1].title, /200 characters/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.presetsDir, 'mine.json'), 'utf8')).description, 'fine');
  // Same rule as validatePreset: no second copy of it.
  const { validatePreset } = await load();
  for (const bad of ['x'.repeat(201), 'a\nb', 'a\u2028b']) assert.throws(() => validatePreset({ main: PRESET.main, description: bad }), /one line.*control characters/);
});

test('/preset new: a bad description is found before the selections', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  const prompts = script(h, ['bad\nline', undefined]);
  await h.command.handler('new mine', h.ctx);
  assert.deepEqual(prompts.map((p) => p.kind), ['input', 'input']);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
});

test('/preset save and new report "saved but not applied" when applying the new preset fails', { skip }, async () => {
  const repo = await fakeRepo();
  // old/m is in no registry here, so applying the saved preset fails after it was written.
  const h = await harness({ settings: withRepo(repo), models: ['old/old-model', 'm/rev-fm'] });
  script(h, ['', true]);
  await h.command.handler('save mine', h.ctx);
  assert.ok(fs.existsSync(path.join(h.presetsDir, 'mine.json')) && fs.existsSync(path.join(repo.presetsDir, 'mine.json')));
  assert.deepEqual(h.calls, []);
  const last = h.notes.at(-1);
  assert.equal(last.type, 'error');
  assert.match(last.message, /^Preset mine was saved but not applied: .*old\/m/);
  assert.doesNotMatch(last.message, /Nothing was changed/);
  assert.equal(h.read().kosmosActivePreset, undefined);
  // The same through `new`.
  const n = await harness({ settings: withRepo(repo), models: ['old/old-model', 'm/rev-fm', 'old/m'], setModelResult: false });
  const first = ({ options }) => options[0];
  script(n, ['', first, first, first, first, first, first, true]);
  await n.command.handler('new second', n.ctx);
  assert.ok(fs.existsSync(path.join(n.presetsDir, 'second.json')));
  assert.match(n.notes.at(-1).message, /^Preset second was saved but not applied: /);
  assert.doesNotMatch(n.notes.at(-1).message, /Nothing was changed/);
});

test('snapshotPreset and applyPresetToSettings share one maxThinking rule', { skip }, async () => {
  const { snapshotPreset, applyPresetToSettings, validatePreset } = await load();
  const main = { model: 'a/b', thinking: 'max' }; // the main session is not capped
  const settings = { subagents: { maxThinking: 'medium', agentOverrides: { 'kosmos.over': { thinking: 'high' } } } };
  const agents = [{ name: 'kosmos.over', model: 'a/b', thinking: 'low' }, { name: 'kosmos.fm', model: 'a/b', thinking: 'xhigh' }];
  let saveError;
  assert.throws(() => snapshotPreset({ main, agents: [agents[0]], settings }), (e) => { saveError = e.message; return /kosmos\.over.*thinking high.*maxThinking \(medium\)/.test(e.message); });
  assert.throws(() => snapshotPreset({ main, agents: [agents[1]], settings }), /kosmos\.fm.*thinking xhigh.*maxThinking/);
  // At and below the ceiling is fine; without a ceiling anything goes.
  assert.doesNotThrow(() => snapshotPreset({ main, agents: [{ name: 'kosmos.x', model: 'a/b', thinking: 'medium' }], settings }));
  assert.doesNotThrow(() => snapshotPreset({ main, agents: [agents[1]], settings: {} }));
  // The apply side says the same thing for the same agent, level and ceiling.
  const preset = validatePreset({ main, agents: { 'kosmos.over': { thinking: 'high' } } });
  assert.throws(() => applyPresetToSettings({ subagents: { maxThinking: 'medium' } }, 'x', preset), (e) => saveError.startsWith(e.message));
});

test('/preset save writes nothing when an agent is above subagents.maxThinking', { skip }, async () => {
  const repo = await fakeRepo({ agents: { coder: { model: 'm/c', thinking: 'xhigh' }, reviewer: FAKE_AGENTS.reviewer } });
  const h = await harness({ settings: withRepo(repo, { subagents: { maxThinking: 'high', agentOverrides: {} } }), models: SAVE_MODELS });
  const prompts = script(h, []);
  await h.command.handler('save mine', h.ctx);
  assert.equal(prompts.length, 0);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
  assert.match(h.notes[0].message, /kosmos\.coder.*xhigh.*maxThinking/);
});

test('/preset delete says how a committed repo copy is restored, and that an uncommitted one is lost', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo) });
  fs.writeFileSync(path.join(repo.presetsDir, 'demo.json'), JSON.stringify(PRESET));
  const both = script(h, [false]);
  await h.command.handler('delete demo', h.ctx);
  const text = both[0].message;
  assert.match(text, /tracked by git/);
  assert.ok(text.includes(`git checkout -- ${path.join(repo.presetsDir, 'demo.json')}`));
  assert.match(text, /uncommitted copy cannot be recovered/);
  // No repo copy to delete, no git line.
  fs.rmSync(path.join(repo.presetsDir, 'demo.json'));
  const local = script(h, [false]);
  await h.command.handler('delete demo', h.ctx);
  assert.doesNotMatch(local[0].message, /git/);
});

test('one directory reached twice is written, listed and deleted once', { skip }, async () => {
  const { writePresetFiles, existingCopies, removePresetFiles, uniqueDirs } = await load();
  const dir = await scratch();
  const alias = path.join(dir, '..', path.basename(dir));
  const linkParent = await scratch();
  const link = path.join(linkParent, 'link');
  fs.symlinkSync(dir, link);
  assert.deepEqual(uniqueDirs([dir, alias, link, path.join(dir, 'missing')]), [dir, path.join(dir, 'missing')]);
  assert.deepEqual(writePresetFiles([dir, alias, link], 'mine', '{}\n'), [path.join(dir, 'mine.json')], 'a store behind a link is the same store, not a refused symlink');
  assert.deepEqual(existingCopies([dir, alias, link], 'mine'), [path.join(dir, 'mine.json')]);
  assert.deepEqual(removePresetFiles([dir, alias, link], 'mine'), [path.join(dir, 'mine.json')]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('/preset save with the local store linked to the repo store writes and lists it once', { skip }, async () => {
  const repo = await fakeRepo();
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS });
  fs.rmSync(h.presetsDir, { recursive: true });
  fs.symlinkSync(repo.presetsDir, h.presetsDir);
  script(h, ['', false]);
  await h.command.handler('save mine', h.ctx);
  const saved = h.notes.at(-1).message;
  assert.equal(saved.split('mine.json').length - 1, 1, saved);
  assert.deepEqual(fs.readdirSync(repo.presetsDir), ['mine.json']);
  const del = script(h, [true]);
  await h.command.handler('delete mine', h.ctx);
  assert.equal(del[0].message.split('\n').filter((line) => line.startsWith('  ') && line.endsWith('mine.json')).length, 1, 'one path in the list');
  assert.deepEqual(fs.readdirSync(repo.presetsDir), []);
});

test('.gitignore and the installer treat the temp files of /preset save as noise', { skip }, async () => {
  assert.ok(fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n').includes('pi/agent/presets/.*.tmp'));
  const installer = fs.readFileSync(path.join(REPO, 'bin', 'install-kosmos-pi.sh'), 'utf8');
  assert.match(installer, /rsync -a --delete --exclude='\.\*\.tmp' "\$PI_AGENT_SRC\/presets\/"/);
});

test('/preset save does not say "not applied" when the session was switched and could not be put back', { skip, timeout: 30000 }, async () => {
  const repo = await fakeRepo();
  // Pi accepts the new model, then refuses to go back, while the settings write fails on a held lock.
  const h = await harness({ settings: withRepo(repo), models: SAVE_MODELS, setModelResult: (n) => n === 1 });
  script(h, ['', true]);
  const realConfirm = h.ctx.ui.confirm;
  h.ctx.ui.confirm = async (...args) => { const answer = await realConfirm(...args); fs.mkdirSync(`${h.settingsFile}.lock`); return answer; };
  await h.command.handler('save mine', h.ctx);
  assert.ok(fs.existsSync(path.join(h.presetsDir, 'mine.json')), 'the preset itself was saved');
  const last = h.notes.at(-1);
  assert.equal(last.type, 'error');
  assert.match(last.message, /^Preset mine was saved\. /);
  assert.match(last.message, /could not be switched back/);
  assert.doesNotMatch(last.message, /not applied|Nothing was changed/);
});
