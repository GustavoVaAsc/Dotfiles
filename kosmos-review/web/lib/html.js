// htm bound to Preact's h: JSX-like templates without a build step.
// Under Vite + React, replace this module with JSX and delete it.
import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
