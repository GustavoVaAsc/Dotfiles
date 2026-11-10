// Small DOM helpers that live outside the component tree.

/** The smallest anchored block that contains the line, or the first block after it. */
export function findBlock(root, line) {
  let best = null;
  let bestSpan = Infinity;
  let after = null;
  root.querySelectorAll('[data-line-start]').forEach((el) => {
    const start = Number(el.dataset.lineStart);
    const end = Number(el.dataset.lineEnd);
    if (start <= line && line <= end && end - start < bestSpan) {
      best = el;
      bestSpan = end - start;
    } else if (start > line && (!after || start < Number(after.dataset.lineStart))) {
      after = el;
    }
  });
  return best ?? after;
}

export function focusLines(line) {
  const root = document.querySelector('.doc');
  const el = root && findBlock(root, line);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}
