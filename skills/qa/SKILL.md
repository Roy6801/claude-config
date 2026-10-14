---
name: qa
description: |
  Code-derived QA against the acceptance criteria. Loads the ACs first (`spec.ts acs`), then has the `tester` agent derive cases from the code paths (happy, error, edge, loading, empty, auth), get them approved, and drive the browser through them. A failure counts only when it reproduces at least twice; anything else is reported honestly as uncertain. Turns the user's manual test steps into lasting automated tests in the repo's own framework (offered, never forced), drafts a bug per failure (a Linear ticket through `ticket` when Linear is connected, else a GitHub issue; created only after approval) and hands it to `debug`, and reports a verdict per AC with GIFs for UI.

  Use when: a `pair` checkpoint reaches its QA step, validating a feature before merge, a post-refactor parity check, a regression sweep on a flow, or asked to "QA this", "test in browser", "build test cases for X", or "turn my test steps into tests".
user-invocable: true
metadata:
  origin: local
---

# QA

The case list comes from the acceptance criteria and the code, never from product copy or guesses. Every failure is either reproduced on demand (at least twice) or reported as uncertain with what was tried. The `tester` agent (`$CLAUDE_CONFIG_DIR/agents/tester.md`) does the reading and the browser work; the main thread scopes, gets approvals, drafts bug issues, and hands bugs to `debug`.

## Requires

- A browser tool chosen per CLAUDE.md "Browser Automation": `claude-in-chrome` by default, `agent-browser` only in the cases CLAUDE.md allows. If the chosen tool is unavailable, stop and ask the user before any code-only run.
- A running app URL. If none is running, ask the user how to start it (or use the `run` skill), never guess a port.

## Modes

- `/qa [slice|issue|"flow"]`: full QA run (sections 1 to 6).
- `/qa tests`: only section 5, turning manual steps into automated tests.

## 1. Scope

1. Run `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json`. When an initiative is active, load its ACs with `bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json` (skip superseded ones). Inside a `pair` checkpoint, keep only the slice's ACs and take its `test_script` from `pair plan show`.
2. With no spec, take the ACs from the Linear ticket (`ticket` read mode) or the GitHub issue (`gh issue view`), or ask the user for them. Never invent ACs; with none at all, say so and run code paths only, marked "no AC".
3. Name the target files or flows, the URL, the auth state and fixtures needed, and what is out of scope. Fixture data comes from the UI or the user, never from a database; when a case needs a data state you cannot create, write a data request for the user.

## 2. Case matrix (tester phase 1)

Dispatch `tester` for phase 1 only with the ACs (id, Given/When/Then, Verify), the target, the URL and the constraints. It returns a matrix where AC cases come first (at least one case per AC, carrying the AC id), followed by code-path cases: happy, error, edge, loading, empty, and auth or permission boundaries. Cases the code cannot decide are marked spec ambiguity.

Show the matrix to the user with the ambiguities as questions. Wait for approval or edits before any browser action.

## 3. Execute (tester phase 2)

Dispatch `tester` for phase 2 with the approved matrix. Results per case are `pass`, `fail` (reproduced N/N, N ≥ 2), `uncertain`, `spec-ambiguity` or `out-of-scope`. Never ask the tester to retry a flake into a pass or to firm up an uncertain finding; flake is a finding.

Evidence: a GIF for every UI case that fails or is uncertain, and one GIF of the passing main flow for each AC that has UI. Console and network excerpts go with every failure.

## 4. Bugs

For each `fail` and each `uncertain` finding:

1. Draft a bug (in the `ticket` skill's format when Linear is connected, else a GitHub issue): a title naming the broken behaviour, the AC id, the exact reproduction (precondition, steps, expected vs actual with `file:line`, evidence links, "reproduced N/N"), or for uncertain findings the symptom, the attempts and why each failed to pin it down. Link it to the initiative's ticket or issue. Show the exact text and create it (through `ticket`, or `gh issue create`) only after the user approves.
2. Hand the bug to the `debug` skill with the tester's report as its starting evidence; the reproduction is the first candidate for its feedback loop. The fix lands through `pair`.
3. After the fix lands, re-dispatch `tester` for phase 5 (re-verify the failing cases and their neighbours). Loop until the matrix is green or the user explicitly parks the rest.

## 5. Lasting tests (offer, never force)

Manual steps decay; tests stay. Collect the user's manual test steps (the slice's `test_script`, steps in the issue, or steps the user ran) and the passing AC cases. Then:

1. Discover how the repo tests with the `gather-context` skill in `conventions` mode: framework, file locations and naming, helpers and fixtures, the test command. Never introduce a new framework; if the repo has none for this layer, say so and stop.
2. Propose a short table: manual step or case → test file → test name → AC id → layer (unit, integration, e2e). Prefer the lowest layer that still exercises the behaviour.
3. On the user's yes, the tests land as a planned commit through `pair` (or one commit the user approves when `pair` is off), written by the `builder` agent to match the repo's patterns, and run red-then-green where they cover a fixed bug.

## 6. Report

Write the report from `references/report.md` to `<initiative dir>/qa-<YYYY-MM-DD>.md` (no initiative: `$CLAUDE_CONFIG_DIR/state/qa/<YYYY-MM-DD>-<focus>.md`). Tell the user: the verdict per AC first (pass, fail with issue, uncertain, not covered), then counts, then the code gaps the tester surfaced, then the path. Offer a private artifact page of the report with its GIFs; publish only on a yes.

## Rules

- ACs first, then code paths. Cases come from code and ACs, never assumptions.
- Phase 1 before phase 2, and the user's approval of the matrix gates phase 2.
- Exact reproduction (at least 2 of 2) or honest uncertainty; never a hallucinated reproduction.
- QA never fixes. Fixes go through `debug` and `pair`.
- Never touch a database; data needs become a data request for the user.
- Tickets, issues and artifacts are created only after the user approves the exact content.
- Package commands use `ni`, `nr` or `nlx`, never `npm` or `npx`.
