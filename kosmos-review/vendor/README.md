# Vendored libraries

Third-party code the page runs, copied here so the tool works offline and with no install step.
Versions are pinned exactly. Nothing here is edited; each file is byte-for-byte what the CDN served.

| Library | Version | File in this folder | Source URL | License |
|---|---|---|---|---|
| Preact | 10.29.8 | `preact/preact.module.js` | https://cdn.jsdelivr.net/npm/preact@10.29.8/dist/preact.module.js | MIT |
| Preact hooks | 10.29.8 | `preact/hooks.module.js` | https://cdn.jsdelivr.net/npm/preact@10.29.8/hooks/dist/hooks.module.js | MIT |
| htm | 3.1.1 | `htm/htm.module.js` | https://cdn.jsdelivr.net/npm/htm@3.1.1/dist/htm.module.js | Apache-2.0 |
| markdown-it | 15.0.3 | `markdown-it/markdown-it.esm.min.mjs` | https://cdn.jsdelivr.net/npm/markdown-it@15.0.3/dist/browser/markdown-it.esm.min.mjs | MIT |
| highlight.js | 11.12.0 | `highlight.js/highlight.min.js` | https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/es/highlight.min.js | BSD-3-Clause |
| Mermaid | 12.3.0 | `mermaid/mermaid.min.js` | https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js | MIT |

Each folder also holds the library's `LICENSE`, fetched from the same package version.

Notes:

- **Preact 10, not 11.** Preact 11 was the latest release when this was vendored; the 10.x line was chosen because its
  `dist/preact.module.js` + `hooks/dist/hooks.module.js` layout and API are the ones this code was written and tested against.
- **highlight.js** is the `es/highlight.min.js` build from `@highlightjs/cdn-assets`: ESM, with the common languages included.
- **Mermaid** is a 5.5 MB classic script (it defines `globalThis.mermaid`). The page loads it lazily, only when a document
  contains a `mermaid` fence (`web/lib/mermaid.js`). It is the only vendored file that is not an ES module.
- The page maps the bare specifiers `preact`, `preact/hooks`, `htm`, `markdown-it` and `highlight.js` to these files with an
  import map in `web/index.html` (the Mermaid path is the `mermaid-src` meta tag next to it). Node code outside the page
  (the CLI's `check`, the tests) reaches markdown-it and highlight.js through `#markdown-it` and `#highlight.js` in
  `package.json` `imports`; `test/importmap-hooks.mjs` reads the import map out of `index.html`. So the vendored paths
  are named in exactly two places: `web/index.html` and `package.json` `imports`.

## Provenance and checks (2026-11-09)

Each vendored file was compared byte for byte with the same file inside the tarball that `npm pack <package>@<version>`
downloads from registry.npmjs.org: all six are identical, and so are the `LICENSE` files. The registry's integrity
value for each tarball:

| Package | `dist.integrity` (from `npm view <pkg>@<ver> dist.integrity`) |
|---|---|
| preact@10.29.8 | `sha512-ej2aVZ+vZ8WO7tvlQWRM9N63A0KzF9q4mWJfDUHgYaIofWY9hu74QdnQrjoPMmZi2/nZ5gN0bJCQF49xQqx09Q==` |
| htm@3.1.1 | `sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==` |
| markdown-it@15.0.3 | `sha512-+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==` |
| @highlightjs/cdn-assets@11.12.0 | `sha512-KvOKXODaiFmId9xaq3xc5xCL66wVLUuOngDbO9B/kewbFTqdGbn2nJxNhN3H5R1cgDTVj6R8vH0zgiNDEGjpDw==` |
| mermaid@12.3.0 | `sha512-4113TdXeLAsMruJ79OpFL5O8+LTFXhQqZ260rF3tgUmiNAtRm4Uume04I+65PRN6yZ69J4f8rVYWW8zRk65UYw==` |

`npm audit` on a scratch project pinning these exact versions (plus `dompurify@3.4.17`, the version whose banner is inside
`mermaid.min.js`) reported 0 vulnerabilities. Caveat: the audit resolves Mermaid's other dependencies (d3, katex,
marked, ...) at today's versions, not at the versions bundled into `mermaid.min.js` when it was built; DOMPurify, the
one that guards Mermaid's output, is checked at the bundled version.

## SHA-256 of the vendored files

```
1ed8fc5256b738b8875b74e4d3f0754f60d6411fb034d618dfbc4e6e6c9999d7  highlight.js/highlight.min.js
ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4  htm/htm.module.js
336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3  mermaid/mermaid.min.js
a6ee626f2d01570592dd569a792e3f050154aa02890eead8c223fa3ed5aa3d5a  preact/hooks.module.js
c30e721ebfdc6e2ad4c18c14d2dfb82667829c8aec27de1207774e3fc16858a8  preact/preact.module.js
d5432491790141da046b1197353705db03264f40b5727f3b4b591f5aba193e30  markdown-it/markdown-it.esm.min.mjs
```

Verify with `cd kosmos-review/vendor && sha256sum -c` against the block above (paste it into a file first).

## Updating

Change the version in the URL, download over the old file, update this table, the integrity values and the hashes
(re-run the `npm pack` comparison above), then run `node --test test/*.test.js` from `kosmos-review/`. Do not upgrade
one Preact file without the other.

When the tool moves to Vite + React these files are replaced by `package.json` dependencies, but that is not the only
change: see "Moving to Vite + React later" in the main README for the real list of touch points.
