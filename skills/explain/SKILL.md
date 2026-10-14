---
name: explain
description: |
  Explain what a branch or PR actually does, in plain language, backed by the diff. Resolves the comparison base, recovers the before-state from the code and from the ticket, threads and docs behind it (through `gather-context`), compares the change with the spec's or ticket's acceptance criteria and with the PR's stated intent, classifies PR review threads by resolution status, and flags drift from the repo's conventions. Read-only. For review findings, use `review others`.

  Use when: reviewing someone's PR, picking up a branch you did not write, asked to "explain this PR", "what does this branch do", "walk me through these changes", "does this PR do what the ticket asks", or before writing a review.
user-invocable: true
metadata:
  origin: local
---

# Explain

Read a branch or PR and explain it to a human. Evidence from git and the tools, never guesses.

This skill is **read-only everywhere**: no GitHub comments, reviews, thread resolving, pushes, or edits to issues, Slack or any other connected source, and never a database query. Anything it calls inherits that.

## Input

| Input | Example |
|---|---|
| nothing | the current branch |
| branch name | `feature/ai-615-citation-regeneration` |
| PR URL or number | `https://github.com/org/repo/pull/4041`, `#4041` |

## 1. Resolve target and base

- **PR given:** `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json`. Base is `base`, head is `headSha`. Do not ask.
- **Branch given, or the current branch:** `bun $CLAUDE_CONFIG_DIR/skills/branch/scripts/br.ts where --json` (run inside the branch's checkout, or `gh pr list --head <branch> --state all` when it is not checked out). An open PR's base wins, then the gh stack parent, then `target.branch`. Say which source decided the base and its evidence, and let the user override.

Fetch the base and head (`git fetch origin <base> <branch>`, or `pull/<n>/head` for a fork). Never check out the branch in the user's working tree.

## 2. Gather code evidence

Three-dot range, so base commits are excluded:

```bash
git log origin/<base>...<head> --format='%h %an %ad %s' --date=short --no-merges
git diff origin/<base>...<head> --stat
git diff origin/<base>...<head> --name-status
git diff origin/<base>...<head>
```

- Diff over about 2000 lines: read `--stat` first, then per file group, highest signal first (source before generated; lockfiles and snapshots last). Never claim to have read what you skimmed.
- Generated files: count them, do not narrate them.
- Branch behind its base (`git rev-list --count <head>..origin/<base>`): say so. A stale branch changes the risk picture.

## 3. Background (the before-state)

Run these in parallel. A trivial diff (typo, lockfile bump, formatting, generated files only) gets 3a only; say "trivial change, no background lookup".

**3a. From the code (always).** The authoritative before-state. For the main files the diff rewrites or deletes: `git log -L <start>,<end>:<path> origin/<base>` (history of the exact lines replaced), `git log -5 --format='%h %an %ad %s' --date=short -- <path>`, and `git show origin/<base>:<path>` when the diff is a rewrite. Read the removed side as its own artifact: what pattern was in place, what it handled, what it missed.

**3b. From people and documents.** Run the `gather-context` skill in `pr` mode (or `ticket` mode with the key in the branch name when there is no PR). It gathers the issue and whichever other sources are connected, with their gates and caps, and writes a cited bundle. Read the bundle's Summary, Decisions, Open questions and Timeline, not the raw source files. Reuse a bundle produced for this PR earlier in the session.

**3c. From the repo's conventions** (when the diff adds or changes a mechanism that exists elsewhere: auth checks, procedures, error handling, retries, write paths, caching, any named abstraction). Reuse a conventions bundle for this repo if one exists; otherwise run `gather-context` in `conventions` mode with the areas from the diff's paths. For each mechanism the diff touches, answer: is there already a named abstraction for this (and does the PR use it or hand-roll around it)? What do the sibling cases in the same module do? Does the canonical helper state its intent? A pattern that matches the repo's convention is not a risk of this PR.

## 4. Gather the conversation

Review threads come from the `gh-activity pr` output (`threads.items`, with `isResolved`, `isOutdated`, `path`, `line`, and comments); top-level comments and review bodies from `gh pr view <n> --json comments,reviews`. For each thread, check whether the code answered it: `git log origin/<base>...<head> --since='<comment createdAt>' --oneline -- <path>`.

Classify every thread into exactly one bucket:

| Bucket | Test |
|---|---|
| **Resolved, explained** | `isResolved` plus a reply saying why, or a commit after the comment touching that path. Cite the reply or the commit. |
| **Resolved, unexplained** | `isResolved`, no reply, no matching commit. Flag it: someone clicked resolve without answering. |
| **Unresolved, answered** | Open, but the author replied (disagreed, deferred, "next PR"). Quote the reason. |
| **Unresolved, no reply** | Open, nobody responded. Live feedback. |
| **Outdated** | `isOutdated`. Code moved under the comment. State whether the concern still applies to the current code. |

The resolution reason is quoted from the thread or evidenced by a commit, never invented. No reply and no commit means "no stated reason".

## 5. Stated intent and acceptance criteria

Collect the intent in priority order, and record which source was used:

1. **Spec ACs.** When `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json` names an initiative whose spec matches this branch or ticket, run `bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json` and use the live ACs (skip `superseded`).
2. **Issue ACs and description**, from the context bundle's issue source.
3. **PR body**, then commit messages and the branch name.

Map every AC to the code that implements it and the test that proves it, with a verdict per AC (covered, implemented but untested, partial, missing, contradicted, not judgeable from code), then list behaviour no AC asks for. Separately, compare the PR body's claims and any recorded decision with the diff (matches, missing, extra, contradicts). A departure from a repo convention found in 3c is drift too.

## Output

Write the sections in `references/output.md`, in its order: Background Context, Intent, Summary of Changes, Intent vs ACs, Code vs Stated Intent, Review Conversation Status, Risks and Impact (provisional severity on the shared scale), Reviewer Hotspots, Verification Gaps, Open Questions. Read that file before writing.

When the user wants findings, a verdict, or comments, point to `review others <n>` (someone else's PR) or `review self` (their own branch); this skill does not produce review findings.

## Rules

- Read the diff before writing a word of the explanation.
- Cite or drop it. No claim survives without a `file:line`, a commit sha, or a link.
- Distinguish "the code does X" (fact) from "this may break Y" (judgment). Label the judgment.
- Resolution reasons and background rationale are quoted or evidenced, never inferred. A thin background section is honest; a padded one is not.
- Never use em dashes.
- Uncertain about a hunk: say uncertain.
