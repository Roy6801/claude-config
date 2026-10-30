---
name: review-fix-loop
description: Run review-fix rounds (deslop, simplify, review, plan, fix) on a PR or ship's branch, then test-audit.
disable-model-invocation: true
metadata:
  origin: local
---

# Review-fix loop

- `/review-fix-loop #<number> [rounds]`: on an open PR, with its reviewer and bot threads.
- From `ship`: on ship's branch, using ship's `brief.md`.
- Rounds: 4 unless a count is given. Each round runs every step; a step with nothing to do passes through.
- Output: `prs/<pr-name>/round-<n>/` in the roadmap folder (`~/roadmaps/<project>/<slug>/`, the roadmap whose `roadmap.md` lists the branch); for a PR outside any roadmap, `~/roadmaps/<project>/pr-<number>/`.

## Rules

- **Fixes:** the recommended fix is applied. A fix that leaves the PR's scope, takes the PR past the brief's size budget, or changes a contract other planned PRs depend on is a collision.
- **Collisions:** the loop never stops for them; the decider folds or stacks each (Decider prompt). The stacked PR is set up (ticket, branch, roadmap entry, plan) and built later through `/ship`.
- **Stack cap:** at most 2 stacked PRs set up from one PR, counted across runs from the `roadmap.md` entries that name this PR as their origin. Past the cap, a collision joins one of those stacked PRs' plans when it fits, else goes to the End list for the user.
- **HLD:** a guide. When findings show it wrong or stale, correct it, or record the deviation this PR needs, as a dated note in `hld.md`.
- **Commits:** atomic; a conventional title and a short description of the change only.
- **On a PR:** push after every round (`git push --no-verify`); fixes land as new commits. When the PR is a stack layer with layers above it, rebase and push those layers per the `gh-stack` skill after each round.
- **Tickets:** creating a stacked PR's ticket is pre-approved; every other Linear write needs the user's OK.
- **Monitor (on a PR):** new comments from bots and people join the next round's review. Comments that land after the last round's Review step are reported at End with an offer of another round.
- **PR body (on a PR):** owned by us, in the shape in `~/roadmaps/<project>/repo.md`, its keep marker on the first line.

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run as chief of staff.
- Every subagent reads `brief.md` first, writes into the round folder, and returns at most 150 words.
- Prompts for the review, plan, decider and fix agents: `references/prompts.md`.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - From ship: use ship's `brief.md`.
   - On a PR: read the base and branch with `gh pr view`; write `brief.md`: diff command against the merge base, check commands, requirements (the PR plan, else the ticket), scope and budget, settled wiki items, and pointers to `hld.md` and the wiki index.
   - On a PR: start the monitor with `Monitor`; pull the unresolved threads into the round 1 queue.
2. **Round n** (sequential, rounds 1 to N)
   1. `general-purpose · sonnet · medium`: run `deslop` on the diff, editing the code.
   2. `general-purpose · sonnet · high`: run `/simplify` on the diff, editing the code.
   3. Check both edits against the settled decisions in the brief; drop any hunk that undoes one; commit.
   4. **Review** (parallel), each into `round-<n>/review/`:
      - The applicable `pr-review-toolkit` agents (`code-reviewer` always; `pr-test-analyzer`, `silent-failure-hunter`, `type-design-analyzer`, `comment-analyzer` when the diff touches tests, error handling, types or comments) `· opus · high`.
      - `general-purpose · opus · high`: `thermo` on the diff.
      - `general-purpose · opus · high`: `code-review` against the merge base, with the brief's requirements as the spec.
      - `general-purpose · opus · high`: the code against the requirements and `hld.md`: gaps, scope creep (behaviour no requirement asks for), and for each code and HLD mismatch, which one is wrong.
      - The queued reviewer and bot threads.
   5. `Plan · opus · high`, Validate and plan prompt → `round-<n>/plan.md`.
   6. `Plan · opus · high`, fresh, Decider prompt → `round-<n>/decisions.md`; add folds to the plan's commits.
   7. For each stack decision, in parallel:
      - `general-purpose · sonnet · medium`: create the ticket and the PR's entry in `roadmap.md` with this PR as its stack parent and origin; `ship` registers the layer per the `gh-stack` skill when it builds it.
      - `Plan · opus · high`: draft that PR's plan per `$CLAUDE_CONFIG_DIR/skills/pickup/references/templates.md` from the moved findings, saved as `prs/<new-pr-name>/plan.md`.
      - For a collision joining an existing stacked PR: `Plan · opus · high` adds the moved findings to that PR's `plan.md`.
   8. `general-purpose · sonnet · medium`: run `humanizer` on the planned commit titles and descriptions.
   9. `general-purpose · sonnet · high`, one fresh agent per commit, Fix prompt, in parallel when files are disjoint: each new test fails without its change and passes with it.
   10. Commit each; write the HLD notes; run the checks; on a PR, push.
   - Gate: the checks pass; a failing commit goes back to a fresh Fix agent with the failure output until green.
3. **Test-audit** (after the last round)
   - `general-purpose · opus · high`: run `test-audit` on the PR's tests, keeping every test that alone guards a requirement.
   - Commit, run the checks; on a PR, push.
4. **End** (sequential)
   - On a PR: `general-purpose · sonnet · high` updates the body in the repo profile's shape, then runs `humanizer` on it; show the drafted thread replies, and post and resolve them per `$CLAUDE_CONFIG_DIR/skills/review/references/posting.md` after the user's OK.
   - Stop the monitor.
   - Tell the user one line per round (found, fixed, skipped, folded, stacked), then list each decision from `decisions.md` with its reason, the stacked PRs set up, and any collisions left past the stack cap.
