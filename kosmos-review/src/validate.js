// Strict validation of request bodies. Rebuilds the object from known fields so
// nothing the client invents is ever written to disk.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export const LIMITS = {
  comments: 500,
  answers: 200,
  commentText: 10_000,
  quote: 400,
  overall: 20_000,
  answerText: 20_000,
  other: 5_000,
  prompt: 2_000,
  label: 400,
  selected: 50,
  maxLine: 10_000_000,
};

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TYPES = new Set(['single', 'multi', 'text']);

const fail = (msg) => { throw new ValidationError(msg); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(value, name, max, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  if (value.length > max) fail(`${name} is too long (max ${max})`);
  if (!allowEmpty && value.trim() === '') fail(`${name} must not be empty`);
  return value;
}

function line(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxLine) fail(`${name} must be a positive integer`);
  return value;
}

function hash(value, name) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail(`${name} must look like sha256:<64 hex>`);
  return value;
}

function id(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${name} must be 1-64 characters of letters, digits, "_", "." or "-"`);
  return value;
}

function parseComment(c, i) {
  if (!isObject(c)) fail(`comments[${i}] must be an object`);
  const startLine = line(c.startLine, `comments[${i}].startLine`);
  const endLine = line(c.endLine, `comments[${i}].endLine`);
  if (endLine < startLine) fail(`comments[${i}].startLine must not be after endLine`);
  return {
    id: id(c.id, `comments[${i}].id`),
    startLine,
    endLine,
    quote: str(c.quote, `comments[${i}].quote`, LIMITS.quote),
    docHash: hash(c.docHash, `comments[${i}].docHash`),
    text: str(c.text, `comments[${i}].text`, LIMITS.commentText, { allowEmpty: false }),
    createdAt: str(c.createdAt, `comments[${i}].createdAt`, 40),
  };
}

function parseAnswer(a, i) {
  if (!isObject(a)) fail(`answers[${i}] must be an object`);
  if (!TYPES.has(a.type)) fail(`answers[${i}].type must be single, multi or text`);
  if (!Array.isArray(a.selected) || a.selected.length > LIMITS.selected) fail(`answers[${i}].selected must be a short array`);
  const selected = a.selected.map((s, j) => {
    if (!isObject(s)) fail(`answers[${i}].selected[${j}] must be an object`);
    if (!Number.isInteger(s.index) || s.index < 0 || s.index > 1000) fail(`answers[${i}].selected[${j}].index must be a non-negative integer`);
    return { index: s.index, label: str(s.label, `answers[${i}].selected[${j}].label`, LIMITS.label) };
  });
  return {
    id: id(a.id, `answers[${i}].id`),
    type: a.type,
    prompt: str(a.prompt, `answers[${i}].prompt`, LIMITS.prompt),
    selected,
    other: str(a.other, `answers[${i}].other`, LIMITS.other),
    text: str(a.text, `answers[${i}].text`, LIMITS.answerText),
  };
}

function uniqueIds(items, name) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) fail(`duplicate ${name} id "${item.id}"`);
    seen.add(item.id);
  }
}

/** Validates a draft or a submitted review body. Returns a fresh, sanitized object. */
export function parseReview(body) {
  if (!isObject(body)) fail('body must be a JSON object');
  const docHash = hash(body.docHash, 'docHash');
  const overall = body.overall === undefined ? '' : str(body.overall, 'overall', LIMITS.overall);
  if (!Array.isArray(body.comments) || body.comments.length > LIMITS.comments) fail(`comments must be an array of at most ${LIMITS.comments}`);
  if (!Array.isArray(body.answers) || body.answers.length > LIMITS.answers) fail(`answers must be an array of at most ${LIMITS.answers}`);
  const comments = body.comments.map(parseComment);
  const answers = body.answers.map(parseAnswer);
  uniqueIds(comments, 'comment');
  uniqueIds(answers, 'answer');
  return { docHash, overall, comments, answers };
}

export function parseKeep(body) {
  if (!isObject(body) || typeof body.keep !== 'boolean') fail('keep must be true or false');
  return body.keep;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A round file as the review server writes it (round-N.json). Rebuilds it from known fields only, so whatever else
 * a file carries, even a correctly signed one, is dropped. The MAC is not part of the result.
 */
export function parseRound(obj) {
  if (!isObject(obj)) fail('a round must be a JSON object');
  if (obj.schema !== 1) fail('schema must be 1');
  if (!Number.isInteger(obj.round) || obj.round < 1 || obj.round > 1_000_000) fail('round must be a positive integer');
  if (typeof obj.slug !== 'string' || !SLUG_RE.test(obj.slug)) fail('slug is invalid');
  const docFile = str(obj.docFile, 'docFile', 300);
  const submittedAt = str(obj.submittedAt, 'submittedAt', 40);
  if (!Array.isArray(obj.answers)) fail('answers must be an array');
  const flags = obj.answers.map((a) => {
    if (!isObject(a) || typeof a.answered !== 'boolean') fail('every answer needs a boolean "answered"');
    return a.answered;
  });
  const review = parseReview({ docHash: obj.docHash, overall: obj.overall ?? '', comments: obj.comments, answers: obj.answers.map(({ answered, ...rest }) => rest) });
  return {
    schema: 1,
    round: obj.round,
    slug: obj.slug,
    docFile,
    submittedAt,
    docHash: review.docHash,
    overall: review.overall,
    comments: review.comments,
    answers: review.answers.map((a, i) => ({ ...a, answered: flags[i] })),
  };
}
