---
name: spec-driven-dev
description: Adds a structured spec-first workflow before code is written — restate the problem, define acceptance criteria, mark out-of-scope, plan tests. Use for non-trivial changes where the gap between intent and implementation is large enough that a written spec prevents wasted work. Invoked by the orchestrator in the brief for new modules, breaking changes, multi-file refactors, and new public APIs.
---

# Spec-Driven Development

A workflow protocol for code changes where the gap between intent and implementation is large enough that a written spec is cheaper than a wrong implementation. The skill is invoked by the orchestrator (or by the coder if the brief signals it) before any code is written.

## When to fire

Trigger on any of:

- Brief signals a non-trivial change: new module, breaking API change, multi-file refactor, new public API.
- The orchestrator's complexity assessment puts the change above "routine" but below "needs architecture checkpoint".
- The change touches auth, persistence, security, or performance (high cost of being wrong).
- The user explicitly asks for spec-first work.

Do NOT fire when:

- The change is a small fix (1-2 files, well-understood pattern).
- The change is purely cosmetic (rename, formatting, comment-only).
- The user explicitly opts out ("just do it", "skip the spec").

## Workflow

Run these phases in order. Do not write code until Phases 1-4 are committed to the report.

### Phase 1: Restate the problem

In your own words (not the user's framing): what is the actual user-visible or system-visible change? What does success look like, and how would a reviewer verify it? If you cannot state success concretely, ask the user before proceeding.

### Phase 2: Define acceptance criteria

Concrete, testable conditions for "done." Each criterion should be:

- **Observable** — has a measurable effect (output, behavior, log line, metric, status code).
- **Specific** — names the exact behavior, not a category ("login succeeds with valid credentials" beats "login works").
- **Independent** — does not require other criteria to be implemented to verify.

Format each criterion as: `<observable outcome> when <condition>`.

### Phase 3: Mark out-of-scope

Explicit non-goals for this change. State what this change does NOT do, even if a reader might assume it does. This prevents scope creep and lets the reviewer evaluate focus.

Format: `<non-goal> — <why it's not in this change>`.

### Phase 4: Plan tests

For each acceptance criterion, identify the test that proves it. Tests may be:

- New unit / integration / e2e tests you will write
- Existing tests that already cover the criterion
- Manual verification steps (if no automation exists)

Format each row: `<criterion reference> → <test name or path, or "manual: <step>">`.

### Phase 5: Implement

Write code against the spec from Phases 1-4. The spec is the source of truth — if implementation reveals the spec is wrong, update the spec first, then update the code. Do not silently diverge.

## Output format

Emit the spec in the report's Design notes section before writing code:

```markdown
## Spec (from spec-driven-dev skill)

### Problem restated
<in your own words>

### Acceptance criteria
- AC1: <observable outcome> when <condition>
- AC2: <observable outcome> when <condition>
- ...

### Out of scope
- <non-goal 1> — <why>
- <non-goal 2> — <why>

### Test plan
- AC1 → <test name/path or manual step>
- AC2 → <test name/path or manual step>
- ...
```

After implementation, append:

```markdown
### Spec compliance
- AC1: <met | unmet | partially — explain>
- AC2: ...
- Out-of-scope items: <all respected | one violated — explain>
```

## Operating principles

- **Spec first, code second.** Do not write code until Phases 1-4 are committed to the report. If you cannot fill any field, ask the user.
- **Spec is a living document.** If implementation reveals the spec is wrong, update the spec before updating the code. Reviewers should be able to read the spec and understand what was intended without reading the diff.
- **Concrete over abstract.** Vague criteria produce vague tests. If a criterion cannot be observed, it is not a criterion — it is a wish.
- **Out-of-scope is not optional.** It is the most-neglected part of a spec and the most important for reviewer focus. If you cannot name anything out of scope, the change is probably under-specified.
- **Match the spec, not your preference.** If the spec says one thing and your judgment says another, surface the disagreement in the report. The user resolves; you do not.
- **No emojis, no fluff.** The spec is read by an engineer under time pressure. Plain prose.
