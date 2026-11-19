---
name: the-cock-of-justice
description: Runs a dual-lens revision on a plan or code change — one subagent audits the spec (does it solve the right problem, are requirements complete and testable, are alternatives weighed) and a second subagent audits quality (scalability, bugs, error handling, reliability, maintainability, performance, test gaps) — then returns a single ACCEPTED, WARNING, or FAIL verdict with a summary and concern bullets. Use when the user asks for "the cock of justice", a "verdict", a dual spec-and-quality review, or a blocker / scalability / bug audit on a plan or implementation. Also use when a plan or diff needs a hard go / no-go before further work. Do NOT use for routine single-lens code review — use kosmos-code-reviewer for that.
---

# The Cock of Justice

A two-reviewer judgment on a plan or implementation. One reviewer judges whether the work solves the right problem; the other judges whether the work is well built. The synthesis produces a single go / conditional-go / no-go verdict.

This skill is read-only. It does not edit files, run code, or commit. Its output is a verdict and a list of concerns for the human or a follow-up agent to act on.

## When to fire

Trigger on any of:

- Explicit invocation: "use the cock of justice on this", "judge this plan", "verdict on this diff", "give me the cock of justice".
- A plan or implementation needs a hard go / conditional-go / no-go before further work continues.
- The user asks for blockers, scalability issues, bugs, or other errors to be surfaced in a plan or diff.
- The user wants a spec review (are we solving the right problem?) AND a quality review (is what we built sound?) in a single pass.

Do not fire when:

- A routine single-lens code review is enough — use kosmos-code-reviewer.
- The user only wants security review — use kosmos-security-auditor.
- The user only wants documentation — use kosmos-docs-writer.
- The work is to write code, not to judge it — use kosmos-coder.

## Subagents

Spawn exactly two subagents in parallel via the `task` tool in a single turn. Do not serialize them.

### Preferred: kosmos-security-auditor (×2)

This is the user's stated preference. The security-auditor agent has no write access and the most disciplined report format; reuse it as the chassis even when the review is not security-focused. Override its prompt in each `task` call so it knows which lens it is wearing.

### Fallback: general subagent (×2)

If `kosmos-security-auditor` is not registered in the current environment, fall back to two `general` subagents and apply the same role override.

### Roles

**Spec reviewer** — wears the spec lens. Reads the plan or diff and asks:

- Does this solve the actual problem the user described, or just the surface of it?
- Are the requirements complete, testable, and unambiguous? Anything left implicit that should be explicit?
- Is the scope correct? Too narrow (misses a real edge case), too wide (solves problems nobody asked for), or right?
- Are the assumptions stated and reasonable?
- Were at least two approaches considered? Was the rejected one recorded with a reason?
- Does the plan match the user's stated intent, or has it drifted toward the implementer's preference?
- If this is a code change, does it do what was asked and only what was asked?

**Quality reviewer** — wears the quality lens. Reads the plan or diff and asks:

- Correctness: logic errors, off-by-one, null/undefined handling, contract mismatches.
- Scalability: algorithmic complexity, N+1 queries, unbounded growth, missing pagination.
- Reliability: uncaught exceptions, swallowed errors, missing timeouts, retry storms, partial-failure cleanup, idempotency, transaction boundaries.
- Performance: blocking I/O on async paths, hot-path allocations, missing indexes, deep call chains.
- Concurrency: shared mutable state, lock ordering, TOCTOU, race conditions.
- Resource management: leaks (file, socket, timer, connection), missing pagination, unbounded caches.
- API and contract design: breaking changes, status codes, error shape, undocumented side effects.
- Observability: structured logs at the right severity, correlation IDs, missing metrics for failure modes.
- Test coverage: gaps in unit or integration coverage for the changed behavior, untested error paths.
- Maintainability: dead code, duplicated logic, magic numbers, complexity hotspots, comment accuracy.
- Security where it intersects quality: input validation, secret handling, dependency hygiene — but only at the level that affects shipping, not a full security audit.

The quality reviewer is NOT doing a full security audit. If the user wants that, run kosmos-security-auditor separately after this skill returns.

## Spawning the subagents

Both `task` calls must be issued in the same assistant turn. Each brief must be self-contained:

- The change or plan being reviewed.
- The files in scope (paths).
- The role (spec or quality) the subagent is wearing.
- The severity scheme: `blocker | critical | major | minor | nit`.
- The instruction to use the output format below.

**Lens mode.** Tell each subagent that the report shape below overrides its own agent's: number findings P1, P2, ... (spec lens) or Q1, Q2, ... (quality lens), not S; write no `Threat model:` line and no `## Prior findings` section; and use the spec or quality categories listed above, not the agent's own layers. The inner `Verdict:` line is informational only: the rubric below decides the verdict, not the subagents. The lenses do not run scanners or fetch the web, even though the chassis agent can: they work from the brief and the diff.

Do not give either subagent context that depends on the other — they cannot share state.

### Subagent output format

Each subagent must return a report in exactly this shape (the kosmos-* report shape, so synthesis is mechanical). Tell the spec reviewer to number its findings P1, P2, ... and the quality reviewer to number its findings Q1, Q2, ..., so a merged finding reads `P1+Q2`:

```
# <Spec | Quality> review: <scope>
Verdict: ship | fix-first | block (<counts by severity, e.g. 1 major, 2 minor>)

## Summary
<1-2 sentences: what was reviewed and the overall assessment>

## Findings
- **P1 [major] file_path:line — title** (<which of the spec / quality sub-categories above>)
  What: <the defect in one sentence>
  Why: <concrete user or system impact>
  Fix: <specific change, not a vague hint>
- P2 [minor] file_path:line — <defect and impact in one line>. Fix: <specific change>

## Not covered
<what the reviewer did not examine, and why; `none` if everything was covered>

## Open questions
- [decision] | [approval] | [unverified] <entry, or `none`>
```

Severity: blocker | critical | major | minor | nit. Blocker, critical and major get the full block, with severity and category on the title line; minor and nit get one line each.

If a category has no findings, omit it. Do not pad the report.

## Synthesis

After both subagents return:

1. **Collect findings.** Keep the original ID, severity, category, and citation from each subagent.
2. **Deduplicate.** If both subagents flagged the same issue from different angles, merge into one finding, join the IDs (`P1+Q2`) and cite both lenses.
3. **Apply the verdict rubric** below. This is the only place severity drives a verdict.
4. **Write the output** in the exact format at the bottom of this skill.

Do not paper over conflicts. If spec and quality disagree on whether an issue is shippable, surface the disagreement and pick the stricter reading.

## Verdict rubric

Pick exactly one:

- **ACCEPTED** — zero blockers, zero criticals, zero majors in either review. The plan or change is sound and ready to proceed.
- **WARNING** — zero blockers, but at least one critical, or at least one major that the user has not acknowledged. Proceed with documented awareness of the issues, or address them in a follow-up before merging.
- **FAIL** — at least one blocker in either review, OR so many criticals or majors that the plan or change cannot be shipped without rework.

When in doubt, pick the stricter verdict. A WARNING that the user can downgrade is a fine outcome; a FAIL that gets waved through is not.

## Output format

Produce exactly this structure:

```
# The Cock of Justice: <change scope>
Verdict: ACCEPTED | WARNING | FAIL — <the headline reason in one sentence>

## Summary
<1-2 sentences: what was reviewed and the two lenses.>

## Concerns
For each finding, ordered by severity (blocker first), then by file:
- **P1+Q2 [major] file_path:line — title** (source: spec, quality; <sub-category>)
  What / Why / Fix: <one sentence each>
- Q3 [minor] file_path:line — <one line>

## Not covered
- <what either reviewer did not examine, and why, or none>

## Open questions
- [decision] | [approval] | [unverified] <things the reviewers could not determine from the artifact alone, or none>
```

Severity: blocker | critical | major | minor | nit. Blocker, critical and major get the full block; minor and nit get one line each. Findings keep the IDs the reviewers gave them (P for the spec lens, Q for the quality lens).

Do not include a "ship verdict" or "fix-first / block" line — the verdict already encodes that. Do not add an emoji. Plain prose.

## Operating principles

- **Two reviewers, in parallel, in one turn.** Serialization wastes time and tempts the second reviewer to anchor on the first.
- **Self-contained briefs.** Each subagent gets the full picture. Do not forward-reference "see the spec review" or "see the other report".
- **Strict verdict rubric.** Do not soften a FAIL to a WARNING because the change is small. Do not promote a WARNING to ACCEPTED because the user is in a hurry. The rubric is the rubric.
- **Cite, do not paraphrase.** Every finding references `file_path:line`. Findings without a citation get sharpened or dropped during synthesis.
- **Read-only.** This skill does not edit files, run tests, or commit. The verdict is the deliverable. If the user asks for revision, route to kosmos-coder after the verdict is delivered.
- **No emojis, no fluff.** The output is read by an engineer under time pressure. Plain prose.
- **Surface disagreement.** If the two reviewers disagree on severity or shippability, surface that explicitly in the summary. Do not pick a number silently.
- **Stay quiet on adjacent topics.** This skill does not write docs, run security audits, or implement code. If a reviewer drifts into another role's territory, keep the relevant findings and discard the rest.
