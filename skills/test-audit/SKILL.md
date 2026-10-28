---
name: test-audit
description: Use for a test audit of a PR, for redundant or AI-written tests in a PR, or as the test step of ship-pr. Cuts the PR's tests to the ones that guard the behavior it adds or changes, and proves each kept test can fail.
---

# Test audit

Goal: the PR keeps only tests that protect the behavior it introduces or changes, and each kept test goes red when that behavior breaks. AI-written PRs usually carry far more tests than they need, so be ruthless.

**Scope**: the tests added or modified in this PR, from `git diff --name-only origin/<base>...HEAD`. `<base>` is the branch the PR merges into (its `baseRefName`, or the repo's AGENTS.md); in a stack, it is the PR below. Tests outside the diff stay as they are.

1. **Baseline.** Run the tests this PR touches and record the count. Where the repo has a coverage command, also record coverage on the files the PR changes; where it has none, skip coverage and say so in the report.
2. **Classify** every test in scope. Delete it when it is:
   - Tautological: its expected value comes from the implementation, not a requirement (it re-computes the same logic, or snapshots whatever the code returns now).
   - Redundant: it covers the same behavior and branch as another test, in this PR or already in the suite, with no new edge case.
   - Trivial: it tests getters, setters, constants, types, framework or library behavior, or that a mock returns what it was told to.
   - Over-mocked: it checks call wiring, not behavior.
   - Brittle: it asserts on implementation details that a safe refactor would break.

   Done when every test in scope is marked keep or delete.
3. **Keep or strengthen** tests of the PR's real requirement, its public contract, edge cases and boundaries, error handling, and integration between real units. Prefer larger units, and mock only at true boundaries (network, time, filesystem, third-party APIs). Merge near-duplicates into one parameterized test.
4. **Prove each kept test can fail.** Confirm `git diff --quiet -- <file>` passes for the source file the test guards; when it fails, the file holds uncommitted work, so skip this proof for it and note that in the report. Break the guarded code with one Edit (return a wrong value, drop a branch), see the test go red, then reverse that exact Edit and confirm `git diff --quiet -- <file>` passes again. A test that stays green gets fixed or deleted.
5. **Fill real gaps.** For an important behavior in this PR with no test, add a small requirement-based one. Its expected values come from the intended behavior.
6. **Verify.** All tests pass, and coverage (when measured) stays within 2 points of the baseline.
7. **Commit** only the test files, staged by path, on the PR branch. Push only when the caller says so.
8. **Report**: tests before and after, coverage before and after (or "not measured"), each deleted test with a one-line reason, each added or strengthened test with the requirement it covers, any test whose failure proof was skipped, and any test that was hiding a real bug.

Delete without a preview. Show the step-2 list first only when the owner asks for it.
