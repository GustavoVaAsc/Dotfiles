// Parser for the body of a ```kosmos-question fence. Pure: no DOM, no Node APIs,
// so the page, the CLI `check` command and the tests all use this one file.
//
// Two forms are accepted. JSON (the body starts with "{"), or a strict subset of YAML:
//
//   id: auth-method              required; letters, digits, "_", "." or "-" (max 64)
//   type: single                 required; single | multi | text
//   prompt: Which method?        required; a continuation may be indented on the next lines
//   options:                     required for single/multi (2-30 items), forbidden for text
//     - JWT in a cookie          one option per "- " line; the whole rest of the line is the label
//     - Server-side sessions
//
// Rules: keys start in column 0; "#" starts a comment only at the beginning of a line;
// a value may be plain (taken verbatim, so "Issue #4: why?" works), "double quoted"
// (a JSON string) or 'single quoted' ('' is a quote). Unknown or repeated keys are errors.

export const QUESTION_LANG = 'kosmos-question';
export const TYPES = ['single', 'multi', 'text'];
export const LIMITS = { id: 64, prompt: 2000, option: 300, options: 30 };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const KEYS = new Set(['id', 'type', 'prompt', 'options']);
const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

/** Parses one scalar. Returns { value } or { error }. */
function scalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      const value = JSON.parse(text);
      if (typeof value === 'string') return { value, quoted: true };
    } catch { /* fall through */ }
    return { error: 'a value starting with a double quote must be one complete JSON string' };
  }
  if (text.startsWith("'")) {
    const inner = text.slice(1, -1);
    if (text.length >= 2 && text.endsWith("'") && !inner.replace(/''/g, '').includes("'")) {
      return { value: inner.replace(/''/g, "'"), quoted: true };
    }
    return { error: "a value starting with a single quote must end with one (use '' for a quote inside)" };
  }
  return { value: text, quoted: false };
}

/** Reads the YAML subset into { fields, lines, errors }. `lines` maps a key to its source line. */
function readSubset(body, firstLine) {
  const fields = {};
  const lines = {};
  const errors = [];
  const err = (index, message) => errors.push({ line: firstLine + index, message });
  let current = null; // key currently accepting continuation lines
  let optionsList = null;

  body.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (line.trim() === '' || /^\s*#/.test(line)) return;
    const indented = /^[ \t]/.test(line);
    const trimmed = line.trim();

    if (current === 'options' && (trimmed === '-' || trimmed.startsWith('- '))) {
      const item = scalar(trimmed.slice(1));
      if (item.error) err(index, item.error);
      else optionsList.push({ value: item.value, line: firstLine + index });
      return;
    }
    if (indented) {
      if (current && current !== 'options' && !fields[current].quoted) {
        fields[current].value = `${fields[current].value} ${trimmed}`.trim();
      } else {
        err(index, current === 'options' ? 'unexpected indented line; options are written as "- label"' : 'unexpected indent');
      }
      return;
    }
    const match = KEY_LINE_RE.exec(line.trimEnd());
    if (!match) {
      err(index, `expected "key: value", got "${trimmed.slice(0, 40)}"`);
      current = null;
      return;
    }
    const [, key, rest = ''] = match;
    if (!KEYS.has(key)) {
      err(index, `unknown key "${key}" (allowed: id, type, prompt, options)`);
      current = null;
      return;
    }
    if (key in lines) {
      err(index, `duplicate key "${key}"`);
      current = null;
      return;
    }
    lines[key] = firstLine + index;
    current = key;
    if (key === 'options') {
      optionsList = [];
      fields.options = optionsList;
      if (rest.trim() !== '') err(index, 'options must be a list: put one "- label" per line below "options:"');
      return;
    }
    const parsed = scalar(rest);
    if (parsed.error) {
      err(index, parsed.error);
      current = null;
      fields[key] = { value: '', quoted: true };
    } else {
      fields[key] = parsed;
    }
  });
  return { fields, lines, errors };
}

function validate(raw, lineOf, errors) {
  const at = (key) => lineOf[key] ?? lineOf.$body;
  const bad = (key, message) => errors.push({ line: at(key), message });
  const out = { id: '', type: '', prompt: '', options: [] };

  if (typeof raw.id !== 'string' || raw.id === '') bad('id', 'id is required (a stable string such as "auth-method")');
  else if (raw.id.length > LIMITS.id || !ID_RE.test(raw.id)) bad('id', `id must be 1-${LIMITS.id} characters of letters, digits, "_", "." or "-"`);
  else out.id = raw.id;

  if (!TYPES.includes(raw.type)) bad('type', `type must be one of ${TYPES.join(', ')}`);
  else out.type = raw.type;

  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') bad('prompt', 'prompt is required');
  else if (raw.prompt.length > LIMITS.prompt) bad('prompt', `prompt is too long (max ${LIMITS.prompt} characters)`);
  else out.prompt = raw.prompt.trim();

  if (out.type === 'text') {
    if (raw.options !== undefined) bad('options', 'text questions take no options');
  } else if (out.type) {
    const options = raw.options;
    if (!Array.isArray(options)) bad('options', 'options are required for single and multi questions');
    else {
      const labels = options.map((o) => (typeof o === 'string' ? o.trim() : null));
      if (labels.some((l) => l === null || l === '')) bad('options', 'an option is empty or not a string');
      else if (labels.length < 2) bad('options', 'a choice needs at least 2 options');
      else if (labels.length > LIMITS.options) bad('options', `at most ${LIMITS.options} options`);
      else if (labels.some((l) => l.length > LIMITS.option)) bad('options', `an option is too long (max ${LIMITS.option} characters)`);
      else if (new Set(labels).size !== labels.length) bad('options', 'duplicate option');
      else out.options = labels;
    }
  }
  return out;
}

/**
 * @param {string} body  fence content
 * @param {{ firstLine?: number }} [opts]  document line number of the first body line (for error positions)
 * @returns {{ ok: true, question: {id,type,prompt,options} } | { ok: false, errors: {line,message}[] }}
 */
export function parseQuestion(body, { firstLine = 1 } = {}) {
  const errors = [];
  let raw;
  let lineOf = { $body: firstLine };

  if (body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
    try {
      raw = JSON.parse(body);
    } catch (e) {
      return { ok: false, errors: [{ line: firstLine, message: `invalid JSON: ${e.message}` }] };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: [{ line: firstLine, message: 'a JSON question must be an object' }] };
    }
    for (const key of Object.keys(raw)) {
      if (!KEYS.has(key)) errors.push({ line: firstLine, message: `unknown key "${key}" (allowed: id, type, prompt, options)` });
    }
  } else {
    const subset = readSubset(body, firstLine);
    errors.push(...subset.errors);
    lineOf = { ...subset.lines, $body: firstLine };
    raw = {};
    for (const key of ['id', 'type', 'prompt']) if (subset.fields[key]) raw[key] = subset.fields[key].value;
    if (subset.fields.options) raw.options = subset.fields.options.map((o) => o.value);
  }

  const question = validate(raw, lineOf, errors);
  return errors.length ? { ok: false, errors } : { ok: true, question };
}
