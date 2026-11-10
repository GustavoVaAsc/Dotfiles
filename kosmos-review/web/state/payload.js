// Converts between the in-memory review state and the JSON the server stores.

const EMPTY = { selected: [], other: '', text: '' };

export function isAnswered(question, answer) {
  if (!answer) return false;
  if (question.type === 'text') return answer.text.trim() !== '';
  return answer.selected.length > 0 || answer.other.trim() !== '';
}

export function answeredCount(questions, answers) {
  return questions.filter((q) => isAnswered(q, answers[q.id])).length;
}

/** The body for PUT /api/draft and POST /api/submit. Every question gets an entry, answered or not. */
export function buildReview(state, questions, docHash) {
  const answers = questions.map((q) => {
    const a = state.answers[q.id] ?? EMPTY;
    const isText = q.type === 'text';
    const indexes = [...new Set(a.selected)].filter((i) => i >= 0 && i < q.options.length).sort((x, y) => x - y);
    return {
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      selected: isText ? [] : indexes.map((index) => ({ index, label: q.options[index] })),
      other: isText ? '' : a.other,
      text: isText ? a.text : '',
    };
  });
  return { docHash, overall: state.overall, comments: state.comments, answers };
}

/** Rebuilds the answer map from a stored draft. Options are matched by label, so a reordered or edited list is safe. */
export function restoreAnswers(wireAnswers, questions) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const restored = {};
  for (const wire of wireAnswers ?? []) {
    const q = byId.get(wire.id);
    if (!q || q.type !== wire.type) continue;
    const indexes = [...new Set((wire.selected ?? []).map((s) => q.options.indexOf(s.label)).filter((i) => i >= 0))].sort((x, y) => x - y);
    restored[q.id] = {
      selected: q.type === 'single' ? indexes.slice(0, 1) : indexes,
      other: wire.other ?? '',
      text: wire.text ?? '',
    };
  }
  return restored;
}
