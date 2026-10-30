---
name: pickup
description: Continue a roadmap where it stands; plans the next PR in plan mode or copies the ship command for a PR in progress.
disable-model-invocation: true
metadata:
  origin: local
---

# Pickup

- The roadmap: `~/roadmaps/<project>/<slug>/` (CLAUDE.md).
- `/pickup <slug>`: continue from `handoff.md` and the `**Next:**` line in `roadmap.md`.
- `/pickup <slug> <pr-name>`: continue one PR.
- `/pickup #<number>`: continue a GitHub PR.
- Reads and routes. Execution happens in `/ship`, in a fresh chat.
- A correction or redirect from the user after End (such as "plan the first PR") re-enters this file at Route or Plan and follows its steps.
- Statuses and the Next line follow the roadmap states in `$CLAUDE_CONFIG_DIR/skills/kickoff/references/templates.md`.

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run this session as chief of staff.
- Every subagent is fresh, writes into the roadmap folder, and returns at most 150 words.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - Resolve the roadmap folder from the project and slug; for `#<number>`, find the `roadmap.md` under `~/roadmaps/<project>/` that lists the PR's branch.
   - Read `roadmap.md`, `handoff.md` and `wiki/index.md`; pick the PR (named, or from the Next line).
2. **State** (sequential)
   - `general-purpose · haiku · low`: report the PR's status from `roadmap.md` and its state from `prs/<pr-name>/` (whether `plan.md` or `plan-draft.md` exists) and `gh pr view` (number, merged); for a PR in a stack, sync the stack first per the `gh-stack` skill so merged lower layers and rebases are current.
3. **Route** (sequential)
   - Check the status against its proof in the roadmap states first; route on the status the proof supports.
   - Merged: mark it merged in `roadmap.md`, move the Next line to the following PR, and return to step 2 for that PR.
   - No PR left: tell the user the roadmap is complete and move it to `_done/` with its merged worktrees removed (CLAUDE.md), then End.
   - Build stopped partway: copy `/ship <slug> <pr-name> from <step>`, the step read from the roadmap status, then End.
   - Shipped (`ready #<n> (shipped)`), not merged: tell the user it awaits their review and merge, then End.
   - `pr plan approved` with `prs/<pr-name>/plan.md`, nothing built: copy `/ship <slug> <pr-name>`, then End.
   - Not planned, or `pr plan approved` without `prs/<pr-name>/plan.md`: `general-purpose · haiku · low` sets the status to `planned` and the Next line to "Plan <pr-name> with /pickup <slug>"; then step 4.
4. **Plan** (sequential)
   - Call `EnterPlanMode` before any planning dispatch, every time, re-entries included.
   - `Plan · opus · high`: read `hld.md`, the PR's entry in `roadmap.md`, `wiki/index.md`, `prs/<pr-name>/plan-draft.md` when one exists, and the code; draft the PR plan per `references/templates.md`, first line `<!-- pr: <project>/<slug>/<pr-name> -->`. Each part follows the skills for its kind, as `$CLAUDE_CONFIG_DIR/skills/kickoff/references/hld.md` lists them; each commit names the skills its implementer follows and describes its change in words, with code only for its contracts.
   - Write the plan file from the draft, present it, and revise it with the user until approved. A plan drafted here for another PR (a split, a later PR) goes to that PR's `prs/<other-pr>/plan-draft.md`.
   - Gate: planned work within the ~200-line target (CLAUDE.md), or a split the user chose; the user approves through `ExitPlanMode`.
   - `general-purpose · haiku · low`, given the approved plan file's path from the `ExitPlanMode` result: confirm `prs/<pr-name>/plan.md` matches it (the plan hook saves it on approval), and when it does not, copy the plan file there and report that the hook missed it; delete `prs/<pr-name>/plan-draft.md`; set the PR's status to `pr plan approved` and the Next line to "Ship <pr-name>" in `roadmap.md`.
5. **End** (sequential)
   - Tell the user: "Next: a fresh chat, then `/ship <slug> <pr-name>`."
