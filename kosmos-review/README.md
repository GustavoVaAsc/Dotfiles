# kosmos-review

A local browser page for reviewing a Markdown document an agent wrote. The reviewer reads it rendered, answers the
questions embedded in it, leaves comments anchored to source lines, and submits. The submission is a JSON file in the
repo; the agent reads that file, addresses every comment and answer, edits the document, and starts the next round.

This is backlog item 16. The feedback channel is the `round-N.json` file. How it reaches the agent depends on the
runtime (the `artifact-review` skill describes the loop):

- **Claude Code and Pi: automatic.** The agent starts `kosmos-review wait` in the background (Claude Code's
  `run_in_background`, or the `review_watch` tool of the Pi extension) and ends its turn; when the round is submitted the
  session is woken with it. The page says "sent to the agent" when someone is listening.
- **OpenCode and anything else: manual.** The user types "review submitted" in chat and the agent runs
  `kosmos-review latest`.

The agent never blocks waiting for a review.

**TODO (OpenCode):** automatic delivery for OpenCode. It needs a plugin or hook that can start a turn from outside the
session; until then OpenCode keeps the manual flow. (To be added to the backlog.)

The folder is self-contained. Nothing outside it depends on its internals except the `artifact-review` skill, which
only calls the CLI entry point `kosmos-review/kosmos-review`.

## Quick start

```bash
# the agent writes docs/reviews/<slug>/doc.md in the target project, then:
~/Dotfiles/kosmos-review/kosmos-review check <project-root> <slug>    # validate question fences
~/Dotfiles/kosmos-review/kosmos-review serve <project-root> <slug>    # prints the URL and returns at once
```

A fresh server is opened in your default browser for you (see "Auto-open"); the printed `URL:` line is always there
too. It looks like `http://127.0.0.1:43949/#token=...`; the token after `#` is what lets the page read and write the
review, so open the whole URL if you open it yourself.

Requirements: Node 20.6 or newer. There is no install step and no build step.

## CLI

```
kosmos-review serve  <project-root> <slug> [--idle-minutes N] [--no-open]
                                                                start (or reuse) the server, print the URL, return at once;
                                                                a fresh server is opened in the browser unless --no-open
kosmos-review wait   <project-root> <slug> [--timeout-minutes N] [--after N]
                                                                block until a round is submitted; print its path and JSON
kosmos-review check  <project-root> <slug>                      validate the kosmos-question fences in doc.md
kosmos-review latest <project-root> <slug>                      print the absolute path of the newest round-N.json
kosmos-review stop   <project-root> <slug>                      stop the server
```

Exit codes: `0` ok, `1` runtime failure or "no round yet" (`latest`) or problems found (`check`), `2` bad usage or
invalid project/slug/missing `doc.md`. `latest` only counts regular files named `round-N.json`.

`serve` does not block the caller. It starts the server as a detached background process and exits once the server
answers. A second `serve` for the same review folder finds the running server (through a private registry entry plus a
health probe) and prints the same URL. The server stops by itself after 120 minutes without an authenticated request
(`--idle-minutes`, fractions allowed, at least one second). While the page is open and visible it pings every
minute through the authenticated `GET /api/ping`, so a visible open tab keeps the server alive and the idle exit applies
once the tab is hidden or closed. Only requests that carry the token count as activity: rejected requests, `/healthz`
(which the CLI probes) and static files do not, so a web page firing blind requests at the port cannot keep the server
running. If the server is gone the page says so and that the last autosaved draft is on disk; the notice clears itself
when the server answers again. `serve --foreground` runs it in the terminal for debugging and refuses to start when a
server for the folder is already running. `stop` sends SIGTERM, escalates to SIGKILL after 3 s if the server still
answers, and deletes the server's log on a clean stop.

Start-up is serialised with a lock file that holds the starter's pid; a lock left by a dead process is taken over at once.

`project-root` must be the repository root (the directory that holds `.git`): the "keep this review?" question and the
`.git/info/exclude` append look for `<project-root>/.git` only. A second `serve` that reuses a running server also pings it
with its token, so asking for the URL again resets the idle timer.

The registry lives in `$KOSMOS_REVIEW_STATE_DIR`, else `$XDG_RUNTIME_DIR/kosmos-review`, else
`<tmpdir>/kosmos-review-<uid>`; the directory is created private (`0700`), entries are `0600`, and nothing is written
inside the repository for it. Each server's stderr goes to `<state dir>/<id>.log`.

### Auto-open

`serve` opens the page in the default browser only when it starts a fresh server, never when it reuses a running one
(so a second `serve` does not add a tab). `--no-open` turns it off. On Linux it runs `/usr/bin/xdg-open`, and does
nothing (silently) when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set (SSH, headless); on macOS it runs `/usr/bin/open`
(absolute paths, never looked up on `PATH`; a missing binary just means "not opened"). The opener is a detached child
started with a single argument and no shell, and its failures are ignored.

**The browser is never given the token, nor a ticket.** A browser's command line stays readable
(`/proc/<pid>/cmdline`) by other local users for as long as it runs, and a one-time ticket in it could be redeemed for
the token by any of them within its lifetime. So the opener is handed only the `file://` URL of a launcher page,
`<state dir>/<id>.open.html` (mode 0600 in the private 0700 state directory, written by `serve` with `O_EXCL|O_NOFOLLOW`),
which redirects (meta refresh, plus a plain link) to `http://127.0.0.1:<port>/#ticket=<random>`. The ticket is minted by
the server (authenticated `POST /api/ticket`), single use, valid 60 s, at most 8 outstanding. The server deletes the
launcher the moment a ticket is redeemed, 45 s after each mint even if it never is (long enough for a cold browser start, shorter than the 60 s ticket life), at start (a stale one) and on close.
The page removes the ticket from the address bar at once and swaps it, once, for the real token with
`POST /api/session` (the ticket is the credential there; the usual Host, Origin, `Sec-Fetch-Site` and JSON guards still
apply; failed attempts are not activity). When that exchange fails the page says so plainly ("This link was already used
or expired") and how to get a fresh one. The opener refuses any URL that is not exactly such a launcher path, so it can
never be handed a token or a ticket, even by mistake. The URL printed for the agent stays the token URL: the agent's
transcript already holds the token, and a single-use link would be useless for opening the review in another browser.
The output says `Browser: launch requested (xdg-open); if no review page appears, open the URL above` or
`Browser: not opened (<reason>)`. It says "launch requested" rather than "opened" because it cannot see the result: a
sandboxed browser (snap or flatpak Firefox, the Ubuntu default) often cannot read a `file://` page in the runtime
directory, and the CLI is not told. The skill therefore always gives the user the URL as well. The opener is told the
exact `file://` URL to expect (`pathToFileURL(<state dir>/<id>.open.html)`, computed by the CLI) and refuses anything
that differs, instead of matching a character pattern, so state paths containing `@ = , ( )` or non-ASCII work.
`serve --foreground` (debugging) does not open anything.

### `wait`: getting the submitted round to the agent

`kosmos-review wait <project-root> <slug> [--timeout-minutes N] [--after N]` blocks until a round is submitted, then
prints `Round file: <absolute path>` followed by the round's JSON and exits 0. Only regular files named `round-N.json`
count. By default only rounds newer than the newest one at start count; with `--after N` the first round greater than
`N` is delivered, even if it was submitted before `wait` started (the skill passes the number of the last round the
agent handled, and the Pi extension tracks it), one round at a time, lowest first. The timeout never exceeds the running
server's idle timeout (120 minutes without a server); a larger `--timeout-minutes` is capped to it, so a wait cannot
outlive the review it serves. Exit codes: `3` timed out, `4` another `wait` for the same review is already running
(a lock file with the waiter's pid; a dead owner's, or one older than any possible wait, is taken over), `5` the file
is not an authentic round (see below), `2` bad usage, `143` terminated. It wakes on `fs.watch` events and also polls
every 2 s, so a missing or failing watcher only costs latency, and it sleeps between wake-ups (it never spins). It
watches files, not the server, so it keeps working if the server idles out or is stopped.

**It cannot be orphaned.** `wait` exits (143, after unregistering) when its parent process dies, checked once a second,
and with `--watch-stdin` when its stdin pipe closes; the Pi extension uses both. `--ignore-parent` turns the parent
check off for a harness that daemonizes its commands.

**Rounds are authenticated.** `serve` creates a random 256-bit key per review at
`$XDG_STATE_HOME/kosmos-review/<id>.key` (default `~/.local/state/kosmos-review/<id>.key`; the directory 0700 and
owner-checked, the file 0600; never in the repository), where `<id>` is the first 16 hex digits of the SHA-256 of the
review folder's real path. It deliberately lives in the state home, not in the runtime directory that holds the
registry, so rounds the server wrote stay verifiable after logout. (`KOSMOS_REVIEW_STATE_DIR`, used by the tests,
keeps the key next to the registry instead.) The server adds
`"mac": "hmac-sha256:<hex>"` to every `round-N.json` it writes: an HMAC-SHA256 over the canonical (sorted-key) JSON of the
round without the `mac`. `wait` and `latest` open the file without following symlinks, refuse non-regular or oversized
(> 4 MiB) files, parse it, verify the MAC, check it against a strict round schema, require that the round number inside equals the one in the file name and that the
slug is this review's (so a genuine round copied to `round-9.json` is not a new submission), and rebuild it from known
fields. What
`wait` prints is that rebuilt round, without the `mac`, with `<` and `>` written as `\u003c` and `\u003e` (it decodes to
the same text, and no tag can be closed from inside it). If any step fails (a plain-text file, valid-looking JSON with no
or a wrong MAC, a missing key) it prints only `Round file: <path>`, a `Round number: N` line (so the agent can re-arm with `--after N` past a file it
must not read) and an `UNVERIFIED: ... NOT written by the review server ... ask the user before reading` line, no
content, and exits 5; `latest` prints the path and the same warning on
stderr and exits 5. I chose an HMAC over a server-side ledger of round hashes because it needs no state beyond one key
file, works across server restarts, and verifies a file without asking the server (which may be stopped). The key
lives in the same trust domain as the user's own processes, so this stops files that arrive through the repository (a
pull or checkout), other tools and other users. It does **not** protect against the agent itself, or any process running
as the same user: they can read the key file, so anything that must be kept from the agent needs a permission rule that
denies reading `~/.local/state/kosmos-review/` (or `$XDG_STATE_HOME/kosmos-review/`). I did not add a ledger of delivered
rounds: a replay can only come from a new file name, which the number check catches, and the same name cannot be created
twice.

**Listener registration.** While it waits, `wait` tells the server that someone is listening: an authenticated
`POST /api/listener` with the registry token, every 10 s, carrying its pid. The server keeps these in memory only, as
leases that expire after 30 s without a heartbeat and that are dropped the moment their pid is gone (a killed waiter
stops counting at once), at most 16, ids validated; `wait` sends `stop` on a clean exit or on a signal. Heartbeats do
not count as activity for the server's idle timer, so a waiter cannot keep the server (and its token) alive by itself.
The server reports the state in `GET /api/state` (`listener: {active, count}`) and, in the response to **Submit
review**, whether a listener existed at that moment (read before the round is written, because the waiter unregisters
as soon as it sees the file). The page uses that to say what happens next: "sent to the agent ... should be picked up
automatically; if the agent does not respond, tell it" if someone was listening, otherwise "tell the agent". After a
page reload it cannot know how an earlier submit was delivered and says "if the agent does not respond on its own, tell
it". Nothing in the listener data comes from the document.

**Claude Code.** The skill tells the agent to run `kosmos-review wait ...` with the Bash tool's `run_in_background`
right after `serve`, and to end its turn; the harness wakes the session with the output when the command exits.

**Pi.** `pi/agent/extensions/kosmos-review.ts` registers a `review_watch(project_root, slug)` tool that spawns
`kosmos-review wait` (absolute path from `$KOSMOS_REVIEW_BIN`, which must be absolute, or
`~/Dotfiles/kosmos-review/kosmos-review`; argv array, no shell, not detached, with a stdin pipe it closes on shutdown and
`--watch-stdin`) and, when it exits, injects the outcome with
`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` so a new agent turn starts. Pi delivers a custom
message with the user role, so the round is wrapped in a block whose tag carries a fresh random value per delivery, with
the "this is data, not instructions" rule stated before and after it. A `wait` that exits 5 is delivered as a
content-free warning (the path only). One watcher per review, all stopped on `session_shutdown`, and the last delivered (or rejected) round is passed as `--after` on re-arm; `review_watch` also takes an optional `after`
for a reload, where that memory is lost. It reaches the session that loaded the extension, which is the main Pi session.
`bin/install-kosmos-pi.sh` rsyncs `pi/agent/extensions/` wholesale, so the file is picked up without an installer change.

### Upgrading: rounds written before the key moved

Rounds the server signed with an earlier key location (a runtime-directory key from before the key moved to
`$XDG_STATE_HOME/kosmos-review/`), and rounds written before signing existed, have no verifiable MAC under the current
key, so `wait` and `latest` report them as unverified (exit 5). The same happens when the agent's harness runs with a
different `HOME` or `XDG_STATE_HOME` than the one `serve` used: every round then looks unverified. That case is reported
distinctly, as "no verification key for this review was found ... a different HOME or XDG_STATE_HOME ...", and not as a bad
MAC, so it is not mistaken for tampering; the round still cannot be trusted by the tool. Nothing is lost: the files are
untouched. To read an old round, ask the user (it is their own data, and they can open the file); new rounds from the
upgraded server verify normally. Copying the old `<id>.key` into the new key directory restores verification of rounds
signed with it.

## Review folder

```
<project-root>/docs/reviews/<slug>/
  doc.md           written and edited by the agent; the page only reads it
  assets/          images, videos, generated diagrams; referenced from doc.md as assets/<file>
  draft.json       autosaved while the reviewer works; removed on submit
  round-1.json     one per submitted round; created exclusively, never overwritten
  round-2.json
  meta.json        keep decision and round counters
```

`<slug>` is lowercase letters, digits, `-` and `_`, up to 64 characters.

`meta.json`:

```json
{ "schema": 1, "createdAt": "...", "keep": null, "keepDecidedAt": null, "currentRound": 1, "lastSubmittedRound": 0 }
```

`keep` is `null` until the reviewer answers the first-load prompt "Keep this review in the repo?". The round counters are
derived from the `round-N.json` files on every read, so they cannot drift from them.

- **Keep (yes):** nothing special; the folder is tracked like any file.
- **Do not keep:** `/docs/reviews/<slug>/` is appended to `<project-root>/.git/info/exclude` (idempotent, local only,
  `.gitignore` is never touched). The decision is stored in `meta.json` and never asked again.
- **Worktrees and submodules** (`.git` is a file): the question is still asked, and "no" is still recorded, but nothing
  is written automatically. The page shows the line to add (`/docs/reviews/<slug>/`) and the command that prints the
  file to add it to (`git rev-parse --git-path info/exclude`). The `.git` file, `commondir` and config behind it are
  repository-controlled, so following them could steer a write into a different repository.
- **Not a git repo:** the question is skipped. Ignoring a folder does not untrack files that were already committed.

## Writing the document

Standard Markdown (headings, lists, tables, fenced code with syntax highlighting, images, links) plus two additions.
Raw HTML in the document is escaped, not rendered.

**Mermaid diagrams:** a fenced block with the info string `mermaid`. Outside the reviewer it still reads as a code block.

**Images and videos:** `![caption](assets/shape.svg)`. Only paths under `assets/` work (no `..`, no URLs, no absolute
paths). A video file extension (`mp4`, `m4v`, `webm`, `ogv`, `mov`) renders a `<video controls>`. Allowed types:
png, jpg, gif, webp, avif, svg, mp4, m4v, webm, ogv, mov, mp3, wav, ogg, vtt.

**Questions:** a fence whose info string is `kosmos-question`. Outside the reviewer it still reads as a plain code block.

````markdown
```kosmos-question
id: session-store
type: single
prompt: Where should sessions live? (see `docs/auth.md`)
options:
  - Signed cookie (stateless)
  - Redis
  - Postgres
```
````

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Stable identifier, unique in the document: letters, digits, `_`, `.`, `-`, max 64. Keep it across rounds when the question is the same. |
| `type` | yes | `single` (radio buttons), `multi` (checkboxes) or `text` (textarea). |
| `prompt` | yes | The question, up to 2000 characters. Inline Markdown (code, emphasis, links) is rendered. May continue on indented lines. |
| `options` | for `single`/`multi` | 2 to 30 labels, one `- label` per line, each unique and up to 300 characters. Forbidden for `text`. |

`single` and `multi` also get an "Other" free-text field. The body is a strict subset of YAML: keys start in column 0;
`#` starts a comment only at the start of a line (so `Issue #42` is fine inside a value); a value is plain (verbatim),
`"double quoted"` (a JSON string) or `'single quoted'`; unknown keys, repeated keys and malformed lines are errors. A
body that starts with `{` is read as strict JSON with the same keys:

```json
{"id": "extras", "type": "multi", "prompt": "Which extras?", "options": ["Rate limiting", "Audit log"]}
```

Question fences must be at the top level of the document (not inside a list or quote). A malformed fence renders as an
error box with the problems and the raw text; run `kosmos-review check` to get the same problems as `doc.md:LINE: message`.

## Using the page

- **Read:** headings, lists, tables, code, diagrams, images and videos render in a purple theme (dark and light,
  CSS custom properties in `web/styles/theme.css`; the switch is in the top bar).
- **Comment:** hover a paragraph, heading, list item, table row, code block or question; click the **+** in the left
  margin. Shift+click the **+** of another block to extend the open comment over a range. The side panel also has a
  "Comment on lines [from] to [to]" form as a keyboard alternative. Ctrl+Enter saves.
- **Answer:** click options or type; answers and comments autosave to `draft.json` about 0.7 s after each change and
  when the tab is hidden. Reloading the page restores the draft.
- **Submit review:** first saves any pending draft edits, then writes `round-N.json` and clears the draft. The page then
  shows one banner and a summary of what was submitted, and is read-only. The banner says "Round N sent to the agent"
  when a waiting agent was registered at that moment, "Tell the agent \"review submitted\"" when none was, and, after a
  reload, "if the agent does not respond on its own, tell it".
  After the agent updates `doc.md`, **Reload document** opens the next round. **Start another round on this version**
  re-opens the same document without waiting for an agent edit.
- If `doc.md` changed after the page loaded, submit is refused with a reload prompt (the draft is kept). Comments made
  against an older version are marked "earlier version".

## `round-N.json`

Written by the server on submit; the agent reads it. The server rebuilds it from validated fields, adds `round`,
`slug`, `docFile`, `submittedAt` and `answered`, and sorts comments by line.

```json
{
  "schema": 1,
  "round": 1,
  "slug": "auth-design",
  "docFile": "docs/reviews/auth-design/doc.md",
  "submittedAt": "2026-11-10T02:28:31.584Z",
  "docHash": "sha256:20d9d5...",
  "overall": "Overall: looks good, two nits.",
  "comments": [
    {
      "id": "c1",
      "startLine": 3,
      "endLine": 3,
      "quote": "We need to pick a session strategy.",
      "docHash": "sha256:20d9d5...",
      "text": "Say which constraints drive the choice.",
      "createdAt": "2026-11-10T02:28:31.576Z"
    }
  ],
  "answers": [
    { "id": "session-store", "type": "single", "prompt": "Where should sessions live?",
      "selected": [{ "index": 1, "label": "Redis" }], "other": "", "text": "", "answered": true },
    { "id": "extras", "type": "multi", "prompt": "Which extras are in scope?",
      "selected": [{ "index": 0, "label": "Rate limiting" }], "other": "Device list", "text": "", "answered": true },
    { "id": "constraints", "type": "text", "prompt": "Any constraint I missed?",
      "selected": [], "other": "", "text": "", "answered": false }
  ]
}
```

| Field | Meaning |
|---|---|
| `round` | 1-based; the highest number is the latest. Files are never rewritten. |
| `docHash` | `sha256:` of the exact bytes of `doc.md` the reviewer was looking at. |
| `comments[].startLine` / `endLine` | 1-based, inclusive source lines of the commented block(s) in `doc.md` at `docHash`. |
| `comments[].quote` | The anchored source text (whitespace collapsed, at most 160 characters). Use it to find the spot if `doc.md` changed since. |
| `comments[].docHash` | The document version the comment was made against. Differs from `docHash` if the reviewer reloaded after an edit. |
| `answers[]` | One entry per question in the document, answered or not. `selected` has option `index` (0-based) and `label`; `other` is the free-text field; `text` is the answer to a `text` question; `answered` is computed by the server. |
| `overall` | Optional note not tied to a line. |
| `mac` | The review server's signature over the rest of the round (see "Rounds are authenticated"). `wait` removes it from what it prints; ignore it if you read the file. |

An empty round (no comments, nothing answered, empty `overall`) means the reviewer approved the document as it is.

`draft.json` has the same shape without `round`, `slug`, `docFile`, `submittedAt` and `answered`, plus `savedAt`. It is
work in progress, not a submission.

## Security model

| Concern | Control |
|---|---|
| Network exposure | Binds `127.0.0.1` only (explicit host in `listen`), random port per server. |
| DNS rebinding | Every request's `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`; anything else gets 403. |
| Other local pages / CSRF | A random 192-bit token per server, compared in constant time, sent as `Authorization: Bearer` on every `/api` and `/assets` request. It travels in the URL fragment (never in a request line or Referer), is kept in `sessionStorage`, and is removed from the address bar. Writes also require `Content-Type: application/json` (forces a CORS preflight that is never granted), refuse a mismatching `Origin`, and refuse `Sec-Fetch-Site` other than `same-origin`/`none`. No CORS headers are ever sent. Only the app shell and its static code are served without the token; they hold no project data. |
| Write confinement | The client never sends a path for a write. The server writes only `draft.json`, `meta.json` and `round-N.json` (N from an integer counter) in the one review folder, plus one append to `<project-root>/.git/info/exclude`. A planted symlink at those names is replaced, not followed (`rename`, and `link` for rounds); the exclude file is opened with `O_NOFOLLOW`. The folder's `dev`/`ino` are recorded at start, and before every write (temp file, `link`, `rename`, draft removal) the server checks that `docs/reviews/<slug>` is still a plain directory, that its `realpath` is unchanged and that `dev`/`ino` still match; otherwise the write is refused with 409. Swapping the folder for a symlink while the server runs therefore cannot redirect writes. |
| `.git/info/exclude` | Written only when `<project-root>/.git` is a real directory (lstat, not a symlink) with `HEAD` as a regular file and `objects/` as a real directory; `info/` must be a plain directory (a symlink is refused) and only `info/` itself is created (never parents). When `.git` is a file (worktree or submodule) nothing is written and the user gets the manual instruction, because the pointer, `commondir` and config files are untrusted. Every git metadata read uses `O_NOFOLLOW` + `O_NONBLOCK`, checks the opened handle is a regular file, and refuses files over 64 KiB; a failure makes the folder "not a git repo" (state endpoint stays 200) or, on the write path, a clear 409. The exclude file is opened with `O_NOFOLLOW`, and the append is refused (409) when the opened file has more than one hard link (a second name could sit outside the repository) or its `dev`/`ino` no longer match the path. The keep decision is serialised in-process, so parallel answers append once. |
| Read confinement | `doc.md`, `draft.json`, `meta.json`, assets and static files go through `confine()`: lexical check (no empty, absolute, drive-letter, backslash, NUL, `.`, `..`, dot-prefixed or empty segments) then `realpath`, which must stay inside the root. Symlinks that leave the folder are refused. The review folder and `doc.md` themselves must not be symlinks, and must resolve inside the project root. Assets are served only for a fixed list of media extensions, with `Content-Security-Policy: sandbox` and `nosniff`; the file is opened with `O_NOFOLLOW`, its `dev`/`ino` are compared with an `lstat` taken just before, and it is streamed from that handle. Only regular files named `round-N.json` count as rounds. |
| SVG and `blob:` URLs | An asset is shown from a same-origin `blob:` URL, and an SVG opened from one in its own tab would run its scripts with access to `sessionStorage` (the token). Images therefore revoke their URL as soon as they have loaded (SVG stays supported because generated diagrams are a main use), so "open image in new tab" fails; videos keep theirs because streaming needs it. |
| Request abuse | Bodies capped at 512 KiB (413 beyond that), 30 s request timeout, strict schema validation that rebuilds the object from known fields (limits on counts, lengths, ids, hashes), atomic writes (temp file in the same folder, fsync, rename). |
| Rendering untrusted Markdown | markdown-it with `html: false`; its link validation refuses `javascript:`, `vbscript:`, `data:` links; images never get a `src` from the document (only `assets/` paths, fetched with the token and shown from `blob:` URLs); relative links lose their `href`; comments and answers are rendered as text. Mermaid runs with `securityLevel: 'strict'`. |
| Defense in depth | CSP on the shell: `default-src 'none'`, scripts from `'self'` plus a per-response nonce (for the import map), no `unsafe-eval`, no remote images, `connect-src 'self'`, `frame-ancestors 'none'`. |
| Process spawn | `serve` may start the system opener (`/usr/bin/xdg-open` / `/usr/bin/open`, absolute, never via `PATH`) detached, with `stdio: 'ignore'`, no shell, and the URL as its only argument; only the `file://` URL of the launcher page `<state dir>/<16 hex>.open.html` is accepted (anything else, including a token or ticket URL or strings that look like options, is refused), a missing display or binary skips it, and spawn failures are ignored. The browser's command line therefore never holds the token or a ticket. The Pi extension spawns `kosmos-review wait` by an absolute path (`KOSMOS_REVIEW_BIN` must be absolute) with an argv array and no shell, and the slug is validated, the project root must be absolute and contain `doc.md`. |
| Launcher file | `<state dir>/<id>.open.html` holds the one-time ticket URL: 0600 in the 0700 owner-checked state directory, created with `O_EXCL|O_NOFOLLOW` after removing whatever was at the name, only ever containing our own loopback ticket URL (validated), deleted on redemption, after 30 s, at start and on close. |
| Bootstrap tickets | `POST /api/ticket` needs the token; `POST /api/session` is authenticated by the ticket alone (192 random bits, single use, deleted on any attempt, 60 s lifetime, 8 outstanding at most) plus the Host, `Origin`, `Sec-Fetch-Site` and JSON-content-type guards; a failed attempt is not activity. A ticket is not accepted as a bearer token. |
| Authentic rounds | A round file in the repository is untrusted input. The server signs the rounds it writes with an HMAC key kept outside the repository, and `wait`/`latest` print nothing of a file that fails the MAC check, the strict schema, or the safe-open checks (`O_NOFOLLOW`, regular file, size cap). Printed JSON has `<` and `>` escaped. See "Rounds are authenticated" for what this does and does not stop. |
| Listener endpoint | `POST /api/listener` is a write route: token, JSON content type, `Origin` and `Sec-Fetch-Site` checks like every other write, strict body (`id` 8-64 chars of `[A-Za-z0-9_-]`, `action` `beat` or `stop`), at most 16 listeners, a validated pid, in-memory leases that expire after 30 s and die with their pid, and it is not activity for the idle timer (a waiter cannot keep the server alive). It changes nothing on disk and exposes only a boolean and a count. |
| `wait` output and the Pi message | The round JSON contains text the reviewer wrote and text copied from the document (`quote`, `prompt`, `label`), so it is untrusted input to the agent. Both the skill and the Pi extension frame it as data to act on by editing `doc.md`, never as instructions (no shell commands, installs, fetches or edits outside the review folder); the Pi extension puts that framing before the data and keeps the data in one `<review-round>` block, and does not paste rounds over 100 KB. `wait` itself only reads one regular file of at most 4 MiB from the review folder. |
| Token at rest | Only in the `0600` registry entry in the private state directory and in the URL handed to the user; never in the repo or in the server log. The URL is printed by `serve`, so it also lands in the agent's transcript and tool output: treat that transcript as holding a (loopback-only, short-lived) credential for the review. Restarting the server issues a new token. |

Known limits:

- The Host/Origin/token checks protect against browsers and other local users' browser sessions, not against another
  process of the same Unix user, which can read the registry entry and the repo anyway.
- **Remaining race window.** Node has no `openat()`, so every path-based filesystem call re-resolves the whole path. The
  write guard and the asset reader shrink the window between "checked" and "used" to a few microseconds and close it
  for the final path component (`O_NOFOLLOW`, `dev`/`ino`), but a parent directory swapped for a symlink inside that
  window is not detectable from Node. Exploiting it needs write access to the project directory at that exact moment,
  which already lets an attacker edit the repo directly.
- A second tab on the same review overwrites the first tab's draft (last write wins).

## Making anchors robust

Version 1 anchors a comment to whole source blocks by line number. Each comment already stores what the next steps
need: `startLine`/`endLine`, a `quote` of the anchored text, and the `docHash` of the version it was made against. The
planned steps, in the order they pay off:

1. **Re-anchor by quote when lines shift.** When `doc.md` changes, find each comment's `quote` in the new text (exact
   first, then whitespace-normalised, then fuzzy) and move its line range there, so a comment from round 1 still lands
   on the right paragraph after the agent inserted a section above it.
2. **Mark a comment "outdated" when its quote is gone.** If the quote cannot be found, keep the comment visible but
   flagged, so the agent and the reviewer both see that the text it referred to was rewritten or removed.
3. **Anchors inside a sentence.** Add `startChar`/`endChar` (offsets into the anchored source range) so a comment can
   target a phrase; `quote` then holds exactly that phrase, which also makes step 1 more precise.
4. **Diffs between rounds.** Keep each round's `doc.md` (or its hash plus a stored copy), diff round N against N+1,
   and show what changed; with steps 1-2 this lets the page show which comments were addressed.

Today the page already compares each comment's `docHash` with the current document and shows an "earlier version"
badge; that is the hook step 2 builds on.

## Layout of this folder

```
kosmos-review/
  kosmos-review         CLI entry point (executable, node)
  src/                  server and CLI (Node standard library only)
    cli.js server.js store.js paths.js security.js validate.js git-exclude.js registry.js mutex.js opener.js wait.js
  web/                  the page: native ES modules, Preact + htm, no build step
    index.html theme-init.js app.js
    components/         App, Header, Document, MarkdownChunk, Question, ReviewPanel, CommentComposer, CommentList, KeepPrompt
    state/              reducer.js, payload.js, autosave.js        (pure, framework-free)
    net/                client.js (server API), session.js (token)
    lib/                markdown.js, question-fence.js, anchors.js, mermaid.js, assets.js, theme.js, dom.js, html.js
    styles/             theme.css (tokens), app.css, markdown.css
  vendor/               pinned third-party libraries, see vendor/README.md
  test/                 node:test suites
  .gitattributes        marks vendor/ as vendored (no diffs, not counted as project language)
```

The URL space is `/` and `/<file>` (from `web/`), `/vendor/...`, `/healthz`, `/api/...`, `/assets/...`; do not create
`web/api/` or `web/assets/`, they would be shadowed.

### Moving to Vite + React later

The code is organised so that most of it moves unchanged, but the move is a real piece of work, not a swap of the
`vendor/` folder. What carries over as is: the server's API half (`src/`, apart from the static handler, item 3), `web/lib/markdown.js`, `question-fence.js`,
`anchors.js`, `web/state/*` (the reducer, payload and autosave logic have no DOM or framework imports) and `web/net/*`
(`client.js` takes `fetch` as a parameter), plus the CSS.

The real touch points:

1. **Library imports.** The browser resolves `preact`, `preact/hooks`, `htm`, `markdown-it` and `highlight.js` through
   the import map in `web/index.html`; under Vite they become ordinary `npm` dependencies and the import map is
   deleted. Node-side code (`src/cli.js`, the tests) uses `#markdown-it` and `#highlight.js` from `package.json`
   `imports`; those two lines would point at `node_modules` (or be replaced by plain `markdown-it` imports).
2. **Mermaid.** It is a classic script loaded lazily by URL from `<meta name="mermaid-src">` in `index.html`
   (`web/lib/mermaid.js`). Under Vite use `import('mermaid')`, which also removes the CSP need for `script-src 'self'`
   on that file.
3. **The `/vendor` route and the static handler** in `src/server.js` (`serveStatic`, `vendorDir`). Vite's dev server
   serves the page and proxies `/api`, `/assets` and `/healthz` to this server; production can keep a static handler
   for the built `dist/`. The CSP nonce injected into `index.html` must be reproduced (or the CSP relaxed for the import
   map, which no longer exists).
4. **Templates.** `web/lib/html.js` (htm bound to `h`) goes away and every `html\`...\`` template becomes JSX. Preact
   accepts `class`, so the templates use it; React needs `className` (and `htmlFor`, `onChange` semantics for inputs,
   `style` objects are already used).
5. **Escape hatches that React would fight.** Two places use `dangerouslySetInnerHTML` with markdown-it output
   (`components/MarkdownChunk.js`, and the inline renderer in `components/Question.js`) and then mutate that DOM
   directly: `MarkdownChunk.js` (asset `src`, Mermaid SVG via `lib/assets.js` and `lib/mermaid.js`) and
   `components/Document.js` (an effect that toggles `has-comment` / `is-composing` on the rendered blocks, plus
   `closest()`-based hover handling). Preact leaves that DOM alone while the HTML string is unchanged; React's
   reconciler does the same for `dangerouslySetInnerHTML`, but any re-keying of these components would wipe the
   mutations, so keep the effects keyed on the markup.
6. **Hooks shape.** `useEffect` cleanups and `useReducer` are used the React way; `preact/hooks` becomes `react`.
7. **Tests.** `test/fake-dom.js` and `test/ui.test.js` drive Preact through a fake DOM; with React they become
   Testing Library tests (or keep the logic tests and drop the fake DOM).

## Tests

```bash
cd ~/Dotfiles/kosmos-review
node --test test/*.test.js
```

Standard library runner only. Coverage: path confinement and traversal, Host/token/Origin checks, request validation,
round numbering and no-overwrite (including concurrent submits and planted symlinks), the review folder being swapped
for a symlink while the server runs, draft save/restore, the `.git/info/exclude` append (idempotent, only on "no",
serialised under concurrency, the forged `commondir` attack, real `git worktree`, hostile metadata files such as FIFOs and
sparse oversized files, symlink refusal, and a check with real `git` when it is installed), the question-fence parser (valid, malformed, strict), the Markdown pipeline (anchors, escaping, links,
images), the reducer/payload/autosave logic, the CLI end to end (detach, reuse, stop including SIGKILL escalation, stale
entry and stale lock, idle exit, `wait`: blocking, timeout, one per review, surviving a server stop, listener
registration), the opener with an injected spawn (nothing launches a browser in the tests), the listener endpoint, the
Pi extension against a fake `pi` and a stub binary (`test/pi-extension.test.js`, skipped when Pi is not installed), every file the page loads, and the whole component tree against a minimal fake DOM
(`test/fake-dom.js`).

What the automated tests cannot cover is a real browser. That was checked once by hand-driving headless Chrome (layout,
hover, Mermaid under the CSP, `blob:` images, drafts, submit, both themes); the driver is not part of the repo.
