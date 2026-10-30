---
name: review-fix-loop
description: Run review-fix rounds (deslop, simplify, review, plan, fix) on a PR or ship's branch, then test-audit.
disable-model-invocation: true
metadata:
  origin: local
---

# Review-fix loop

- `/review-fix-loop #<number> [rounds]`: on an open PR, with its reviewer and bot threads.
- From `ship`: on ship's PR, open since ship's Raise step, using ship's `brief.md`; every "On a PR" step applies (threads, monitor, pushes, End replies and resolution) except End's body update, which ship's End owns.
- Rounds: at most 3 unless a count is given. Each round runs every step; a step with nothing to do passes through.
- Stop: a round whose validated plan has nothing to fix, fold or stack is clean, and the loop ends after it. When the cap ends the loop on a round that applied fixes, the Final pass reviews them.
- Output: `prs/<pr-name>/round-<n>/` in the roadmap folder (`~/roadmaps/<project>/<slug>/`, the roadmap whose `roadmap.md` lists the branch); for a PR outside any roadmap, `~/roadmaps/<project>/pr-<number>/`.

## Rules

- **Fixes:** the recommended fix is applied. A fix that leaves the PR's scope, takes the PR past the brief's size cap, or changes a contract other planned PRs depend on is a collision.
- **Collisions:** the loop never stops for them; the planner folds or stacks each (Validate and plan prompt). The stacked PR is set up (ticket, branch, roadmap entry, plan) and built later through `/ship`.
- **Stack cap:** at most 2 stacked PRs set up from one PR, counted across runs from the `roadmap.md` entries that name this PR as their origin. Past the cap, a collision joins one of those stacked PRs' plans when it fits, else goes to the End list for the user.
- **HLD:** a guide. When findings show it wrong or stale, correct it, or record the deviation this PR needs, as a dated note in `hld.md`.
- **Commits:** atomic; a conventional title and a short description of the change only.
- **On a PR:** push after every round with `pr push` (`bun $CLAUDE_CONFIG_DIR/skills/ship/scripts/pr.ts push`; for a branch in a gh stack it runs `gh stack push`, which keeps the stack record current, else `git push --no-verify`); fixes land as new commits. When the PR is a stack layer with layers above it, rebase and push those layers per the `gh-stack` skill after each round.
- **Tickets:** creating a stacked PR's ticket is pre-approved; every other Linear write needs the user's OK.
- **Monitor (on a PR):** new comments from bots and people join the next round's review. Comments that land after the last Review step are reported at End with an offer of another round.
- **PR body (on a PR):** owned by us, in the shape in `~/roadmaps/<project>/repo.md`, its keep marker on the first line.

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run as chief of staff.
- Every subagent reads `brief.md` first, writes into the round folder, and returns at most 150 words.
- Prompts for the review, plan and fix agents: `references/prompts.md`.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - From ship: use ship's `brief.md`.
   - Standalone: read the base and branch with `gh pr view`; write `brief.md`: the commit identity from the account check (CLAUDE.md), diff command against the merge base, check commands, requirements (the PR plan, else the ticket), scope and size cap, settled wiki items, and pointers to `hld.md` and the wiki index.
   - On a PR: start the monitor with `Monitor`; pull the unresolved threads into the round 1 queue.
2. **Round n** (sequential, rounds 1 to N)
   1. `general-purpose · sonnet · medium`: run `deslop` on the cleanup scope, editing the code. Cleanup scope: the whole diff in round 1; the previous round's fix commits after.
   2. `general-purpose · sonnet · high`: run `/simplify` on the cleanup scope, editing the code.
   3. Check both edits against the settled decisions in the brief; drop any hunk that undoes one; commit.
   4. **Review** (parallel), each on the whole diff against the merge base, into `round-<n>/review/`:
      - `general-purpose · opus · high`: `thermo` on the diff.
      - `pr-review-toolkit:code-reviewer · opus · high`: bugs and the repo's rules from every `AGENTS.md` and `CLAUDE.md` (root and nested in touched directories) and the standards docs the brief names.
      - `general-purpose · opus · high`: the code against the requirements and `hld.md`: gaps, scope creep (behaviour no requirement asks for), and for each code and HLD mismatch, which one is wrong.
      - The queued reviewer and bot threads.
   5. `Plan · opus · high`, Validate and plan prompt → `round-<n>/plan.md`.
   6. When the plan has stack decisions, one `general-purpose · opus · high` agent handles all of them: for a new stacked PR, create its ticket and its entry in `roadmap.md` with this PR as its stack parent and origin (`ship` registers the layer per the `gh-stack` skill when it builds it), and draft its plan per `$CLAUDE_CONFIG_DIR/skills/pickup/references/templates.md` from the moved findings, its Does section stating the planner's in and out of scope, saved as `prs/<new-pr-name>/plan.md`; for a collision joining an existing stacked PR, add the moved findings to that PR's `plan.md`.
   7. `general-purpose · sonnet · high`, one fix agent with the Fix prompt for all the round's commits; two in parallel only when they form two large, unrelated parts in disjoint files.
   8. Check each commit's diff against its planned commit; write the HLD notes; on a PR, push.
   - Gate: the fix agent's checks are green; a failing commit goes back to a fresh Fix agent with the failure output until green.
3. **Final pass** (only when the cap ended the loop on a round that applied fixes), into `round-<N+1>/`
   - Round steps 1 to 5, with no fix step; on a PR, push the cleanup commit. The plan's findings go to the End list for the user.
4. **Test-audit** (after the last round or the Final pass)
   - `general-purpose · opus · high`: run `test-audit` on the PR's tests, keeping every test that alone guards a requirement and proving each kept test can fail (its step 4).
   - Commit, run the checks; on a PR, push.
5. **End** (sequential)
   - On a PR, standalone: `general-purpose · sonnet · high` updates the body in the repo profile's shape, then runs `humanizer` on it.
   - On a PR: `general-purpose · sonnet · high`: collect the reply drafts from every round's `plan.md`; check each against the final diff, so a `Fixed in <sha>` names the commit that holds the fix now and a reply whose fix later changed is redrafted; run `humanizer` on them → `replies.md`.
   - On a PR: show all replies together per `$CLAUDE_CONFIG_DIR/skills/review/references/posting.md` (Checkpoint); on the user's one OK for the batch, post them.
   - On a PR: list every replied thread with its link and ask once "Resolve all <N>?"; on yes, resolve them all per `$CLAUDE_CONFIG_DIR/skills/review/references/api.md`.
   - Stop the monitor.
   - Tell the user the rounds run and why the loop stopped (a clean round or the cap), one line per round (found, fixed, skipped, folded, stacked), the Final pass's findings, then list each collision decision from the rounds' `plan.md` with its reason, the stacked PRs set up, any collisions left past the stack cap, and each replied thread still unresolved, with its link.
