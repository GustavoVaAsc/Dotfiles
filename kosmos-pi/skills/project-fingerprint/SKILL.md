---
name: project-fingerprint
description: Quickly captures a project's tooling conventions — framework, test/lint/typecheck commands, pre-commit hooks, commit style, branch naming, PR template — and returns a structured fingerprint the orchestrator can pass in the brief so coders don't re-discover them. Use before dispatching to kosmos.coder or kosmos.pro-coder when the orchestrator doesn't already have this context, or when the brief's tooling assumptions need verification.
---

# Project Fingerprint

A 30-second structured scan of a project's tooling conventions. The output is a one-line summary plus a short structured block. Downstream agents read the fingerprint rather than re-discovering.

## When to fire

- Before dispatching to `kosmos.coder` or `kosmos.pro-coder`, when the brief doesn't already include tooling context.
- When the brief's tooling assumptions need verification (e.g., brief says "run npm test" but the project uses pnpm).
- When resuming work on a project after a long pause and conventions might have drifted.

Do NOT fire when:
- The orchestrator already has the fingerprint from a prior dispatch in this session.
- The project is a fresh bootstrap (nothing to fingerprint yet).
- The user explicitly waived fingerprinting for a quick prototype.

## What to capture

Run these in parallel where possible. Default to read-only commands (`cat`, `ls`, `grep`, `git log`, `git branch`).

1. **Framework.** Read `package.json` (Node), `pyproject.toml` / `requirements.txt` / `setup.py` (Python), `Cargo.toml` (Rust), `go.mod` (Go), `Gemfile` (Ruby), or equivalent. Identify framework if obvious (Next.js, Django, Rails, etc.).
2. **Test command.** Read `package.json` `scripts.test`, `pyproject.toml` `[tool.pytest]`, `Makefile`, etc.
3. **Lint command.** Read `package.json` `scripts.lint`, `ruff.toml`, `.eslintrc`, etc.
4. **Typecheck command.** Read `package.json` `scripts.typecheck`, `tsconfig.json`, `mypy.ini`, etc.
5. **Pre-commit hooks.** Check for `.husky/`, `.pre-commit-config.yaml`, `lefthook.yml`, `.git/hooks/pre-commit`. List which tool and which hooks fire.
6. **Commit style.** `git log --oneline -20` to detect conventional commits (`feat:`, `fix:`, etc.) vs plain. Read `CONTRIBUTING.md` if present for stated style.
7. **Branch naming.** `git branch -a | head -20` to detect conventions (`feature/`, `fix/`, `type/short-desc`, etc.).
8. **PR template.** Look for `.github/PULL_REQUEST_TEMPLATE.md`, `.gitlab/merge_request_templates/`, `docs/pull_request_template.md`.

## Output format

```markdown
# Project fingerprint: <project root>

## Summary
framework=<name>, test=<cmd>, lint=<cmd>, typecheck=<cmd|none>, hooks=<tool|none>, commit-style=<conventional|plain|gitmoji|other>, branch-style=<pattern|none>, pr-template=<path|none>

## Detail
- Framework: <name + version>
- Test: <command>
- Lint: <command>
- Typecheck: <command or "none">
- Pre-commit hooks: <tool> — <list of hooks, or "none">
- Commit style: <detected pattern with example>
- Branch style: <detected pattern with example>
- PR template: <path or "none">

## Gotchas
<anything unusual — monorepo with multiple test commands, custom scripts, non-standard layouts, missing linter, etc.>
```

## Operating principles

- **Parallelize the discovery.** Use `git log`, `ls`, `cat`, `grep` in parallel where independent.
- **Read-only.** This skill does not edit files, run tests, or commit. If the project is missing a linter or has a broken pre-commit hook, surface that as a finding in the calling agent's report — do not fix it here.
- **Don't invent conventions.** If a convention isn't obvious from the project, say "none detected" rather than guessing.
- **Cite paths.** Every output line references the file it came from (`file_path:line` or `file_path` for whole-file reads).
- **Fast.** Target under 30 seconds of bash. If a check is slow (e.g., listing all `node_modules`), skip it.
- **No emojis, no fluff.** The output is consumed by an engineer or another agent, not a human reader.
