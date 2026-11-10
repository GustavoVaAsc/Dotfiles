import { useCallback, useEffect, useMemo, useReducer, useState } from 'preact/hooks';
import { html } from '../lib/html.js';
import { applyTheme, currentTheme } from '../lib/theme.js';
import { focusLines } from '../lib/dom.js';
import { mergeRanges, quoteFor } from '../lib/anchors.js';
import { initialState, reducer } from '../state/reducer.js';
import { buildReview, restoreAnswers } from '../state/payload.js';
import { createAutosaver } from '../state/autosave.js';
import { Header } from './Header.js';
import { Document } from './Document.js';
import { ReviewPanel } from './ReviewPanel.js';
import { CommentComposer } from './CommentComposer.js';
import { CommentList } from './CommentList.js';
import { KeepPrompt } from './KeepPrompt.js';

const Notice = ({ tone = 'info', children, action }) => html`<div class=${'notice notice-' + tone} role="status">${children}${action}</div>`;

export function Fatal({ title, children }) {
  return html`<main class="fatal"><h1>${title}</h1>${children}</main>`;
}

/** Top-level container: loads the server state, owns the review reducer, wires autosave and submit. */
export function App({ api, markdown, heartbeatMs = 60_000 }) {
  const [boot, setBoot] = useState({ phase: 'loading' });
  const [server, setServer] = useState(null);
  const [review, dispatch] = useReducer(reducer, initialState);
  const [reopened, setReopened] = useState(false);
  const [saveState, setSaveState] = useState('idle');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [theme, setTheme] = useState(currentTheme());

  const saver = useMemo(() => createAutosaver({ save: (payload) => api.saveDraft(payload), onStatus: setSaveState }), [api]);

  // Takes a /api/state payload as the new truth: parses the document once, restores the draft.
  const applyState = useCallback((state) => {
    const parsed = markdown.parse(state.doc.text);
    setServer({ ...state, parsed });
    setReopened(false);
    dispatch({
      type: 'restore',
      comments: state.draft?.comments ?? [],
      answers: restoreAnswers(state.draft?.answers, parsed.questions),
      overall: state.draft?.overall ?? '',
    });
  }, [markdown]);

  useEffect(() => {
    api.getState().then(applyState).then(() => setBoot({ phase: 'ready' }), (error) => setBoot({ phase: 'error', error }));
  }, []);

  // Autosave: any change after the first user edit goes to draft.json after a short pause.
  useEffect(() => {
    if (!server || !review.dirty) return;
    saver.schedule(buildReview(review, server.parsed.questions, server.doc.hash));
  }, [review.comments, review.answers, review.overall]);

  useEffect(() => {
    const flush = () => { saver.flush(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [saver]);

  // Heartbeat: while the tab is visible, keep the server's idle timer from stranding the page. If the server is gone, say so.
  useEffect(() => {
    if (boot.phase !== 'ready') return undefined;
    const timer = setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        await api.ping();
        setNotice((current) => (current?.lost ? null : current)); // the server is back: drop the lost-contact notice, nothing else
      } catch {
        const lostNotice = { tone: 'warn', lost: true, text: 'Lost contact with the review server (it probably stopped after being idle). Your last autosaved draft is on disk. Ask the agent to run `kosmos-review serve` again, then open the new URL.' };
        setNotice((current) => current ?? lostNotice); // never replace a notice that is already showing (a rejected submit, say)
      }
    }, heartbeatMs);
    return () => clearInterval(timer);
  }, [boot.phase, api, heartbeatMs]);

  if (boot.phase === 'loading') return html`<${Fatal} title="Loading review…"><p class="muted">Contacting the local review server.</p><//>`;
  if (boot.phase === 'error') {
    const unauthorized = boot.error.status === 401;
    return html`<${Fatal} title=${unauthorized ? 'Access token rejected' : 'Cannot load the review'}>
      <p>${boot.error.message}</p>
      <p class="muted">${unauthorized
        ? 'Open the URL the agent printed (it carries the access token after the #). A restarted server has a new token.'
        : 'Ask the agent to run kosmos-review serve again; it prints a fresh URL.'}</p>
    <//>`;
  }

  const { doc, parsed } = server;
  const locked = server.status === 'submitted' && !reopened;
  const lineCount = doc.text.split(/\r\n|\r|\n/).length;
  const lastRound = server.rounds.at(-1);
  const draftStale = server.draft && server.draft.docHash !== doc.hash;

  const reload = async () => {
    setNotice(null);
    try {
      await saver.flush();
      applyState(await api.getState());
    } catch (err) {
      setNotice({ tone: 'error', text: err.message });
    }
  };

  const submit = async () => {
    if (review.comments.length === 0 && review.overall.trim() === '' && !window.confirm('Submit with no comments? The agent will read this as "approved as is".')) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await saver.flush(); // the last edits reach draft.json first, so a refused submit loses nothing
      await api.submit(buildReview(review, parsed.questions, doc.hash));
      applyState(await api.getState());
    } catch (err) {
      setNotice(err.status === 409
        ? { tone: 'warn', text: err.message, reload: true }
        : { tone: 'error', text: `Submit failed: ${err.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const pickBlock = (range, extend) => {
    const composer = review.composer;
    if (extend && composer && composer.id === null) {
      const merged = mergeRanges(composer, range);
      dispatch({ type: 'extendComposer', ...range, quote: quoteFor(doc.text, merged.startLine, merged.endLine) });
    } else {
      dispatch({ type: 'openComposer', ...range, quote: quoteFor(doc.text, range.startLine, range.endLine) });
    }
  };

  const chooseKeep = async (keep) => {
    const result = await api.setKeep(keep);
    setServer((s) => ({ ...s, needsKeepPrompt: false }));
    if (result.exclude === 'manual') {
      setNotice({ tone: 'warn', text: `Not kept, but this is a git worktree or submodule, so nothing was written automatically. To keep it out of git, add the line ${result.manual.line} to the file printed by: ${result.manual.command}` });
    }
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  const reloadButton = html`<button type="button" class="small" onClick=${reload}>Reload document</button>`;

  return html`
    <div class="app">
      <${Header} slug=${server.slug} round=${locked ? lastRound?.round : server.round} status=${locked ? 'submitted' : 'open'} saveState=${saveState} theme=${theme} onToggleTheme=${toggleTheme} />
      ${notice && html`<${Notice} tone=${notice.tone} action=${notice.reload ? reloadButton : null}>${notice.text}<//>`}
      ${locked && html`<${Notice} tone="success" action=${html`<span class="notice-actions">${reloadButton}<button type="button" class="small" onClick=${() => setReopened(true)}>Start another round on this version</button></span>`}>
        Round ${lastRound?.round} submitted to ${lastRound?.file}. Tell the agent "review submitted"; when it has updated the document, reload.
      <//>`}
      ${draftStale && !locked && html`<${Notice} tone="warn">This draft was started on an earlier version of the document. Comments marked "earlier version" may point at the wrong lines.<//>`}
      ${parsed.issues.length > 0 && html`<${Notice} tone="warn">${parsed.issues.length} problem(s) in the question blocks of this document. Details are shown in place; ask the agent to fix them.<//>`}
      <main class="layout">
        <div class="doc-pane">
          <${Document} segments=${parsed.segments} markdown=${markdown} comments=${review.comments} composer=${review.composer}
            answers=${review.answers} readOnly=${locked} assetBlob=${api.assetBlob}
            onAnswer=${(id, patch) => dispatch({ type: 'setAnswer', id, patch })} onPickBlock=${pickBlock} theme=${theme} />
        </div>
        <aside class="side-pane">
          <${ReviewPanel} round=${server.round} submitted=${locked ? lastRound : null} questions=${parsed.questions} answers=${review.answers} commentCount=${review.comments.length}
            overall=${review.overall} lineCount=${lineCount} readOnly=${locked} submitting=${submitting}
            onOverall=${(text) => dispatch({ type: 'setOverall', text })}
            onAddLines=${(startLine, endLine) => dispatch({ type: 'openComposer', startLine, endLine, quote: quoteFor(doc.text, startLine, endLine) })}
            onSubmit=${submit}
            onJumpQuestion=${(id) => document.getElementById(`question-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} />
          ${review.composer && !locked && html`<${CommentComposer} key=${review.composer.id ?? 'new'} composer=${review.composer}
            onSave=${(text) => dispatch({ type: 'saveComment', text, docHash: doc.hash, now: new Date().toISOString() })}
            onCancel=${() => dispatch({ type: 'closeComposer' })} />`}
          <${CommentList} comments=${review.comments} docHash=${doc.hash}
            onEdit=${(id) => dispatch({ type: 'editComment', id })} onDelete=${(id) => dispatch({ type: 'deleteComment', id })} onJump=${focusLines} />
        </aside>
      </main>
      ${server.needsKeepPrompt && html`<${KeepPrompt} reviewPath=${server.reviewPath} onChoose=${chooseKeep} />`}
    </div>`;
}
