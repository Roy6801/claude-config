# Plan gate: one PR

Pair plans one PR at a time, in Claude Code's plan mode. The gate opens when `pair next` says `plan` (the PR has no approved plan) and again as a **re-plan gate** when a PR goes sideways while building: `pair check` exits 2 and the user's answer changes the plan (split, move or re-scope a commit), a planned commit proves wrong, or about 30 minutes blocked. A one-line answer from the user (raise the limit, keep the file) needs no gate. A PR that is already built never opens one.

## Inputs

Gather them through read-only agents so the main thread stays free:

- The PR's ladder entry (`pair plan show --json`): goal, "after this you can", ACs, rough commits, branch, ticket or issue, budget.
- The AC text: `bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json` for `AC-<n>`, the `ticket` skill in read mode for `<TICKET>/AC-<n>` on a Linear ticket.
- The repo's conventions through `gather-context` in conventions mode: the patterns to follow with `file:line`, and the check commands.
- The code the PR touches, read deeply enough to write real snippets of each change.
- For a library decision: its docs (context7) and its GitHub source and issues, through an agent, before proposing anything.

## Running the gate

Plan mode is read-only: exploring, agents and the plan file only. Every state write (`pair`, `work.ts`, `br`, tickets or issues, the repo) waits for approval.

1. Call EnterPlanMode. If the user declines it, write the same plan into the chat and treat their explicit OK as the approval.
2. Gather the inputs above.
3. Write the plan file from the template below. Run the self-grill in `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md` on it and fix what it finds; whatever stays unresolved goes under Open questions.
4. Settle decisions in chat, as options in prose with a recommendation. A question from the user gets an answer-only turn: no plan file edit and no ExitPlanMode in that turn.
5. Call ExitPlanMode once every open question is answered, or parked with the user's agreement.
6. Rejected with feedback: apply the edits to the same plan file and call ExitPlanMode again. Feedback that means "approved, build it later or in a new chat" is an approval: run the steps below with build later.

The gate is done when ExitPlanMode returns approved (or the user approved to build later). The approval prompt may offer to clear the context before building; that works too, since the saved plan carries over.

## After approval, before any code edit

1. Write the PR's machine plan as one slice object (shape in `references/ladder.md`) in the scratchpad: `test_script` from "How you can check it yourself", `budget`, `patterns`, `exceptions`, `green_check` when the PR has one, and every commit with `title`, `why`, `files`, `check`, `est_lines` and `acs`. Commit titles stay the same as in the ladder unless the plan changed them.
2. Run `pair plan save <slice.json> --slice <n> --plan <plan file>`. It copies the plan to `pr-<n>-plan.md` in the initiative directory, marks the PR approved, holds it for this chat and updates the roadmap. Fix every problem it prints, then relay its plan diff.
3. Log only the decisions the user made or must know about with `work.ts decide`.
4. Build now: continue with the Build section of `SKILL.md`. Build later: write no code and ask "Plan saved. Hand off to a fresh chat to build PR <n>?"; on yes run the `handoff` skill with `/pair implement <slug>`.

A re-plan saves the same way; the new plan file replaces `pr-<n>-plan.md` and the plan diff shows what changed. Building resumes at the first commit that is not done.

## Plan template

Readable means plain sentences and no jargon, not brief: the user rejects thin or prose-only plans. Every commit gets its plain explanation, its files, real snippets or diffs of the key change (as many as the commit needs), the tests it adds and its check.

````markdown
# PR <n>: <short name>

## What this PR does
<2 to 4 plain sentences: what users can do afterwards. Say when it goes live together with another PR, and which one.>

## How it is built: <k> commits

### 1. <plain title>
<What it changes and why, in plain sentences.>

Files: <path>, <path>

```ts
<real snippet or diff of the key change>
```

<More snippets when the commit has more than one key change, each with a line on what it shows.>

Tests: <the tests it adds or changes, and what each one proves>
Check: `<command>`

### 2. ...

## How you can check it yourself
1. <step>. <what you see>.

## What goes in the PR
<One or two sentences: what the description says, which screenshots or video.>

## Exceptions to the repo's conventions
<Only when there are any: what and why, for the user to approve.>

## Open questions
<Only when there are any.>
````
