---
name: review
description: |
  Code review in four scopes. `slice`: a pair checkpoint's review of one slice (built-in /simplify as separate commits, then both `reviewer` passes, thermo and correctness, with repo conventions, then conformance to the spec's ACs). `self`: the whole branch against its base before asking others (ACs with evidence, tests, size, hygiene, convention exceptions, PR body) as a checklist. `feedback`: comments received on my PR, each verified against the code and classified valid, invalid or question, with a proposed reply and fix plan. `others`: someone else's PR, with context, explain, reviewer findings and triage into a severity-ranked report and draft comments. Findings go to the user; nothing is fixed or posted without approval, and all posting goes through `post-pr-comments`.

  Use when: a `pair` checkpoint reaches its review step, before requesting review ("review my branch", "am I ready for review"), when comments arrive on my PR ("handle the review comments", "address feedback on #123"), when reviewing a teammate's PR ("review PR 4252"), or `/review slice|self|feedback|others [PR]`.
user-invocable: true
metadata:
  origin: local
---

# Review

One entry point for every code review. The heavy reading runs in the `reviewer` agent (`$CLAUDE_CONFIG_DIR/agents/reviewer.md`) and in the skills this one calls; the main thread holds the scope, the triage, and the user's decisions. Findings use the schema in `$CLAUDE_CONFIG_DIR/skills/thermo/references/findings.md`.

## Scopes

| Scope | Argument | Reads | Detail |
|---|---|---|---|
| `slice` | none (current pair slice) | slice diff, conventions, slice ACs | `references/slice-self.md` |
| `self` | optional PR or branch (default: current) | whole branch, ACs, PR body, threads | `references/slice-self.md` |
| `feedback` | PR number (default: current branch's PR) | review threads and comments on my PR | `references/feedback.md` |
| `others` | PR number or URL | their PR, context bundle, their conventions | `references/others.md` |

With no scope, infer it: a pair checkpoint in progress means `slice`; a PR authored by someone else means `others`; my PR with unresolved threads means `feedback`; otherwise `self`. Say which scope you picked in one line. Read the scope's reference before starting, and `references/triage.md` for `feedback` and `others`.

## Shared setup

1. **Repo and base.** Run `bun $CLAUDE_CONFIG_DIR/skills/branch/scripts/br.ts where --json`. The base is the open PR's base, else the gh stack parent, else `target.branch` (the integration target). For a PR number, run `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json` and use its `base` and `headSha`. Fetch the base and head refs, then always review the three-dot range `origin/<base>...<head>`.
2. **Output directory.** Use the initiative slug the caller passed, if any. Otherwise run `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json`, and when it returns no slug from the repo, rerun it with `--cwd <session working directory>`: initiatives are bound to the directory the session started in. With an active initiative, use `<dir>/review/<scope>-<YYYY-MM-DD>/`; otherwise `$CLAUDE_CONFIG_DIR/state/review/<YYYY-MM-DD>-<repo>-<scope>[-pr-<n>]/`. Create it. Files written there: `acs.json`, `findings-thermo.json`, `findings-correctness.json`, `report.md`.
3. **Acceptance criteria.** With an active initiative, run `bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json > <outdir>/acs.json` (live ACs only; ignore entries with `superseded`). For `slice`, keep only the slice's AC ids. Without a spec, take the ACs from the linked ticket or issue (`ticket` read mode for a Linear key when Linear is connected, `gh issue view` for a GitHub issue). No ACs anywhere: say so; the AC checks become n/a, never invented.
4. **Conventions.** Reuse a conventions bundle produced for this repo root during this initiative (`<dir>/context/*/conventions.md`); otherwise run the `gather-context` skill in `conventions` mode with the areas taken from the diff's paths. Pass the path, never the content, to the reviewer.

## Dispatching the reviewer

Two `reviewer` agents per range, dispatched in parallel (opus, defined in the agent file): `Pass: thermo` for maintainability and `Pass: correctness` for bugs. They cover different ground, so run both in every scope. Each prompt carries only pointers:

```
Review <repo root> range <origin/base>...<head sha> (PR #<n> if any).
Pass: <thermo | correctness>.
Conventions: <path or "none">. ACs: <outdir>/acs.json, or "<ticket ACs as text>", or "none".
Focus: <scope-specific: slice ACs / whole branch across slices / points already raised in open threads>.
Return the JSON object defined in $CLAUDE_CONFIG_DIR/skills/thermo/references/findings.md and nothing else.
```

Save the returned JSON to `<outdir>/findings-<pass>.json` and check it parses (`jq . <outdir>/findings-<pass>.json`). If it does not, or a finding lacks `path:line` evidence, send it back once with the specific problem; after a second failure, report the gap instead of repairing the findings yourself. Spot-check the top findings against the code before showing them: the agent's output is a candidate list, not a verdict.

Run independent work in parallel in one message: the reviewer, `explain`, `gather-context`, and the mechanical checks do not wait for each other.

## Presenting findings

- Group by severity (`blocker`, `major`, `minor`, `nit`), each with `file:line`, claim, evidence and suggestion, and a recommended disposition. For `slice` and `self` the dispositions are fix now, follow-up, or rejected with reason; for `others`, raise, ask, fold, or drop; for `feedback`, see its reference.
- Show confidence next to severity and never let one stand in for the other.
- Run `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md` on the report before showing it, and show the Grilled block.
- Offer the report (`self` checklist, `others` review report) as a private artifact page; publish only on a yes.
- End with the decision you need from the user, never with an automatic next step.

## Rules

- Nothing is fixed without approval. Accepted fixes land as atomic commits: say "commit through `pair commit`" (with a `--deviation` naming the review source), or, when pair is off, still one commit per fix with a rationale body.
- Nothing is posted by this skill. Comments and replies go through `post-pr-comments`, only after the user approves the exact text. The verdict becomes the review event: `REQUEST_CHANGES` when any survivor asks for an edit, `COMMENT` otherwise; `APPROVE` only on the user's explicit ask. Threads on someone else's PR stay unresolved.
- Every finding cites `path:line`. Low-confidence nits are dropped. A comment received, or a finding generated, is a candidate until it passes triage.
- Never check out someone else's branch in the user's working tree; fetch refs and read with `git show` or `gh pr diff`.
- Never touch a database or read `.env` files. A finding that needs a data fact becomes a data request to the user.
- Write reports in full, clear sentences; chat status stays short.
