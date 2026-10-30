---
name: ship
description: Build one planned PR end to end: implement, raise it ready for review, run the review-fix loop and QA, then evidence and the final PR body.
disable-model-invocation: true
metadata:
  origin: local
---

# Ship

- `/ship <slug> <pr-name>`: ship the PR whose approved plan is pasted in the message or saved at `prs/<pr-name>/plan.md`.
- `/ship <slug> <pr-name> from <step>`: resume at the step after the last passed step in the PR's roadmap status.
- Roadmaps root: `~/roadmaps`. The roadmap: `~/roadmaps/<project>/<slug>/`, project from the origin remote. Everything for this PR goes to `prs/<pr-name>/`.
- Runs straight through to a PR that is ready for review; the user reviews it on GitHub and corrects it afterwards.

## Rules

- **World-facing:** every text ship writes for GitHub or Linear is world-facing (CLAUDE.md): commit messages, the PR title and body, evidence captions, narration, the ticket.
- **Ticket:** the PR's Linear ticket is created or updated at Start and refreshed at End when scope moved; these writes are pre-approved inside ship.
- **PR:** the labels and body shape come from `~/roadmaps/<project>/repo.md`. Without a profile, build it from the repo (label descriptions, workflows that trigger on labels, the PR bot or template) and the user's recent PRs, confirm it with the user once, and save it.
- **PR body:** ours, in the repo profile's shape, including any marker it names.
- **Status:** at each gate, set the PR's status in `roadmap.md`: `building (step <n> passed)` before the PR exists, `ready #<n> (step <n> passed)` after, and `ready #<n> (shipped)` at End. Check each status against its proof in the roadmap states (`$CLAUDE_CONFIG_DIR/skills/kickoff/references/templates.md`) before trusting or writing it.
- **Evidence:** per `references/evidence.md`, attached in the body with `pr upsert --attach`.
- **Scripts:** `pr` is `bun <this skill's directory>/scripts/pr.ts` (`facts` for the base, template, ticket and open PR; `push` to push the branch; `upsert` to create or edit the PR). `push` and `upsert` are stack-aware: a branch in a gh stack is pushed with `gh stack push` and its PR is created with `gh stack submit`, so it joins the GitHub stack.
- **Stacks:** never run `gh stack link` without `--base <trunk>`; without it the bottom PR's base moves to the default branch.

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run as chief of staff: you orchestrate, check each agent's diff and output, and hold the dialogue; agents do the work, git and `gh` included.
- Wiki: the roadmap folder's `wiki/`. Read `wiki/index.md` before each decision; ingest decisions, user corrections and findings as they happen.
- Every subagent reads `brief.md` first, writes into the PR folder, and returns at most 150 words.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - Resolve the roadmap folder; save the pasted plan to `prs/<pr-name>/plan.md` when the hook has not.
   - With no pasted plan and no `prs/<pr-name>/plan.md`, stop and tell the user to plan it with `/pickup <slug> <pr-name>`. `roadmap.md` and `hld.md` alone are never a plan to build from.
   - `general-purpose · sonnet · medium`: create or update the PR's ticket through `ticket` from the plan (title, description, acceptance criteria), linked to the roadmap's parent ticket; record the ticket and its `gitBranchName` as the branch in `roadmap.md`. Without a ticket (Linear unavailable), derive the branch per CLAUDE.md's prefix rule.
   - `general-purpose · haiku · low`: check the account (CLAUDE.md) and report its commit identity; open the branch through `wt`: reuse the worktree already open for it, else `wt new <branch> --base <base>` with no further confirmation, the base being the stack parent, else the integration target from `pr facts`; for a PR with a stack parent, register the branch on top of its parent's stack per the `gh-stack` skill; report the worktree path, used from here on.
   - `general-purpose · sonnet · medium`: write `brief.md`: repo, branch, base, commit identity, diff command against the merge base, check commands (discovered from the repo's scripts; when a package task depends on `^build`, the root task with `--filter <package>`, so a fresh worktree builds its dependencies first), requirements from the plan, scope and size cap, settled wiki items, pointers to `hld.md` and the wiki index, the app URL.
   - Gate: set the status to `building (step 1 passed)`.
2. **Implement** (sequential)
   - `general-purpose · sonnet · high`, one implementer with the Fix prompt in `$CLAUDE_CONFIG_DIR/skills/review-fix-loop/references/prompts.md` for every planned commit, plus the changeset the repo profile asks for; two in parallel only when the work has two large, unrelated parts in disjoint files.
   - Check each commit's diff against its planned commit.
   - Gate: the implementer's checks are green and the diff fits the size cap (350 lines, CLAUDE.md); set the status to `building (step 2 passed)`.
3. **Raise** (sequential)
   - `general-purpose · sonnet · medium`: write a short body from the plan, with any marker the repo profile names: what the PR does and why, true to what is built, with no placeholders; run `humanizer` on it.
   - `general-purpose · sonnet · medium`: `pr push`, then `pr upsert` the PR on its base, which opens it ready for review and assigned to the user, for every PR, stacked or not (for a branch in a gh stack both go through `gh stack`, so the PR joins the GitHub stack and `pr upsert` prints its stack number); for a stacked PR record that stack number in `roadmap.md`; add the labels per the repo profile; set the status to `ready #<n> (step 3 passed)`.
4. **Review-fix loop** (sequential)
   - Read `$CLAUDE_CONFIG_DIR/skills/review-fix-loop/SKILL.md` and run it on this PR (at most 3 rounds unless the user gave a count); the PR is open, so its "On a PR" steps run, End's thread replies and resolution included; the body is left to this skill's End.
   - Gate: set the status to `ready #<n> (step 4 passed)`.
5. **QA** (sequential)
   - Read `$CLAUDE_CONFIG_DIR/skills/qa/SKILL.md` and run it on this PR.
   - When QA reports failures, read `$CLAUDE_CONFIG_DIR/skills/review-fix-loop/SKILL.md` and run one round (its Round step only, skipping Final pass, Test-audit and End) with the failures as queued findings, then have QA rerun the failed cases and their neighbours.
   - Gate: set the status to `ready #<n> (step 5 passed)`.
6. **Evidence** (sequential)
   1. The tasks are the plan's Evidence section, minus what QA already captured. Only when that section is missing or no longer fits the final diff, `general-purpose · sonnet · high`: estimate the evidence that suits this PR from the requirements, the diff, QA's captures and `references/evidence.md`: per requirement, a stats table, before and after screenshots, a terra-local video, or a combination; mark what QA already captured. Into `evidence/plan.md`, one task per piece.
   2. Dispatch the tasks, each into `evidence/`:
      - Screenshots (parallel), `general-purpose · sonnet · medium` per task: the same item before (base or staging) and after (this branch), through `claude-in-chrome`.
      - Stats tables (parallel), `general-purpose · sonnet · high` per task: measure through scripts, tests or evals (never a database), vetted with `benchmark-checklist`.
      - Execution output (parallel), `general-purpose · sonnet · medium` per task: the named test's fail-before and pass-after output, or the console output of the behaviour.
      - Video (after the screenshots, one at a time, since it records a window), `general-purpose · sonnet · high`: a terra-local walkthrough of the flow, narrated in the user's voice per terra-local's guides.
   - Gate: each requirement still without evidence goes on the End list for the user, with why; set the status to `ready #<n> (step 6 passed)`.
7. **End** (sequential)
   - `general-purpose · sonnet · high`: write the final body once, in the repo profile's shape, from the final diff and `evidence/`, its Evidence section showing only evidence that exists with one context line per piece; check every statement in it against that diff; run `humanizer` on it; save it as `evidence/body.md`, referencing each file as `](./<file>)`, and `pr upsert --attach` those files.
   - When folds or stacks moved scope, `general-purpose · sonnet · medium` updates the ticket through `ticket`.
   - `general-purpose · sonnet · medium`: ingest what this PR settled into the wiki (decisions, HLD notes, collisions and how they were resolved, user corrections), dated and citing the PR folder; set the PR's status to `ready #<n> (shipped)` and the Next line in `roadmap.md` to the following PR's next step per the roadmap states.
   - Copy `/pickup <slug>`.
   - Tell the user: the PR link, one line on what it does, the loop and QA summaries, requirements left without evidence and why, anything else noted for them, and that `/pickup <slug>` is on the clipboard.
