---
name: thermo
description: |
  Run an extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth, pushing for "code judo" restructurings that delete complexity rather than move it. Reports as prose by default, or as structured JSON findings (file, line, severity, category, claim, evidence, suggestion, confidence) for the `review` skill and the `reviewer` agent.

  Use when: asked for a thermonuclear or thermo review, a deep code quality audit, an especially harsh maintainability review, or `/thermo [range|PR] [--json]`; or when another skill needs the maintainability rubric applied to a diff.
user-invocable: true
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

The full rubric is in `references/rubric.md`: the eight non-negotiable standards, the review questions, what to flag aggressively, the preferred remedies, the tone and its sample phrases, the output priorities, and the approval bar. Read it before every review; the summary below is a reminder, not a substitute.

0. Be ambitious about structural simplification; push for the path that deletes complexity.
1. Do not let a change push a file from under 1000 lines to over 1000 lines without a very strong reason.
2. Do not allow random spaghetti growth: ad-hoc conditionals and one-off branches in unrelated flows are design problems.
3. Bias toward cleaning the design, not accepting working code.
4. Prefer direct, boring code over hacky or magical code; flag thin wrappers and identity abstractions.
5. Push on type and boundary cleanliness: needless optionality, `unknown`, `any`, casts, silent fallbacks.
6. Keep logic in the canonical layer and reuse existing helpers.
7. Treat needless sequential orchestration and non-atomic updates as design smells.

## Inputs

| Input | Meaning |
|---|---|
| nothing | the current branch against its base |
| a range, e.g. `origin/staging...HEAD` | exactly that range |
| a PR number or URL | that PR's head against its base |
| `--json` | structured output only (see Output) |
| a conventions file path | the repo's conventions bundle, from `gather-context` conventions mode |

## Flow

1. **Resolve the range.** For a PR, run `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json` and use `base...headSha` (fetch both refs first). For the current branch, run `bun $CLAUDE_CONFIG_DIR/skills/branch/scripts/br.ts where --json`: the base is the open PR's base, else the gh stack parent, else `target.branch`. Always use the three-dot range so base commits are excluded.
2. **Read the diff.** `git diff --stat` first, then the source files, highest signal first; generated files and lockfiles are counted, not reviewed. Never claim to have read what you skimmed. For every file the diff grows, record its line count before and after (`git show <base>:<path> | wc -l` against `wc -l <path>`).
3. **Read the conventions.** When a conventions bundle is given, read it. Otherwise, for every mechanism the diff adds or changes (auth checks, error handling, data access, a named helper), grep the repo for the existing pattern and count call sites. A helper with many call sites is a decision; following it is not a finding, and hand-rolling around it is.
4. **Review against the rubric.** Ask the primary review questions of every meaningful change. Look for the code-judo move first, then the presumptive blockers, then the rest, in the rubric's output priority order.
5. **Self-check each finding.** Is it provable from the cited lines, or only taste? Does the surrounding code already do the same or less (then it is not this change's problem)? Would the suggested remedy actually delete complexity, or only move it? Cut what fails.
6. **Report** in the requested form.

## Output

**Default (prose).** Findings in the rubric's priority order, each with its `path:line`, the problem stated directly in the rubric's tone, and the remedy. Prefer a few high-conviction findings over a long list of nits. End with the approval-bar verdict: which presumptive blockers apply, or "meets the bar". Then offer the structured form.

**Structured (`--json`, or when a skill or agent asks).** One JSON object in the schema in `references/findings.md`: `range`, a summary of at most 100 words, and `findings` with `file`, `line`, `severity` (`blocker`, `major`, `minor`, `nit`), `category`, `claim`, `evidence`, `suggestion`, and `confidence`. Apply that file's filters before returning. Any thermo presumptive blocker is severity `blocker`.

## Rules

- Every finding cites `path:line`. No citation, no finding.
- Do not soften a structural problem into a mild suggestion, and do not invent one to look thorough. "Meets the bar" is a valid outcome.
- Never edit, commit, push, or post. Fixes are proposed; the caller decides.
- Uncertain about a hunk: say so, and mark the finding's confidence accordingly.
