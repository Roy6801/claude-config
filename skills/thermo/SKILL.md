---
name: thermo
description: "Strict maintainability review of a diff (thermo): abstraction quality, files growing past 1000 lines, spaghetti branching, code-judo simplifications. Use when asked for a thermo or harsh code-quality review, or when another skill needs the maintainability rubric applied to a diff."
metadata:
  origin: local
---

# Thermo

An unusually strict review of implementation quality, maintainability, abstraction quality, and codebase health. Above all, be **ambitious** about code structure: do not stop at local cleanups; actively search for "code judo" moves, restructurings that preserve behaviour while making the implementation dramatically simpler, smaller, more direct, and more elegant.

This skill reviews; it never edits code, commits, or posts anything.

## Core prompt

> Perform a deep code quality audit of the current branch's changes.
> Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

The full rubric is in `references/rubric.md`: the eight standards with their review questions and remedies, the tone, the output priorities, and the approval bar. Read it before every review.

## Inputs

| Input | Meaning |
|---|---|
| nothing | the current branch against its base |
| a range, e.g. `origin/staging...HEAD` | exactly that range |
| a PR number or URL | that PR's head against its base |
| `--json` | structured output only (see Output) |
| a conventions file path | the repo's conventions bundle, from `gather-context` conventions mode |

## Flow

1. **Resolve the range.** For a PR, run `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json` and use `base...headSha` (fetch both refs first). For the current branch, run `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts target`: that is the base. Always use the three-dot range so base commits are excluded.
2. **Read the diff.** `git diff --stat` first, then the source files, highest signal first. Read every changed source file in full; count generated files and lockfiles only. For every file the diff grows, record its line count before and after (`git show <base>:<path> | wc -l` against `wc -l <path>`).
3. **Read the conventions.** When a conventions bundle is given, read it. Otherwise, for every mechanism the diff adds or changes (auth checks, error handling, data access, a named helper), grep the repo for the existing pattern and count call sites. A helper with many call sites is a decision; following it is not a finding, and hand-rolling around it is.
4. **Review against the rubric.** Ask the primary review questions of every meaningful change. Look for the code-judo move first, then the presumptive blockers, then the rest, in the rubric's output priority order.
5. **Self-check each finding.** Is it provable from the cited lines, or only taste? Does the surrounding code already do the same or less (then it is not this change's problem)? Would the suggested remedy actually delete complexity, or only move it? Cut what fails.
6. **Report** in the requested form.

## Output

**Default (prose).** Findings in the rubric's priority order, each with its `path:line`, the problem stated directly in the rubric's tone, and the remedy. Prefer a few high-conviction findings over a long list of nits. End with the approval-bar verdict: which presumptive blockers apply, or "meets the bar". Then offer the structured form.

**Structured (`--json`, or when a skill or agent asks).** One JSON object in the schema in `references/findings.md`: `range`, a summary of at most 100 words, and `findings` with `file`, `line`, `severity` (`blocker`, `major`, `minor`, `nit`), `category`, `claim`, `evidence`, `suggestion`, and `confidence`. Apply that file's filters before returning. Any thermo presumptive blocker is severity `blocker`.

## Rules

- Every finding cites `path:line`. No citation, no finding.
- State a structural problem as one, and report only real ones. "Meets the bar" is a valid outcome.
- Never edit, commit, push, or post. Fixes are proposed; the caller decides.
- Uncertain about a hunk: say so, and mark the finding's confidence accordingly.
