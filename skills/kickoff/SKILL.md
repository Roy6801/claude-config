---
name: kickoff
description: Plan a piece of work into a roadmap (context, problem, HLD, milestones, PRs) under ~/roadmaps.
disable-model-invocation: true
metadata:
  origin: local
---

# Kickoff

- Turns a piece of work into an approved roadmap in `~/roadmaps/<project>/<slug>/`.
- Slug: a short kebab-case name the user confirms.
- Messages to the user fit one screen and lead with what to look at.

## PR sizing

- A part above the PR size budget (CLAUDE.md) goes under `## Size decisions`: split points, size of each piece, two options (independent PRs, stacked PRs, the stack's layers designed per the `gh-stack` skill's `references/stack-design.md`), a recommendation. The user decides each one.
- Each PR has one independent scope, is built from atomic commits, and has a stable kebab-case name.
- Linear tickets found in context attach to their PRs, and a parent ticket is recorded in `roadmap.md`. New PR tickets are created by `ship` at Start.
- Each PR gets a record in `roadmap.md`: name, branch, base or stack parent, ticket when known, status (the roadmap states in `references/templates.md`).

## HLD

- The high-level design: the shape of the whole change, written before any PR is planned. It is what the user reviews and decides on; each PR's plan later turns it into diffs.
- Pick the variant by the kind of work and write it per `references/hld.md`: code work (feature, fix, refactor) or other work (investigation, data or pipeline, infra or config, docs, QA).

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run this session as chief of staff.
- Wiki: the roadmap folder's `wiki/`.
- Every subagent is fresh and runs in the background, writes its output into the roadmap folder, and returns at most 150 words.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - Confirm the slug with the user.
   - `general-purpose · haiku · low`: read the project from the origin remote; create the folder, `roadmap.md` (title, `**Next:**` line) and `wiki/index.md`.
2. **Context** (parallel)
   - `general-purpose · sonnet · medium`, `gather-context <ticket|pr|topic> <focus>` → `research/context.md`.
   - `Explore · sonnet · medium`: code areas the work touches → `research/code.md`.
   - `general-purpose · sonnet · high`, one per third-party library, framework or service: `gather-context research "<question>"` → `research/research-<library>.md`.
   - Gate: every dispatched source has a research file.
3. **Problem** (after context)
   - `general-purpose · sonnet · high`: draft the problem in two or three sentences from `research/`.
   - Present the draft; the user confirms or corrects it.
4. **Save** (after the problem)
   - `general-purpose · sonnet · medium`: list every source in `sources.md`; write the problem under `## Problem` in `roadmap.md`; ingest every durable finding (decisions, constraints, user corrections, subsystems) into the wiki, each page dated and citing its research file, listed in `wiki/index.md`.
   - Gate: `sources.md`, the problem and `wiki/index.md` are written.
5. **Plan** (after save, sequential)
   - Call `EnterPlanMode`.
   - `Plan · opus · high`: read `wiki/index.md` and `research/`; draft the plan per `references/templates.md`, with the HLD written per `references/hld.md`, first line `<!-- roadmap: <project>/<slug> -->`.
   - `Plan · opus · high`, fresh, after the draft: check each PR's size estimate against the code; list every part above the size budget.
   - Write the plan file with the size findings applied (the one write plan mode keeps out of subagents), present it, and revise it with the user.
   - Gate: every size decision answered; the user approves through `ExitPlanMode`.
6. **Save plan** (after approval)
   - `general-purpose · sonnet · medium`: split `plan.md` into `roadmap.md` and `hld.md` per `references/templates.md`, every PR's status `planned` (the approved roadmap plans no PR yet) and the Next line "Plan <first pr-name> with /pickup <slug>"; ingest the decisions settled while planning into the wiki.
   - Gate: `roadmap.md` holds the Next line, the parent ticket when one exists, and every PR's record with status `planned`, `hld.md` exists, `wiki/index.md` lists every decision.
7. **End** (sequential)
   - Tell the user: "Roadmap saved. Next: `/handoff`."
