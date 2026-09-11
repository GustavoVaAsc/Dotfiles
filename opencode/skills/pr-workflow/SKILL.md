---
name: pr-workflow
description: Guides the user through preparing, committing, describing, and self-reviewing a pull request following widely-used open source conventions — Conventional Commits, focused PRs, structured PR descriptions, self-review checklists, and review etiquette for both authors and reviewers. Use when the user says "open a PR", "submit a PR", "create a PR", "commit this for review", "stage this", "prepare a PR", "review my PR before I open it", "what should my PR description say", or any request to package local changes for review. Use ONLY for PR-level workflow (commits, descriptions, self-review, review etiquette); do NOT use for implementation work (route to kosmos-coder or kosmos-pro-coder), code review of a finished PR by a reviewer (route to kosmos-code-reviewer), or general git operations unrelated to PR preparation.
---

# PR Workflow

A structured protocol for turning local changes into a pull request that reviewers can actually review. Applies the conventions used by major open source projects: Conventional Commits for messages, focused diffs, structured PR descriptions, self-review before requesting review, and clear review etiquette on both sides.

This skill produces a complete PR package: a commit breakdown with messages, a PR description ready to paste into GitHub, and a self-review report. It can create local commits when asked. It does **not** push, open a remote PR, or merge — those stay human decisions.

## When to fire

Trigger on any of:

- "open a PR", "submit a PR", "create a PR", "prepare a PR"
- "commit this", "stage this for review", "package my changes"
- "what should my PR description say", "write the PR description"
- "review my PR before I open it", "self-review my changes"
- Any request to summarize local uncommitted or branch-local changes for review

Do NOT fire when:

- The user wants implementation work — route to kosmos-coder or kosmos-pro-coder.
- The user wants a code review of an already-submitted PR — route to kosmos-code-reviewer.
- The user wants a security audit — route to kosmos-security-auditor.
- The user wants documentation generated — route to kosmos-docs-writer.
- The request is general git usage unrelated to PR preparation (branching, stashing, rebasing without a PR destination).

## Workflow

Run these phases in order. Stop and ask the user if any phase produces a blocker (mixed concerns, broken CI, missing tests) rather than guessing past it.

### Phase 1: Pre-flight

Determine the PR's starting point and scope:

- Run `git status` and `git log --oneline -10` to see branch state and recent commit style.
- Identify the target base branch (typically `main` or `master`) — confirm with the user if ambiguous.
- Run `git diff <base>...HEAD` for branch-local changes; `git diff` for unstaged, `git diff --staged` for staged.
- Run `git diff --stat <base>...HEAD` to see file-level change sizes.
- If the diff is larger than ~400 lines or spans more than ~10 files, flag this to the user and ask whether to split into multiple PRs before proceeding. Big PRs get worse review.

### Phase 2: Commit hygiene

If the changes are uncommitted or in a single squashed commit, break them into logical units.

For each logical change:

1. Group related files (`git diff --name-only` filtered by area).
2. Stage that group (`git add <files>`).
3. Draft a Conventional Commit subject (see Conventions below).
4. Draft a body explaining *why*, not *what* — the diff shows what.
5. Create the commit with `git commit -m "<subject>" -m "<body>"`.

If the user has already committed, audit the existing commits:

- Use `git log <base>...HEAD` to see them.
- If commits are noisy (WIP, fix typos, "address feedback" without context), offer to squash or reword.
- If commits are clean and focused, leave them alone.

### Phase 3: PR description

Generate a description in the template below, filling every section. Pull facts from the diff and the user's stated intent — do not invent.

```markdown
## Summary
<1–3 sentences: what this PR does, in the user's own framing>

## Motivation
<Why this change is needed. Link the issue with "Fixes #N" or "Closes #N" if applicable. State the user-visible problem.>

## What changed
<High-level bullet list of changes. Not a line-by-line recap.>
- <area>: <what changed and why>
- <area>: <what changed and why>

## How it was tested
<What the author ran to verify. Be specific.>
- Unit tests: <which, where>
- Integration tests: <which, where>
- Manual verification: <steps taken, observed result>

## Risk and rollback
<What could go wrong. How to roll back if it does.>
- Risk: <description, likelihood, blast radius>
- Rollback: <revert this PR | disable flag | other>

## Screenshots / recordings
<Required for UI changes. Empty for non-UI.>
```

Output the description as a fenced block the user can paste directly.

### Phase 4: Self-review

Before declaring the PR ready, run a self-review pass. Delegate to specialists:

- Always: invoke `kosmos-code-reviewer` on `git diff <base>...HEAD`. Treat any blocker or critical as a fix-first.
- If the diff touches auth, input handling, secrets, crypto, network, or eval: also invoke `kosmos-security-auditor`.
- If the diff adds a public API, CLI flag, or new export: also flag API design concerns (naming, error shape, backward compat) for the user to consider — there is no dedicated agent for this.

Then run this checklist. Any unchecked item is a finding to surface:

- [ ] Subject lines ≤72 chars, imperative mood, no trailing period.
- [ ] Conventional Commit prefix used where applicable.
- [ ] Commit body explains *why*, not *what*, when non-obvious.
- [ ] One logical change per commit.
- [ ] PR description has every required section filled.
- [ ] Linked issue (if any) referenced with Fixes/Closes.
- [ ] Tests added or updated for changed behavior.
- [ ] CI is green locally before requesting review.
- [ ] Diff size within target (<400 lines, <10 files when possible).
- [ ] No debug code, commented-out code, or stray prints left in.
- [ ] No secrets, credentials, or `.env` content in the diff.
- [ ] Branch name follows `type/short-kebab-description`.

Surface the self-review report in this format:

```markdown
## PR Self-Review: <branch> → <base>

### Status
ready | needs-fix-first | needs-split

### Reviewer findings
<aggregated kosmos-code-reviewer + kosmos-security-auditor output, severity-ordered>

### Checklist
<completed items as checked; remaining items as unchecked with one-line note>

### Recommended next step
<open the PR with the description above | fix N items first | split into M PRs>
```

## Commit conventions

- Format: `<type>(<scope>): <subject>` where type is one of `feat | fix | refactor | perf | test | docs | build | ci | chore | style`.
- Subject: ≤72 chars, imperative mood ("add", not "added" or "adds"), no trailing period, no capitalization of the first word after the type.
- Body: optional. Wrap at 72 columns. Explain *why* the change was needed, what problem it solves, and any non-obvious tradeoffs. Link issues with `Fixes #N` or `Refs #N`.
- Footer: optional. Use `BREAKING CHANGE: <description>` for breaking changes. Co-authored trailers when pair-programming.

Examples:

```text
feat(login): add rate limiting on password attempts

Mitigates brute-force attacks on the login endpoint. After 5 failed
attempts within 15 minutes from the same IP, further attempts return
429 with a Retry-After header.

Fixes #1234
```

```text
fix(api): correct off-by-one in pagination cursor

Previous cursor computation skipped the boundary record when the
limit exactly matched the remaining count. Now uses inclusive
comparison.
```

## PR description template

(See Phase 3 above for the full template.)

## Review etiquette

For authors:

- Approve your own work first. Read the diff cold before requesting review.
- CI green before review request. Do not make reviewers wait for red CI to settle.
- Respond to every comment. Resolve, push back with reasoning, or fix. Do not ignore.
- Force-push only for unfinished work. Once review has started, append fixup commits; do not rewrite history.
- Keep the PR alive. If blocked >2 days, leave a status comment; if blocked >1 week, propose to close or split.

For reviewers:

- Approve = ship-ready. "I would be comfortable if this merged now."
- Request changes = blocker. Be explicit: "must address" vs. "nit, your call".
- Prefix nits with `nit:` so authors can ignore them safely.
- Cite the line. Vague feedback ("this looks wrong") is not actionable; quote the code.
- Distinguish must-fix from should-fix from nice-to-have. The author cannot read your mind.
- Review in time the author can use. A review a week later than the PR is a worse review than no review.

## Merge strategy

Default guidance:

- Squash merge for feature branches that were committed incrementally — keeps `main` history clean.
- Rebase or merge commit for branches where each commit is a meaningful, reviewable unit (rare; requires discipline).
- Delete the source branch on merge unless there's a reason to keep it.
- Require linear history when the project enables it.

This is a recommendation, not a rule. Match the project's existing merge conventions; ask if unclear.

## Operating principles

- Produce the package, don't push. This skill generates commit messages, a PR description, and a self-review report. It creates local commits when asked. It does not push, open a remote PR, or merge. Those are user decisions.
- Surface size concerns early. A 1500-line PR is not a "let me write a better description" problem; it is a "split this" problem. Flag in Phase 1.
- Cite the diff. Every claim about what changed must come from `git diff` output. Do not invent context.
- One logical change per commit. A commit that fixes a typo, refactors a function, and adds a feature is three commits. Help the user split.
- Self-review is not optional. Phase 4 runs every time. Skipping it because the change feels small is how regressions ship.
- Ask before splitting or rewriting history. If the diff is large or commits are messy, surface the issue and ask. Do not silently run `git rebase -i`.
- Match the project's conventions. Some projects use squash merge, some use rebase; some require DCO sign-off, some don't. Detect from existing history and CONTRIBUTING.md when possible, ask when not.
- No emojis, no fluff. PR descriptions read by engineers under time pressure. Plain prose.
