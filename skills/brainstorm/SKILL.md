---
name: brainstorm
description: |
  Front door for any non-trivial request the user narrates without naming a skill. Maps the problem to the skills and agents that apply, grills the ask, and cuts the work into milestones of shippable PRs in ship order, saved as roadmap.md and the pair ladder under $CLAUDE_CONFIG_DIR/state/work/<slug>/ with a decision log. Small questions and fixes take a one-line fast path instead.

  Use when: the user describes a problem, feature, investigation, or multi-step piece of work in their own words; asks "how should we approach X", "help me think through X", "plan this"; or runs `/brainstorm resume [slug]` to revisit, regroup or reorder a roadmap.
user-invocable: true
metadata:
  origin: local
---

# Brainstorm

Runs once per feature. Turn a narrated problem into an approved roadmap: milestones users can see, each made of PRs in ship order, which `pair` builds and ships one per chat. This skill owns the dialogue, the roadmap and the decision log; heavy reading goes to agents.

State lives in `$CLAUDE_CONFIG_DIR/state/work/<slug>/`, kept out of every repository, and goes through the script:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts <command>   # new | list | use | current | decide | handoff
```

## Fast path

If the request is a question, a lookup, or a small fix, print one line such as `→ direct` or `→ explain` and just do it: no roadmap, no grilling, no decision log.

## Full flow

1. **Listen.** Let the user narrate. Take only a quick look at what they point to (a ticket or issue, thread, PR, or error message). Run `work.ts list` and match the PR number, ticket key, issue number, or topic against existing slugs and titles; on a match, switch to Resume.
2. **Start the initiative.** `work.ts new <slug> --title "<title>"`, so the context bundle and every decision land in its directory from here on.
3. **Gather context.** Run the `gather-context` skill in the mode that fits what the user pointed to (`ticket`, `pr`, `incident`, or `topic` with the user's own words when they pointed to nothing), then again in `conventions` mode. The step is done when both bundles exist under `<initiative dir>/context/` and you have read their Summary, Code map and Open questions.
4. **Map.** In a few lines, name the skills and agents this problem needs (CLAUDE.md lists them with their roles).
5. **Grill the ask.** Start from what the bundles found and what they left open. Follow the `grilling` skill's question format (numbered questions, each with your recommended answer), adding `domain-modeling` when the answers should become glossary or ADR docs. Ask at least one "why" to catch an XY problem. Lay out the options, the unknowns, and what to check first.
6. **Cut the roadmap.** Apply the rules under "Cutting the roadmap" and discuss the cut with the user until it settles. Hand a sub-problem to its skill when it needs more depth than this chat should hold.
7. **Present.** Run the self-grill in `references/self-grill.md` on the roadmap, show it in the template below with the Grilled block, and ask the user to approve or edit it. On approval, run "After approval".

## Cutting the roadmap

- **Milestone**: something users can do when it is done. Milestones run in ship order too.
- **PR**: one deliverable and one draft PR, with a plain goal, an "After this you can ..." line, rough commits (a title and a one-line why each), and an estimate in days. Files, checks and line counts are planned by `pair` when that PR's turn comes.
- **Ship order**: the first PR (or group) is the smallest thing that goes live on its own; each later PR builds on the ones before it. Building, rebasing, QA and opening the PR all happen inside each PR's own `pair` run, so every roadmap item is a PR that ships.
- **Group**: PRs that must go live together but should stay reviewable separately. They form a stack whose top PR takes the whole group live (`merge_point: true`, as on every ungrouped PR); each one is still its own draft PR. Grouping is the user's call: propose it with the reason and log it.
- **No code**: an investigation or a decision lists its deliverables (a write-up, a decision) in place of PRs and skips tickets or issues, ladder and stack.

## After approval

1. **Tickets or issues**, every write shown and approved first. When Linear is connected, through the `ticket` skill: more than one PR gets a parent (the ticket the work came from, when there is one) and one child per PR, with `blockedBy` in ship order; one PR gets one ticket. Otherwise, when the user wants them, one GitHub issue per PR (`gh issue create`), linked to the issue the work came from when there is one. Without either, no ids anywhere.
2. **Branch names**: `br name` for each PR (`--ticket` when it has a Linear ticket), each confirmed by the user.
3. **Ladder**: write the PR list as JSON in the initiative directory, shaped per `$CLAUDE_CONFIG_DIR/skills/pair/references/ladder.md`, then run `bun $CLAUDE_CONFIG_DIR/skills/pair/scripts/pair.ts plan save <file>`. One slice per PR in ship order with `title`, `goal`, `after`, `branch`, `ticket` (optional: a Linear key or an issue number such as `#412`), `acs`, `merge_point`, `milestone`, `est_days`, and `commits` holding only `n`, `title` and `why`. `acs` are `AC-<n>` from the spec, or `<TICKET>/AC-<n>` from a Linear ticket; when none are written yet, run `spec` first.
4. **Roadmap**: write the same PR list into `roadmap.md` at the path `work.ts current` prints. It is the tracker everyone reads: `pair` keeps each PR's status and the "Next up" line current, and `handoff` and `work.ts` read them.
5. **Stack**: with more than one PR, set it up through the `branch` skill (`br stack`, dry run shown and approved first). The open-PR cap is optional: when the user wants draft PRs opened now (`--draft-prs`), pass `--cap <n>` only when they set one (`br` falls back to 5, so pass a number above the PR count when they want none).
6. Log the decisions from the discussion that are not yet in `decisions.md`.
7. End with one yes/no question: "Hand off to a fresh chat for PR 1, <name>?" On yes, run the `handoff` skill (its starter is `/pair plan <slug>`). On no, stop.

## Resume (`/brainstorm resume [slug]`)

1. With a slug, `work.ts use <slug>` and resume it without asking which. Without one, run `work.ts list`: if exactly one initiative matches this repo, name it and ask the user to confirm; if several match or none, list them with their "Next up" line and ask what the user is pointing to. Never guess.
2. Read `roadmap.md`, `decisions.md`, and `handoff.md` (if present) from the paths `work.ts current` prints. `decisions.md` is authoritative over anything you remember.
3. In a few plain sentences: the next PR, what has shipped, and the latest decisions.
4. When the plan still holds, end with one yes/no question: "Hand off to a fresh chat for PR <n>, <name>?" On yes, run the `handoff` skill (starter `/pair plan <slug>`, or `/pair implement <slug>` when that PR's plan is approved or half built). When scope changed, propose the regroup (split a group, merge two, move a PR) or reorder, and on approval log each change, re-save `roadmap.md` and the ladder, bring tickets or issues and the stack in line through `ticket` (or `gh issue edit`) and `branch`, and end with the same yes/no hand-off question.

## Decision log

Once the initiative exists, log each decision as it is made:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - --title "Storage for X" --options "Postgres | Redis" --chosen "Postgres" --why "Already in the stack" --by user
```

Log only decisions the user made or must know about (scope cuts, grouping, ship order trade-offs); skip mechanical ones. Use `--by claude` only when you proposed the choice and the user explicitly approved it. A logged decision is reopened only with new evidence.

## Roadmap template

Write for a reader who skims: plain sentences, one short section per PR, the next step first, no tables or internal terms. Say a group in words ("goes live together with PR 3").

```markdown
# <Feature name>

**Next up: PR <n>, <short name>.** Start it in a fresh chat with `/pair plan <slug>`.

## What we are doing and why
<2 to 4 plain sentences: who is waiting, what they cannot do today, what changes.>

Tracked in Linear under <parent>, or in GitHub issues. Each PR below has its own ticket or issue. (Omit without them.)

Context: `<context bundle path>`, conventions: `<conventions bundle path>`.

## Milestone 1: <what users can do when it is done>

**PR 1: <short name>** (<status: next | not started | plan approved | in progress, k of n commits | draft #NNNN | live>)
<1 to 3 sentences: what users can do after it goes live. Say when it cannot go live alone and which PR takes it live.>
Rough plan: <the rough commits in plain words, one short phrase each, separated by semicolons>.

**PR 2: ...**

## Milestone 2: ...

## Not in this plan
<plain list of parked work, one line each>

## Open questions
<only the ones the user must answer>
```
