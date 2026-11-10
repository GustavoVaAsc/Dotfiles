// Node module-resolution hook that applies the import map declared in web/index.html, so the browser
// modules (which import bare "preact", "htm", ...) load under Node. The map is read from the page itself:
// there is no second copy of the vendor paths to keep in sync.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const MAP = JSON.parse(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(page)[1]).imports;

export async function resolve(specifier, context, nextResolve) {
  if (MAP[specifier]) return { url: pathToFileURL(path.join(ROOT, MAP[specifier])).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
