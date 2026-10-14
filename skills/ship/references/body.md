# PR title and body

The `review` skill's `self` scope checks a PR body for: what, why, how to test, evidence, risk, ticket link, the AC and evidence table, and exceptions. Every body this skill drafts carries all of them, inside the repo template's headings when it has them, added as sections when it does not.

## Default sections (no repo template)

`## Why`, `## What changed`, `## Acceptance criteria`, `## How to test`, `## Evidence`, `## Risk and rollout`, `## Exceptions`, `## Ticket`. A section that does not apply gets `N/A` and a one-line reason, never deletion. Evidence is never `N/A`: it is left out only when the user said to skip it for this PR. A repo template's screenshots or demo heading is the Evidence section.

## Content

- **Why.** The real problem in prose, from the issue and the spec's Problem. Quote at most one or two AC lines inline, with checkbox markers stripped. Link the issue the way the author's recent PRs do (for example `Closes #123`).
- **What changed.** Grouped by behavior, not by file. Under it, the Added / Modified / Deleted rollup from the commit bodies, one line per unit. The diff is the source of truth: when a commit message misdescribes the diff, write what the diff shows and point out the mismatch to the user.
- **Acceptance criteria.** A table, one row per AC this PR delivers (the slice's ACs for a pair slice):

  | AC | Verdict | Evidence |
  |---|---|---|
  | AC-1 Admin creates a role | pass | qa report case 3, GIF; `role.test.ts` |

  Verdicts come from the latest QA report or from tests run in this session: `pass`, `fail`, `uncertain`, or `not covered`. An AC with no evidence says `not covered` and why. Never tick a box the evidence does not back.
- **How to test.** Numbered steps a reviewer can follow: where to go, what to do, what to see. For a pair slice, start from its `test_script`. Add the edge cases the diff handles.
- **Required by change type.**

  | Type | Also required |
  |---|---|
  | fix | How to reproduce on the base branch (observed vs expected, exact error text), root cause in prose with identifiers in backticks, how the fix works, the same steps as verification |
  | feature | The numbered test steps above, plus edge cases |
  | refactor | Evidence that behavior is unchanged: the same screen or output before and after |
  | UI-visible, any type | A demo in the Evidence section: before and after for a fix, a walkthrough GIF or video for a feature |

  Type precedence when signals disagree: branch prefix, then the diff, then the ticket label; tell the user about the disagreement. Write "the base branch", never its name, in reproduction steps.
- **Evidence.** One block per fix or AC, in the order of What changed: a bold label with the commit, one sentence on what the image shows, then the image (`![<what it shows>](./<file>)`). Before and after pairs for fixes. Say where it was taken (local build, preview, staging data) and anything staged for it (markup injected in the browser, seeded data); a staged screen is never presented as real data. Not UI-visible: output that shows the behavior itself (a script run, a log excerpt, an API response), quoted verbatim. Never typecheck, lint or test results, counts or commands: CI reports them on the PR. Only files the user approved in the evidence review.
- **Risk and rollout.** Only what is real: the feature flag and its default when incomplete work merges, migrations and their order, env vars, deploy order, how to roll back (revert, flag off). A low-risk change says so in one line.
- **Exceptions.** Every approved convention exception from the plan (`exceptions` in pair.json) or the review, with what and why, and the size exception from `references/size.md` when there is one.
- **Additional notes.** The part of the diff a reviewer should read hardest, when there is one.
- Never mention a stack, a parent PR or sibling PRs; GitHub shows the chain.

## Update mode

Draft from the diff, not the old body. Carry over existing media embeds (uploaded asset URLs stay as they are) and hand-written notes that still hold; new commits that change what a reviewer sees add their own evidence; show what changed against the old body. Ticked boxes carry over only when re-verified in this session or confirmed by the user. A block no human wrote (a bot footer, a block inside HTML comment markers an app added) stays verbatim at the same position, since `--body-file` replaces the whole body. Unsure whether a block was hand-written: keep it and list it for the user.

## Changesets

`.changeset/config.json` exists and the diff adds no `.changeset/*.md`: if the repo has a `generate-changeset` skill, invoke it; otherwise follow the repo's changeset docs. A non-user-facing change gets an empty changeset when the repo's docs say so. The changeset is its own commit, made only after a yes, in the repo's commit format (through `pair commit` when pair is on). Other tooling (release-please, a changelog rule in CONTRIBUTING): follow its documented convention. None found: skip silently.

## Voice (the user signs this)

- No em or en dashes (`pr upsert` warns on them).
- No tooling narration ("ran", "grepped", "I checked"). State the fact.
- No praise, rhetorical questions, or closing summary lines.
- Error text, AC lines and log lines are quoted verbatim.
- Match the density, title format and embed style of the author's recent PRs, never their content.
- No AI attribution and no session links or ids. If the harness asks for a session footer, drop it silently.
