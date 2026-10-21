---
name: roadmap
description: |
  Turns a settled problem and proposal into an approved roadmap: milestones of deliverables in ship order (PRs, and the tests, debugging, QA runs or evidence the work needs), each mapped to the skill that produces it, with the ticket plan, the pair ladder, the stack order, the conventions bundle and a decision log under $CLAUDE_CONFIG_DIR/state/work/<slug>/. Reads problem.md and proposal.md from `brainstorm`.

  Use when: `brainstorm` ends with "Turn this into a roadmap?" and the user says yes; the user asks to "plan how to ship this", "cut the PRs", "make a roadmap"; or runs `/roadmap [slug]` or `/roadmap resume [slug]` to revisit, regroup or reorder a roadmap.
user-invocable: true
metadata:
  origin: local
---

# Roadmap

Runs once per initiative, after `brainstorm` settled what to build. Turn problem.md and proposal.md into an approved roadmap: milestones users can see, each made of deliverables in ship order. Code deliverables are PRs that `pair` builds and ships one per chat; every other deliverable (a test suite, a debugging write-up, a QA run, evidence for a ticket or issue) names the skill that produces it in its own chat. This skill owns the cut, the tickets, the ladder and the decision log; heavy reading goes to agents.

State lives in `$CLAUDE_CONFIG_DIR/state/work/<slug>/` and goes through the script:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts <command>   # new | list | use | current | decide | handoff
```

## Flow

1. **Find the initiative.** With a slug, `work.ts use <slug>`. Without one, run `work.ts list` and match the topic; never guess. When `roadmap.md` already exists, switch to Resume.
2. **Read the ideation.** Read `problem.md`, `proposal.md` and `decisions.md` in the initiative directory, and the Summary, Code map and Open questions of the context bundle under `<initiative dir>/context/`. `decisions.md` is authoritative. When there is no `proposal.md`, ask one question: run `/brainstorm` first, or, when the user already knows the solution, write `problem.md` and `proposal.md` from their words and have them confirm both. Create the initiative with `work.ts new <slug> --title "<title>"` when none exists.
3. **Gather conventions.** Run the `gather-context` skill in `conventions` mode. Done when `conventions.md` exists under `<initiative dir>/context/` and you have read it. When there is no source bundle yet, run `gather-context` in the mode that fits first.
4. **Map.** In a few lines, name the deliverables the proposal needs and the skill or agent that produces each (CLAUDE.md lists them with their roles).
5. **Grill the delivery.** Follow the `grilling` skill's question format (numbered questions, each with your recommended answer) on what the proposal leaves open about shipping: what can go live first, what must go live together, who is waiting, what each deliverable needs before it starts.
6. **Cut.** Apply the rules under "Cutting the roadmap" and discuss the cut with the user until it settles.
7. **Present.** Run the self-grill in `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md` on the roadmap, show it in the template below with the Grilled block and the ticket plan, and ask the user to approve or edit both. On approval, run "After approval".

## Cutting the roadmap

- **Milestone**: something users can do when it is done. Milestones run in ship order too.
- **PR**: one code deliverable and one draft PR, with a plain goal, an "After this you can ..." line, rough commits (a title and a one-line why each), and an estimate in days. Files, checks and line counts are planned by `pair` when that PR's turn comes.
- **Other deliverables**: tests on code already shipped (`qa`, `tdd`), a root cause (`debug`), a QA run or handoff guide (`qa`), evidence or a ticket or issue close-out (`done`), a review (`review`), research (`scout`). Each gets a plain goal, its skill, and its place in the order. Tests and QA that belong to a PR stay inside that PR's `pair` checkpoint; list them separately only when they are their own deliverable.
- **Ship order**: the first item (or group) is the smallest thing that goes live or lands on its own; each later item builds on the ones before it. Building, rebasing, QA and opening the PR all happen inside each PR's own `pair` run.
- **Group**: PRs that must go live together but should stay reviewable separately. They form a stack whose top PR takes the whole group live (`merge_point: true`, as on every ungrouped PR); each one is still its own draft PR. Grouping is the user's call: propose it with the reason and log it.
- **No code**: a roadmap with no PRs (an investigation, a decision, a QA sweep) skips the ladder and the stack.
- **Ticket plan** (when Linear is connected): each PR, and each other deliverable that someone tracks, either uses an existing ticket or gets a new one, and the plan names the parent. Find existing tickets in the context bundle's Linear findings; when the bundle has none for an item, search Linear (`list_issues` by the item's subject, at most 2 queries). An item uses an existing ticket only when that ticket asks for the same deliverable; one that only overlaps is linked as related.

## After approval

1. **Tickets or issues**, every write shown and approved first. When Linear is connected, through the `ticket` skill, following the approved ticket plan (create only the new tickets and link the existing ones as the plan says): more than one item gets a parent (the ticket the work came from, when there is one) and one child per item, with `blockedBy` in ship order; one item gets one ticket. Otherwise, when the user wants them, one GitHub issue per item (`gh issue create`), linked to the issue the work came from when there is one. Without either, no ids anywhere.
2. **Branch names**: named by the branching rule in CLAUDE.md for each PR (the Linear ticket's `gitBranchName` only when it has a Linear ticket), each confirmed by the user.
3. **Ladder** (PRs only): write the PR list as JSON in the initiative directory, shaped per `$CLAUDE_CONFIG_DIR/skills/pair/references/ladder.md`, then run `bun $CLAUDE_CONFIG_DIR/skills/pair/scripts/pair.ts plan save <file>`. One slice per PR in ship order with `title`, `goal`, `after`, `branch`, `ticket` (optional), `acs`, `merge_point`, `milestone`, `est_days`, and `commits` holding only `n`, `title` and `why`. `acs` are `AC-<n>` or `<TICKET>/AC-<n>` from the tickets or the spec; when none are written yet, run `spec` first.
4. **Roadmap**: write every item into `roadmap.md` in the initiative directory (`work.ts current` prints the directory). It is the tracker everyone reads: `pair` keeps each PR's status and the "Next up" line current, the other deliverables' skills update their own status lines, and `handoff` and `work.ts` read them. `pair` points the "Next up" line at the next unshipped PR after every PR change, so a non-code item that runs before that PR is carried by its own status line and the handoff note.
5. **Stack**: with more than one PR, the ladder records the order and `ship` builds the gh stack layer by layer as each PR ships, with no up-front stack. Each PR is a self-contained layer (see `pair/references/ladder.md`).
6. Log the decisions from the discussion that are not yet in `decisions.md`.
7. End with one yes/no question: "Hand off to a fresh chat for <first item>?" On yes, run the `handoff` skill (its starter is `/pair plan <slug>` for a PR, or the item's skill for anything else). On no, stop.

## Resume (`/roadmap resume [slug]`)

1. With a slug, `work.ts use <slug>` and resume it without asking which. Without one, run `work.ts list`: if exactly one initiative matches this repo, name it and ask the user to confirm; if several match or none, list them with their "Next up" line and ask what the user is pointing to. Never guess.
2. Read `roadmap.md`, `decisions.md`, `proposal.md` and `handoff.md` (if present) from the initiative directory. `decisions.md` is authoritative over anything you remember.
3. In a few plain sentences: the next item, what has shipped, and the latest decisions.
4. When the plan still holds, end with one yes/no question: "Hand off to a fresh chat for <next item>?" On yes, run the `handoff` skill (starter `/pair plan <slug>`, `/pair implement <slug>` when that PR's plan is approved or half built, or the item's skill). When scope changed, propose the regroup (split a group, merge two, move an item) or reorder, and on approval log each change, re-save `roadmap.md` and the ladder, bring tickets or issues and the stack in line through `ticket` (or `gh issue edit`) and `ship`, and end with the same yes/no hand-off question. When the solution itself changed, offer `/brainstorm resume <slug>` first.

## Decision log

Log each decision as it is made:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - --title "Ship order for X" --options "Read path first | Write path first" --chosen "Read path first" --why "Goes live alone" --by user
```

Log only decisions the user made or must know about (scope cuts, grouping, ship order trade-offs); skip mechanical ones. Use `--by claude` only when you proposed the choice and the user explicitly approved it. A logged decision is reopened only with new evidence.

## Roadmap template

Write for a reader who skims: plain sentences, one short section per item, the next step first, no tables or internal terms. Say a group in words ("goes live together with PR 3"). PR headings keep the exact `**PR <n>: <name>** (<status>)` shape, which `pair` rewrites.

```markdown
# <Feature name>

**Next up: PR <n>, <short name>.** Start it in a fresh chat with `/pair plan <slug>`.

## What we are doing and why
<2 to 4 plain sentences from proposal.md: who is waiting, what they cannot do today, what changes.>

Tracked in Linear under <parent>, or in GitHub issues. Each item below has its own ticket or issue. (Omit without them.)

Context: `<context bundle path>`, conventions: `<conventions bundle path>`, proposal: `<proposal.md path>`.

## Milestone 1: <what users can do when it is done>

**PR 1: <short name>** (<status: next | not started | plan approved | in progress, k of n commits | draft #NNNN | live>)
Ticket: <AI-123 or #123 (existing) | new>. (Omit without them.)
<1 to 3 sentences: what users can do after it goes live. Say when it cannot go live alone and which PR takes it live.>
Rough plan: <the rough commits in plain words, one short phrase each, separated by semicolons>.

**<Deliverable>: <short name>** (<status: next | not started | in progress | done>)
Skill: `/<skill> <args>`. <1 to 2 sentences: what it produces and who uses it.>

**PR 2: ...**

## Milestone 2: ...

## Not in this plan
<plain list of parked work, one line each>

## Open questions
<only the ones the user must answer>
```
