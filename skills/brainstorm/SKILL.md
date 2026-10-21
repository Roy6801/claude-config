---
name: brainstorm
description: |
  Front door for any non-trivial request the user narrates without naming a skill. Ideation only: understands the problem, grills the ask, explores ideas in plain prose with the user, and settles a proposal, saved as problem.md, ideas.md, proposal.md and a decision log under $CLAUDE_CONFIG_DIR/state/work/<slug>/. Never cuts PRs, milestones, tickets or a ship order; it ends by offering `/roadmap`. Small questions and fixes take a one-line fast path instead.

  Use when: the user describes a problem, feature, investigation, or multi-step piece of work in their own words; asks "how should we approach X", "help me think through X", "explore how to solve X"; or runs `/brainstorm resume [slug]` to pick up an ideation.
user-invocable: true
metadata:
  origin: local
---

# Brainstorm

Runs once per initiative, before `roadmap`. Turn a narrated problem into a proposal the user agrees with: what goes wrong, for whom, and how we solve it. How to ship it (PRs, milestones, ship order, tickets, branches) belongs to `roadmap` and never comes up here, not even as a "PR 1" or a shipping question. This skill owns the dialogue, the ideation files and the decision log; heavy reading goes to agents.

State lives in `$CLAUDE_CONFIG_DIR/state/work/<slug>/`, kept out of every repository, and goes through the script:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts <command>   # new | list | use | current | decide | handoff
```

## Fast path

If the request is a question, a lookup, or a small fix, print one line such as `→ direct` or `→ explain` and just do it: no initiative, no grilling, no decision log.

## Files

All in the initiative directory (`work.ts current` prints it):

- `problem.md`: the problem in the user's words. Who is affected, what goes wrong for them today, the ground truth the user stated (facts, constraints, data they confirmed), and what is out of scope. Rewritten as understanding improves.
- `ideas.md`: the discussion, appended to and never rewritten. Each round adds the questions asked and the answers, and each idea as it comes up; an idea the user drops stays with a line saying why. Ideas add up: a later idea can build on an earlier one instead of replacing it.
- `proposal.md`: written once the user settles on a direction. The chosen solution in plain prose: what changes for whom, the ideas it combines, what it leaves out, and the questions still open. `roadmap` reads it.

## Flow

1. **Listen.** Let the user narrate. Take only a quick look at what they point to (a ticket or issue, thread, PR, or error message). Run `work.ts list` and match the PR number, ticket key, issue number, or topic against existing slugs and titles; on a match, switch to Resume.
2. **Start the initiative.** `work.ts new <slug> --title "<title>"`, then write the first `problem.md` from what the user said.
3. **Gather context.** Run the `gather-context` skill in the mode that fits what the user pointed to (`ticket`, `pr`, `incident`, or `topic` with the user's own words when they pointed to nothing). The step is done when the bundle exists under `<initiative dir>/context/` and you have read its Summary, Code map and Open questions. Code evidence (file:line, symbols) stays in the bundle; the conversation uses plain words.
4. **Grill the ask.** Start from what the bundle found and left open. Follow the `grilling` skill's question format (numbered questions, each with your recommended answer), adding `domain-modeling` when the answers should become glossary or ADR docs. Ask at least one "why" to catch an XY problem. Questions shape the solution (the outcome, the constraints, the data available), never the delivery.
5. **Discovery questions.** When an answer can only come from someone else, group those questions by the person who can answer them, at most 3 or 4 per person, and keep only the ones whose answer would change the ideas. First ask the user which of them they already know the answers to. Offer the rest as a numbered pick list for the user to take to those people; never send them yourself.
6. **Explore ideas.** Run the self-grill in `references/self-grill.md` on the ideas, then present them in the ideas template below. Discuss with the user, append each round to `ideas.md`, and update `problem.md` when the ground truth changes. Hand a sub-problem to its skill (`scout` for outside research, `debug` for a root cause, `prototype` to try an idea) when it needs more depth than this chat should hold.
7. **Propose.** When the user settles on a direction, write `proposal.md`, show it, and ask for approval or edits. Log the decisions from the discussion that are not yet in `decisions.md`.
8. End with one yes/no question: "Turn this into a roadmap?" On yes, run `/roadmap <slug>` in this chat, or hand off with the `handoff` skill (starter `/roadmap <slug>`) when the context is long. On no, stop.

## Ideas template

Plain prose for a reader who skims: one short section per idea, no file:line, symbols, internal terms or tables unless the user asks for them.

```markdown
## <Idea in a few plain words>

**Who:** <the person or role it helps>.
**What goes wrong today:** <1 to 2 sentences>.
**The idea:** <2 to 4 sentences: what changes, and what it builds on when it adds to an earlier idea>.
**Example:** <one concrete case, such as a real item, page or request, before and after>.
```

After the sections, give your recommendation in a few sentences and the Grilled block.

## Resume (`/brainstorm resume [slug]`)

1. With a slug, `work.ts use <slug>` and resume it without asking which. Without one, run `work.ts list`: if exactly one initiative matches this repo, name it and ask the user to confirm; if several match or none, list them and ask what the user is pointing to. Never guess.
2. Read `problem.md`, `ideas.md`, `proposal.md`, `decisions.md` and `handoff.md`, whichever exist, from the initiative directory. Older initiatives may have only `roadmap.md` and `decisions.md`; read those instead. `decisions.md` is authoritative over anything you remember.
3. In a few plain sentences: the problem, where the ideas stand, and the latest decisions.
4. Continue from the step the files show. When a proposal is approved and the user only wants to change how it ships, offer `/roadmap resume <slug>` instead.

## Decision log

Once the initiative exists, log each decision as it is made:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - --title "Where X is checked" --options "On save | On publish" --chosen "On publish" --why "Saves never block" --by user
```

Log only decisions the user made or must know about (the chosen direction, ideas dropped, scope cuts); skip mechanical ones. Use `--by claude` only when you proposed the choice and the user explicitly approved it. A logged decision is reopened only with new evidence.
