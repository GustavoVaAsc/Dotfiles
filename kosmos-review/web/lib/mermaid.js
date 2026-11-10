// Mermaid is large (about 5 MB), so it is loaded only when a document contains a diagram.
// It ships as a classic script that defines globalThis.mermaid; this module is the only place that knows.
// Its URL comes from <meta name="mermaid-src"> in index.html, next to the import map, so every vendored
// path the page uses is declared in that one file.
// securityLevel 'strict' makes Mermaid sanitize labels and refuse click handlers and raw HTML.

let loading = null;
let counter = 0;

export function loadMermaid() {
  if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
  loading ??= new Promise((resolve, reject) => {
    const src = document.querySelector('meta[name="mermaid-src"]')?.getAttribute('content');
    if (!src) {
      loading = null;
      reject(new Error('index.html declares no <meta name="mermaid-src">'));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => (globalThis.mermaid ? resolve(globalThis.mermaid) : reject(new Error('mermaid did not initialise')));
    script.onerror = () => {
      loading = null;
      reject(new Error('could not load mermaid'));
    };
    document.head.append(script);
  });
  return loading;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function showError(el, source, message) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = source;
  pre.append(code);
  const note = document.createElement('div');
  note.className = 'mermaid-message';
  note.textContent = `Diagram error: ${message}`;
  el.classList.add('mermaid-error');
  el.replaceChildren(pre, note);
}

/** Renders every .mermaid-block under root from its source. Safe to call again after a theme change. */
export async function renderMermaid(root, isCancelled = () => false) {
  const blocks = [...root.querySelectorAll('.mermaid-block')];
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  if (isCancelled()) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    darkMode: document.documentElement.getAttribute('data-theme') !== 'light',
    themeVariables: {
      background: cssVar('--surface'),
      primaryColor: cssVar('--surface-2'),
      primaryTextColor: cssVar('--fg'),
      primaryBorderColor: cssVar('--accent'),
      secondaryColor: cssVar('--accent-faint'),
      tertiaryColor: cssVar('--surface'),
      lineColor: cssVar('--accent-soft'),
      textColor: cssVar('--fg'),
      fontFamily: cssVar('--font-sans'),
    },
  });
  for (const el of blocks) {
    if (isCancelled()) return;
    el.dataset.mermaid ??= el.querySelector('code')?.textContent ?? '';
    const source = el.dataset.mermaid;
    const id = `kr-mermaid-${(counter += 1)}`;
    try {
      const { svg } = await mermaid.render(id, source);
      if (isCancelled()) return;
      el.classList.remove('mermaid-error');
      el.innerHTML = svg;
    } catch (err) {
      document.getElementById(`d${id}`)?.remove(); // Mermaid leaves a stray error node behind
      showError(el, source, err?.message ?? String(err));
    }
  }
}
