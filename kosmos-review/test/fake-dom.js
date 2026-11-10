// A just-enough DOM to run real Preact renders under Node (no browser or jsdom available).
// Not a conformant DOM: it supports what Preact and these components call, and nothing else.

class Node_ {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() { const i = this.parentNode?.childNodes.indexOf(this); return i >= 0 ? this.parentNode.childNodes[i + 1] ?? null : null; }
  get previousSibling() { const i = this.parentNode?.childNodes.indexOf(this); return i > 0 ? this.parentNode.childNodes[i - 1] : null; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, ref) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    if (ref == null) this.childNodes.push(node);
    else this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    return node;
  }
  removeChild(node) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  append(...nodes) { nodes.forEach((n) => this.appendChild(typeof n === 'string' ? new Text_(n) : n)); }
  replaceChildren(...nodes) { this.childNodes.slice().forEach((n) => this.removeChild(n)); this.append(...nodes); }
}

export class Text_ extends Node_ {
  constructor(data) { super(); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export class Element_ extends Node_ {
  constructor(name) {
    super();
    this.nodeType = 1;
    this.localName = name.toLowerCase();
    this.nodeName = name.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {}, removeProperty() {} };
    this._inner = null;
    // Preact only lowercases event names for handlers that exist as DOM properties.
    for (const ev of ['onclick', 'onchange', 'oninput', 'onsubmit', 'onmouseover', 'onmouseleave', 'onkeydown']) this[ev] = null;
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  set innerHTML(html) { this._inner = String(html); this.childNodes.slice().forEach((n) => this.removeChild(n)); }
  get innerHTML() { return this._inner ?? ''; }
  get textContent() { return this._inner ?? this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(text) { this._inner = null; this.replaceChildren(String(text)); }
  get classList() {
    const get = () => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    return {
      add: (c) => this.setAttribute('class', [...new Set([...get(), c])].join(' ')),
      remove: (c) => this.setAttribute('class', get().filter((x) => x !== c).join(' ')),
      toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => get().includes(c),
    };
  }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  focus() { this.focused = true; }
  scrollIntoView() {}

  /** Serializes to HTML-ish text for assertions. */
  toHTML() {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    const inner = this._inner ?? this.childNodes.map((n) => (n.nodeType === 3 ? escapeText(n.data) : n.toHTML())).join('');
    return `<${this.localName}${attrs}>${inner}</${this.localName}>`;
  }
}

export function installFakeDom() {
  const documentElement = new Element_('html');
  const body = new Element_('body');
  const doc = {
    documentElement,
    body,
    head: new Element_('head'),
    visibilityState: 'visible',
    createElement: (name) => new Element_(name),
    createElementNS: (ns, name) => new Element_(name),
    createTextNode: (data) => new Text_(data),
    getElementById: (id) => find(body, (n) => n.getAttribute?.('id') === id),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const win = { addEventListener() {}, removeEventListener() {}, confirm: () => true };
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = doc;
  globalThis.window = win;
  return { document: doc, window: win, restore() { globalThis.document = saved.document; globalThis.window = saved.window; } };
}

export function findAll(root, pred, out = []) {
  if (pred(root)) out.push(root);
  root.childNodes.forEach((c) => findAll(c, pred, out));
  return out;
}
export const find = (root, pred) => findAll(root, pred)[0] ?? null;
export const byText = (root, tag, text) => find(root, (n) => n.localName === tag && n.textContent.includes(text));

/** Calls the listeners a component registered for an event, like a browser would. */
export function fire(node, type, props = {}) {
  const event = { type, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...props };
  for (const fn of node.listeners.get(type) ?? []) fn.call(node, event);
}

export const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
