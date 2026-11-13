// Resolves the bare "typebox" import of a Pi extension to Pi's own copy (path passed in by the test).
import { pathToFileURL } from 'node:url';

let target = null;
export function initialize(data) { target = data.typebox; }
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox' && target) return { url: pathToFileURL(target).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
