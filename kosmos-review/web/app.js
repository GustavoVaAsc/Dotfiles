// Entry point: wires the vendored libraries to the app. Under Vite + React this file becomes main.jsx.
import { render } from 'preact';
import markdownit from 'markdown-it';
import hljs from 'highlight.js';
import { html } from './lib/html.js';
import { createMarkdown } from './lib/markdown.js';
import { initSession, takeTicket, exchangeTicket } from './net/session.js';
import { createApiClient } from './net/client.js';
import { App, Fatal } from './components/App.js';

const root = document.getElementById('app');
// A browser started by `kosmos-review serve` carries a one-time ticket (#ticket=...), never the token itself.
const ticket = takeTicket({ location, history });
const token = ticket
  ? await exchangeTicket(ticket, { storage: sessionStorage })
  : initSession({ location, history, storage: sessionStorage });

if (!token && ticket) {
  render(html`<${Fatal} title="This link was already used or expired">
    <p>The one-time link that opened this page can be used once, within a minute of being created, and it could not be exchanged for access to the review.</p>
    <p class="muted">Ask the agent for a fresh one: <code>kosmos-review serve</code> prints the URL of the running server (the full URL, ending with <code>#token=…</code>, works as long as the server runs).</p>
  <//>`, root);
} else if (!token) {
  render(html`<${Fatal} title="Missing access token">
    <p>Open the full URL the agent printed. It ends with <code>#token=…</code>; that token is what lets this page read and write the review.</p>
    <p class="muted">If you lost it, ask the agent to run <code>kosmos-review serve</code> again: it prints the URL for the running server.</p>
  <//>`, root);
} else {
  const markdown = createMarkdown({ markdownit, hljs });
  render(html`<${App} api=${createApiClient({ token })} markdown=${markdown} />`, root);
}
