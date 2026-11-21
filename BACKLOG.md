# AI Harness Backlog

Ideas for the kosmos agent system (Claude Code, Pi and OpenCode). Nothing here is planned yet.

## Open questions

- **Where the harness lives.** Decide whether to keep the harness in the dotfiles or move it to a self-contained project.

## Ideas

### 1. Memory system

Keep memory separately for each repository and workstream, and load it efficiently. The main goal is to limit context poisoning. The memory systems used so far bring in unrelated things, so recall should stay scoped to the current repo and workstream.

### 2. Own antislop

Build an in-house antislop based on the one currently installed. Its skills and tools should be managed here, not taken from upstream.

### 3. Coder command safety

Stop the coder agents from running commands that wait for a long time, and mitigate infinite loops in the commands they run.

### 4. Learning mode (`kosmos-mentor`)

Add a learning mode to the harness. It swaps the orchestrator for an agent named `kosmos-mentor`.

### 5. One source for the prompts

Write each agent prompt and skill once, then generate the Claude Code, Pi and OpenCode versions from it. Today the same rule is kept in sync by hand in several files.

### 6. Parity check

A script that compares what each harness actually installed and flags any drift between Claude Code, Pi and OpenCode.

### 7. `kosmos doctor`

One command that checks the setup:

- the symlinks and installers;
- the provider keys and the MiMo cookie (present, not expired);
- that the MCP servers are reachable;
- that the agent files load.

### 8. Test setup for extensions

A committed tsconfig and a small test runner for `pi/agent/extensions/`. Right now type checks borrow a TypeScript binary from another project, and the extensions have no tests.

### 9. Findings ledger

Record code-review findings per repository. Findings that keep coming back get fed into future coder briefs.

> **Needs more thought:** this could be invasive. Assess it properly before committing to it.

### 10. Budget guardrails

A spend cap per task or per session, with a warning in the footer and a hard stop for runaway subagents.

> **Needs more thought:** assess this properly before committing to it.

### 11. Parallel coders in isolated worktrees

Give each coder its own git worktree, so independent changes can run in parallel without stepping on each other.

### 12. Workstream handoff notes

At the end of a session, write a short summary of decisions, open questions and next steps. This could feed the memory system (item 1).

### 13. Completion notifications

A desktop or kitty notification when a long delegation or review loop finishes, or needs input.

### 14. Secret scrubbing

Catch API keys, cookies and tokens before they are written to transcripts or logs.

### 15. Tools called from code instead of loaded into context

Based on Anthropic's engineering posts on code execution with MCP. Don't load every tool definition into context up front. The agent discovers tools when it needs them and writes a small script that calls them. Large results are filtered in that script, so only a summary comes back into context. This lowers the hidden token cost of tool definitions and large tool results, which grows with every MCP server registered. Skills already load only when needed; this applies the same idea to tools.

### 16. Artifact reviewer

A browser page for reviewing a Markdown document the agent wrote, then sending structured feedback back to the agent. It doubles as a way to produce documentation and designs that live in the repo.

- **Rendering:** a purple theme; headers, lists, tables, code; Mermaid diagrams (flowcharts and similar); images and videos the agent generated (JavaScript rendering, manim or any other tool), referenced from the document.
- **Questions:** the agent embeds questions in the document in a standard format. The page renders them as single choice, multiple choice or free text, so the reviewer clicks an option or writes their own answer.
- **Comments:** comments anchored to a line (or range) of the Markdown source, saying what should change and how.
- **Review loop:** comments and answers are saved as the review goes, then submitted together when the review is done. The agent receives them with line references, addresses them, and the next round starts.
- **Storage:** documents, their assets and the reviews are saved in the repo.

**Status: v1 built** in `kosmos-review/`, with the `artifact-review` skill for Claude Code, OpenCode and Pi. See `kosmos-review/README.md` for usage, the question format and the `round-N.json` schema.

Decisions taken for v1:

- **Feedback channel:** files. The page writes `round-N.json` and the agent reads the latest round. The agent never blocks its turn waiting for a review.
  - *Revised after v1:* in Claude Code the agent runs `kosmos-review wait` as a background command that wakes the session on submit; in Pi the `review_watch` extension tool delivers the round and starts a turn. "review submitted" in chat stays as the fallback, and is still the only channel in OpenCode.
- **Opening the page:** `serve` opens the browser on a fresh start (`--no-open` to disable, skipped without a display).
- **When to use it:** the orchestrator prompts (all runtimes, and Pi's `SYSTEM.md`) choose between asking directly and a review document: 1 to 4 short decisions are asked directly, anything that needs a document to read becomes a review document, borderline cases ask first. Only the session the user talks to opens one; in Pi that is the main session, because the round is delivered there.
- **Toolchain:** Node server with no dependencies, Preact + htm page with no build step, libraries vendored at pinned versions. Structured so a move to Vite + React is mechanical.
- **Questions:** a `kosmos-question` fenced block (single, multi, text).
- **Anchors:** block-level line ranges. Each comment also stores a quote and the doc hash, for the robustness steps below.
- **Storage:** `docs/reviews/<slug>/` in the target project. On first load the page asks whether to keep the review; "no" adds the folder to `.git/info/exclude`.
- **Location:** Dotfiles for now; the whole `kosmos-review/` folder moves with the agent system if it gets its own repo.

Follow-ups:

- **Robust anchors:** re-anchor comments by quote when lines shift, mark a comment "outdated" when its quote is gone, comments on part of a sentence (character ranges), and a diff view between rounds. The steps are in the README section "Making anchors robust".
- **Draft safety net:** mirror the draft to `sessionStorage` while the server is unreachable, so edits made after an idle shutdown are not lost.
- **CLI on `PATH`:** the skill hardcodes `~/Dotfiles/kosmos-review/kosmos-review`. An installer symlink into `~/.local/bin` would remove that (the Claude installer needs it too).
- **Pi package:** the skill is left out of the published `kosmos-pi` npm package because the tool is not in it. Ship it once `kosmos-review` is its own repo or package.
- **Browser coverage:** v1 was checked in headless Chrome only. Firefox, Safari, touch devices, video playback and narrow layouts are untested. The Chrome smoke scripts could become an opt-in test.
- **Vendored Mermaid:** 5.5 MB in the repo. When the tool is extracted, decide between Git LFS and fetching it on demand.
- **Stale start lock:** a lock left by a crashed `serve` whose pid gets reused by a long-lived process blocks `serve` until the lock is deleted by hand.
- **Worktrees and submodules:** when `.git` is a file, "do not keep" writes nothing and shows the line to add by hand, because following git's links let the write be steered into another repository. A safe automatic path would need git's own layout checks (or `git rev-parse --git-path` run with a hardened config).
- **Token rotation:** the URL token stays the same while a server is reused, and it appears in agent transcripts. Rotating it on reuse would shorten its life.
- **TODO: OpenCode auto-send.** Claude Code and Pi deliver the submitted round automatically; OpenCode still needs "review submitted" in chat. Investigate whether an OpenCode plugin can watch the review folder (or run `kosmos-review wait`) and post the round into the session so it starts a turn.
- **Live runtime checks:** the Claude Code background `wait` and the Pi `review_watch` delivery were tested with unit tests and a fake `pi`, not in a live session. Confirm both end to end, including whether Claude Code limits how long a background command may run.

Open ideas:

- **MCP server channel:** expose `open_review`, `get_feedback` and a bounded `wait_for_review` over MCP, writing the same files. Less needed now that Claude Code and Pi deliver rounds automatically; still a way to cover OpenCode and other MCP clients with one implementation. Needs a timeout to respect item 3 and lazy tool loading to respect item 15.
- **Generate the skill from one source** (item 5): the three skill copies are kept identical by hand today.
- **Feed the memory system** (items 1 and 12): decisions answered in a review are good candidates for workstream memory and handoff notes.

### 17. Researcher follow-ups

Follow-ups from the `kosmos-researcher` v1. The design is in `docs/reviews/kosmos-researcher/doc.md`.

**Status: researcher v1 built (uncommitted); follow-ups not started.**

- **Evidence auditor.** A citation pass as a kosmos agent on all three CLIs: `kosmos-evidence-auditor` on Claude Code and OpenCode, `kosmos.evidence-auditor` on Pi. It checks each decision-relevant claim against its source. Deferred in v1, where the researcher verifies its own claims.
- **context7 for the Pi researcher.** Not available yet. It needs a background launch and pi-mcp-adapter.
- **Live checks.** Claude Code passed headless (`claude -p`, 2026-11-20). The write guard blocked traversal, out-of-project, `.claude/`, `CLAUDE.md` and uppercase-slug writes and allowed a valid report. The web hook approved the researcher's fetches, and the answers came from primary sources. The hook stayed scoped to the researcher: the parent's own `WebSearch` was still denied. Still pending:
  - an interactive Claude Code check that the frontmatter hooks fire from the symlinked `~/Dotfiles/claude/agents/` (headless skips the workspace-trust dialog);
  - the OpenCode smoke test;
  - the Pi smoke test, which must confirm that a github.com fetch is refused, that no unguarded pi-web-access loads, and that the disabled built-ins are hidden.

> **Needs more thought:** the evidence auditor's shape is not decided. Options are one pass per report, or one per decision-relevant finding.

Accepted residual risks in v1:

- OpenCode `webfetch` private-range denies are best-effort. Decimal and hex IP forms, DNS names that resolve to private addresses, and redirects get through.
- context7 runs through `npx`, and there is no lockfile for its dependencies.
- A trusted project's `.pi/settings.json` can override the Pi researcher's `extensions:` and drop the guard.
- The OpenCode `edit` map does not deny mixed-case instruction-file names such as `Claude.md`. This matters only on case-insensitive filesystems.
- The Claude researcher's web hook auto-approves WebFetch for any public-looking https hostname. It checks names by shape only and never resolves them, so an internal host on a public-looking domain is fetched without a prompt. Built-in denies cover `ts.net`, the RFC 6761 names and the common private suffixes. List your own internal domains in `~/.config/kosmos/research-deny-suffixes`.

## Considered, not now

- **Prompt regression evals.** The workflow is still being evaluated through daily use. Writing evals now would lock in behaviours that may be removed later.
- **Quota-aware model routing.** Cost efficiency should be designed in from the start, not added as a routing layer on top. Look at other mechanisms instead.
- **Delegation trace.** The current footer cost split is enough.
