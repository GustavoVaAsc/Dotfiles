// Review state: comments, answers and the comment composer. Pure and framework-free,
// so it moves to a React useReducer (or Redux) unchanged.
import { mergeRanges } from '../lib/anchors.js';

export const initialState = {
  comments: [],
  answers: {},
  overall: '',
  composer: null, // { id: string|null, startLine, endLine, quote, text } while a comment is being written
  dirty: false, // true once the user changed something, which turns autosave on
};

const EMPTY_ANSWER = { selected: [], other: '', text: '' };

function nextCommentId(comments) {
  const highest = comments.reduce((max, c) => {
    const match = /^c(\d+)$/.exec(c.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `c${highest + 1}`;
}

export function reducer(state, action) {
  switch (action.type) {
    case 'restore':
      return { ...initialState, comments: action.comments ?? [], answers: action.answers ?? {}, overall: action.overall ?? '' };

    case 'reset':
      return initialState;

    case 'openComposer':
      return { ...state, composer: { id: null, startLine: action.startLine, endLine: action.endLine, quote: action.quote, text: '' } };

    case 'extendComposer': {
      if (!state.composer) return reducer(state, { ...action, type: 'openComposer' });
      if (state.composer.id !== null) return state; // editing an existing comment keeps its range
      const range = mergeRanges(state.composer, action);
      return { ...state, composer: { ...state.composer, ...range, quote: action.quote } };
    }

    case 'editComment': {
      const comment = state.comments.find((c) => c.id === action.id);
      if (!comment) return state;
      return { ...state, composer: { id: comment.id, startLine: comment.startLine, endLine: comment.endLine, quote: comment.quote, text: comment.text } };
    }

    case 'closeComposer':
      return { ...state, composer: null };

    case 'saveComment': {
      const { composer } = state;
      const text = action.text.trim();
      if (!composer || text === '') return state;
      const comments = composer.id
        ? state.comments.map((c) => (c.id === composer.id ? { ...c, text } : c))
        : [...state.comments, { id: nextCommentId(state.comments), startLine: composer.startLine, endLine: composer.endLine, quote: composer.quote, docHash: action.docHash, text, createdAt: action.now }];
      return { ...state, comments, composer: null, dirty: true };
    }

    case 'deleteComment':
      return {
        ...state,
        comments: state.comments.filter((c) => c.id !== action.id),
        composer: state.composer?.id === action.id ? null : state.composer,
        dirty: true,
      };

    case 'setAnswer': {
      // A patch may be a function of the previous answer, so two events handled before the next render both apply.
      const previous = { ...EMPTY_ANSWER, ...state.answers[action.id] };
      const patch = typeof action.patch === 'function' ? action.patch(previous) : action.patch;
      return { ...state, answers: { ...state.answers, [action.id]: { ...previous, ...patch } }, dirty: true };
    }

    case 'setOverall':
      return { ...state, overall: action.text, dirty: true };

    default:
      return state;
  }
}
