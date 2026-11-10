// Block-level anchors: a comment targets a 1-based, inclusive range of source lines.
// The quote is stored next to the range so later versions can re-anchor by text.

export function quoteFor(text, startLine, endLine, max = 160) {
  const lines = String(text).split(/\r\n|\r|\n/).slice(startLine - 1, endLine);
  const flat = lines.join(' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function mergeRanges(a, b) {
  return { startLine: Math.min(a.startLine, b.startLine), endLine: Math.max(a.endLine, b.endLine) };
}

export function rangesOverlap(a, b) {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}
