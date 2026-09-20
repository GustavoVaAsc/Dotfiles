---
name: test-driven-dev
description: Adds explicit Red-Green-Refactor phase discipline to test additions — every test goes through RED (failing meaningfully) → GREEN (minimal change to pass) → REFACTOR (cleanup without changing behavior), with phase markers required in the report. Use when the change adds new test coverage or test-first behavior, especially when the test could pass vacuously. Invoked by the orchestrator when the change adds tests, or by the coder when test-first work is needed.
---

# Test-Driven Development

A workflow protocol for test additions that enforces the Red-Green-Refactor cycle explicitly, with phase markers required in the report so transitions are auditable. The skill is invoked by the orchestrator (or by the coder if the brief signals it) when adding new test coverage.

## When to fire

Trigger on any of:

- The change adds a new test (unit, integration, e2e).
- The change modifies existing test behavior (renaming a test, changing assertions, adding cases).
- The coder is fixing a bug and wants to write a regression test first.
- The user explicitly asks for TDD.

Do NOT fire when:

- The change does not touch tests.
- The change is purely cosmetic (rename, formatting, comment-only).
- The change adds test infrastructure but not tests themselves (CI config, test runner setup).

## Workflow

Run these phases in order for EACH new test or test-first behavior. Do not skip phases.

### Phase RED: Write the failing test

Write the test that asserts the new behavior. Then run it against the unchanged code:

1. **Run the test against the unchanged code.**
2. **Verify it fails meaningfully** — not a typo, not a missing fixture, not an import error. The failure should be the assertion that the new behavior does not exist yet.
3. **If it fails meaningfully:** record the failure in the report (`RED observed: <assertion failure message>`).
4. **If it passes or fails trivially (typo, missing fixture):** STOP. The test is wrong. Fix the test, then re-run. Do not proceed to GREEN until you have a meaningful failure.

This is the "test the test" check (the C2 baseline rule, made explicit and reportable here). It catches tests that always pass vacuously — assertions that do not actually exercise the behavior they claim to assert.

### Phase GREEN: Make it pass with the minimal change

Make the smallest change to the code that makes the test pass. Resist scope creep:

1. **Change only what is needed** for the test to pass.
2. **Do not refactor adjacent code** — that is REFACTOR's job, not GREEN's.
3. **Do not add tests for behavior the change does not introduce.**
4. **Run the test, verify it passes.**
5. **Run the existing test suite, verify no regressions.**

### Phase REFACTOR: Clean up without changing behavior

With the test passing, clean up:

1. **Remove duplication** introduced by the new code (extract helpers, rename for clarity).
2. **Improve naming** if the test or new code is unclear.
3. **Re-run the test suite after each refactor step.**
4. **Do not change behavior** — if a refactor changes behavior, the test must catch it (it should). If the test does not catch a behavior change, the test is too weak; strengthen it.

If there is nothing to refactor, write `REFACTOR: none` in the report.

## Output format

For each new test, emit phase markers in the report's Verification section:

```markdown
### TDD phases

**Test: <test name or path>**
- RED observed: <assertion failure message from running test against unchanged code>
- GREEN change: <what code change made it pass>
- REFACTOR: <what cleanup was done, or "none">
```

If multiple tests, repeat the block for each.

## Operating principles

- **Never skip RED.** A test you wrote and never observed failing is a test you do not trust. Run it against unchanged code and verify the failure.
- **RED failure must be meaningful.** A typo or import error is not a meaningful failure. The failure should be the assertion that the new behavior does not exist yet.
- **GREEN is minimal, not comprehensive.** Resist the urge to also fix the adjacent code. That is REFACTOR's job.
- **REFACTOR preserves behavior.** If a refactor changes behavior, it is not a refactor — it is a scope expansion. Write a test for the new behavior first.
- **Phase markers in the report are not optional.** They make transitions auditable when a test later fails mysteriously.
- **Match the project's test style.** Same test framework, same assertion style, same fixture conventions as the surrounding code.
- **No emojis, no fluff.** Phase markers are read by an engineer under time pressure. Plain prose.
