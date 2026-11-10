// Entry point: wires the vendored libraries to the app. Under Vite + React this file becomes main.jsx.
import { render } from 'preact';
import markdownit from 'markdown-it';
import hljs from 'highlight.js';
import { html } from './lib/html.js';
import { createMarkdown } from './lib/markdown.js';
import { initSession } from './net/session.js';
import { createApiClient } from './net/client.js';
import { App, Fatal } from './components/App.js';

const root = document.getElementById('app');
const token = initSession({ location, history, storage: sessionStorage });

if (!token) {
  render(html`<${Fatal} title="Missing access token">
    <p>Open the full URL the agent printed. It ends with <code>#token=…</code>; that token is what lets this page read and write the review.</p>
    <p class="muted">If you lost it, ask the agent to run <code>kosmos-review serve</code> again: it prints the URL for the running server.</p>
  <//>`, root);
} else {
  const markdown = createMarkdown({ markdownit, hljs });
  render(html`<${App} api=${createApiClient({ token })} markdown=${markdown} />`, root);
}
