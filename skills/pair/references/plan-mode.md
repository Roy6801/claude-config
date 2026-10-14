# Plan mode gates

Pair's approvals run in Claude Code's plan mode. Each **gate** is one small plan inside the bigger roadmap: the user approves it with ExitPlanMode, and only then does anything get written.

| Gate | Opens at | Plan file holds |
|---|---|---|
| Ladder gate | every `/pair plan` | all slices: branches, PRs, milestones, the user's test points |
| Slice gate | before the first commit of each slice | that slice's commits in full |
| Re-plan gate | a slice goes sideways (see below) | the revised commits from the current one on |

A one-commit slice whose ladder entry already carries the commit's files, snippet, check and test script skips its slice gate: the approved ladder is its slice plan. With `pair mode off`, slice and re-plan gates are skipped; the ladder gate still runs.

The re-plan gate opens when `pair check` exits 2 and the answer changes the plan (split, move or re-scope a commit), when a planned commit proves wrong while building, or after about 30 minutes blocked. A one-line answer from the user (raise the limit, keep the file) needs no gate.

## Running a gate

Plan mode is read-only: exploring, agents and the plan file only. Every state write (`pair`, `work.ts`, `br`, tickets or issues, the repo) waits for approval.

1. Call EnterPlanMode. If the user declines it, write the same template into the chat and treat their explicit OK as the approval.
2. Gather what the gate needs through read-only agents (Explore, `scout`, `gather-context`).
3. Write the plan file from the template below. Every commit gets a snippet or diff plus plain language.
4. Settle decisions in chat, as options in prose with a recommendation. A question from the user gets an answer-only turn: no plan file edit and no ExitPlanMode in that turn.
5. Call ExitPlanMode once every open question is answered or listed under Parked with the user's agreement.
6. Rejected with feedback: apply the edits to the same plan file and call ExitPlanMode again.

The gate is done when ExitPlanMode returns approved. Then run the after-approval steps, in order.

## After approval

1. Copy the plan file into the initiative directory: `ladder-plan.md`, `slice-<n>-plan.md`, or `slice-<n>-replan-<k>.md`.
2. Write the plan into the ladder JSON and run `pair plan save <file>`; fix every error it prints. Relay `pair plan show` after a ladder gate, the printed plan diff after a slice or re-plan gate.
3. Log every entry under "Decisions to log" with `work.ts decide`, using brainstorm's `--by` rule.
4. Continue: ladder gate → section 2 (set up); slice gate → `pair slice start n` and section 3; re-plan gate → resume section 3 at the revised commit.

## Ladder plan template

```markdown
# <Initiative>: ladder
Goal: <one sentence> · Base: <target> · Deadline: <date or none> · Total: <days>

## Slice <n>: <behaviour> (<milestone> · <branch> · <ticket> · <days> · ~<net lines>)
After this you can <user-visible behaviour>.
ACs: <ids>
Commits:
1. `<conventional title>`: <why>. Files: <paths>. <snippet + plain language, or a one-line summary when the slice gate will detail it>
Test script:
1. <step>: <expected result>
Exceptions: <what and why, or none>

## Timeline vs deadline
## Grilled
## Decisions to log
- <title>: <option | option> → <chosen>, because <why>
## Open questions
## Parked
```

## Slice plan template

```markdown
# Slice <n>: <behaviour>
Branch: <branch> from <base> · Budget: <net lines> · ACs: <ids>

## Commit <m>: `<conventional title>`
Why: <reason>
Files: <paths>
<snippet or diff>
<plain language: what changes and why it holds>
Check: <command> · ~<lines>

## Test script
1. <step>: <expected result>
## QA cases per AC
## Grilled
## Decisions to log
## Open questions
## Parked
```
