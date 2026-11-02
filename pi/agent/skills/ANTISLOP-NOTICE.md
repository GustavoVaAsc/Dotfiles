# Anti-slop skills — attribution

The `antislop*` skill folders in this directory are vendored, verbatim copies
of the anti-slop skill pack by Miqdad Badjuber. They are kept in the Dotfiles
repo so a new machine gets them from `git clone` + `ai-harness-install.sh` with no
npx/npm-registry access.

- Upstream repository: <https://github.com/miqdadbadjuber/anti-slop>
- Vendored version: `3.2.20`
- Pinned commit: `b1cdf87d49b1653293d58424516fd80394008345`
- License: MIT (full text below)

To refresh the vendored copy from upstream (the only step that needs network;
normal installs do not fetch anything):

```sh
bin/update-antislop.sh            # re-vendor the pinned commit above
bin/update-antislop.sh <ref>      # re-vendor a specific tag or commit SHA
```

The script updates the version and pinned commit lines in this file as part
of the refresh.

## Upstream LICENSE (MIT)

```
MIT License

Copyright (c) 2026 Miqdad Badjuber (antislop)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
