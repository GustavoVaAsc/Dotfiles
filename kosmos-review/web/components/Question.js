import { html } from '../lib/html.js';
import { isAnswered } from '../state/payload.js';

const EMPTY = { selected: [], other: '', text: '' };
const KIND = { single: 'Single choice', multi: 'Multiple choice', text: 'Free text' };

const Inline = ({ markdown, text, tag = 'span' }) => html`<${tag} dangerouslySetInnerHTML=${{ __html: markdown.renderInline(text) }}></${tag}>`;

/** One kosmos-question block: radio buttons, checkboxes or a textarea, plus "other" for the two choice types. */
export function Question({ segment, answer, readOnly, markdown, onChange, commented, composing }) {
  const { question, errors, raw, startLine, endLine } = segment;
  const anchor = { 'data-line-start': startLine, 'data-line-end': endLine };
  const marks = `${commented ? ' has-comment' : ''}${composing ? ' is-composing' : ''}`;

  if (!question) {
    return html`
      <section class=${'question question-invalid' + marks} ...${anchor}>
        <header><span class="question-kind">Question block has problems</span></header>
        <ul class="question-errors">${errors.map((e) => html`<li>line ${e.line}: ${e.message}</li>`)}</ul>
        <pre><code>${raw}</code></pre>
      </section>`;
  }

  const a = answer ?? EMPTY;
  const answered = isAnswered(question, a);
  const name = `q-${question.id}`;
  const toggle = (i, on) => onChange((prev) => ({ selected: on ? [...new Set([...prev.selected, i])] : prev.selected.filter((x) => x !== i) }));

  return html`
    <section id=${`question-${question.id}`} class=${'question' + (answered ? ' is-answered' : '') + marks} ...${anchor}>
      <header>
        <span class="question-kind">${KIND[question.type]}</span>
        <code class="question-id">${question.id}</code>
        <span class="question-state">${answered ? 'answered' : 'unanswered'}</span>
      </header>
      <${Inline} tag="p" markdown=${markdown} text=${question.prompt} />
      ${question.type === 'text'
        ? html`<textarea rows="4" placeholder="Your answer" aria-label=${question.prompt} value=${a.text} disabled=${readOnly}
            onInput=${(e) => onChange({ text: e.target.value })}></textarea>`
        : html`
          <div class="options" role=${question.type === 'single' ? 'radiogroup' : 'group'}>
            ${question.options.map((label, i) => html`
              <label class="option">
                <input type=${question.type === 'single' ? 'radio' : 'checkbox'} name=${name} disabled=${readOnly}
                  checked=${a.selected.includes(i)}
                  onChange=${(e) => (question.type === 'single' ? onChange({ selected: [i], other: '' }) : toggle(i, e.target.checked))} />
                <${Inline} markdown=${markdown} text=${label} />
              </label>`)}
            <label class="option option-other">
              <span class="other-label">Other</span>
              <input type="text" class="other-input" placeholder="Your own answer" aria-label="Other answer" value=${a.other} disabled=${readOnly}
                onInput=${(e) => onChange(question.type === 'single' && e.target.value ? { other: e.target.value, selected: [] } : { other: e.target.value })} />
            </label>
          </div>`}
    </section>`;
}
