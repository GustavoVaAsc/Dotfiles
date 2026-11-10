import { useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { answeredCount, isAnswered } from '../state/payload.js';

/** Summary, overall note, "comment on lines" form (a keyboard/touch alternative to the + button) and Submit. */
export function ReviewPanel({ round, submitted, questions, answers, commentCount, overall, lineCount, readOnly, submitting, onOverall, onAddLines, onSubmit, onJumpQuestion }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const answered = answeredCount(questions, answers);

  const addLines = (e) => {
    e.preventDefault();
    const start = Number(from);
    const end = to === '' ? start : Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lineCount) return;
    onAddLines(start, end);
    setFrom('');
    setTo('');
  };

  return html`
    <section class="panel" aria-label="Review">
      <h2>${submitted ? `Round ${submitted.round} submitted` : `Round ${round}`}</h2>
      <p class="muted">${submitted
        ? `${submitted.comments ?? 0} comment${submitted.comments === 1 ? '' : 's'} · ${submitted.answers ?? 0} question${submitted.answers === 1 ? '' : 's'} answered`
        : `${commentCount} comment${commentCount === 1 ? '' : 's'}${questions.length ? ` · ${answered} of ${questions.length} question${questions.length === 1 ? '' : 's'} answered` : ''}`}</p>
      ${questions.length > 0 && !submitted && html`
        <ul class="question-index">
          ${questions.map((q) => html`<li key=${q.id}><button type="button" class="link" onClick=${() => onJumpQuestion(q.id)}>${q.id}</button>${isAnswered(q, answers[q.id]) ? ' ✓' : ''}</li>`)}
        </ul>`}
      <label class="field">
        <span>Overall note (optional)</span>
        <textarea rows="3" placeholder="Anything that does not belong to one line" value=${overall} disabled=${readOnly}
          onInput=${(e) => onOverall(e.target.value)}></textarea>
      </label>
      <form class="lines-form" onSubmit=${addLines}>
        <span>Comment on lines</span>
        <input type="number" min="1" max=${lineCount} placeholder="from" aria-label="From line" value=${from} disabled=${readOnly} onInput=${(e) => setFrom(e.target.value)} />
        <span>to</span>
        <input type="number" min="1" max=${lineCount} placeholder="to" aria-label="To line" value=${to} disabled=${readOnly} onInput=${(e) => setTo(e.target.value)} />
        <button type="submit" class="small" disabled=${readOnly || from === ''}>Add</button>
      </form>
      <div class="row">
        <button type="button" class="primary" disabled=${readOnly || submitting} onClick=${onSubmit}>${submitting ? 'Submitting…' : 'Submit review'}</button>
      </div>
    </section>`;
}
