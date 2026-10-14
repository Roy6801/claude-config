---
name: brainstorm
description: |
  Front door for any non-trivial request the user narrates without naming a skill. Maps the problem to the workflows, skills, and agents that apply, breaks it into sub-problems, brainstorms options and unknowns with light grilling, and produces an approved roadmap saved under $CLAUDE_CONFIG_DIR/state/work/<slug>/ with a running decision log. Small questions and fixes take a one-line fast path instead.

  Use when: the user describes a problem, feature, investigation, or multi-step piece of work in their own words; asks "how should we approach X", "help me think through X", "plan this"; or runs `/brainstorm resume [slug]` to continue an initiative.
user-invocable: true
metadata:
  origin: local
---

# Brainstorm

Turn a narrated problem into an agreed roadmap, then hand each step to the workflow that owns it. This skill owns the dialogue, the plan, and the decision log. It does not do the deep work itself.

State lives in `$CLAUDE_CONFIG_DIR/state/work/<slug>/` and is managed only through the script:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts <command>   # new | list | use | current | decide | step | handoff
```

## Fast path

If the request is a question, a lookup, or a small fix, print one line such as `→ direct` or `→ explain` and just do it. Do not create a roadmap, do not grill, and do not log decisions.

## Resume (`/brainstorm resume [slug]`)

1. With a slug, run `work.ts use <slug>`. Without one, run `work.ts current`; if nothing is active, run `work.ts list` and ask which initiative to resume.
2. Read `roadmap.md`, `decisions.md`, and `handoff.md` (if present) from the paths that `work.ts current` prints.
3. Summarize where we are in five lines or fewer: the goal, the current step, the last decisions, and the next action.
4. Continue at the active step. Treat `decisions.md` as authoritative over anything you remember.

## Full flow

1. **Listen.** Let the user narrate. Take only a quick look at what they point to (a ticket, thread, PR, or error message). Deep context gathering belongs to the workflow chosen later, and heavy reading goes to agents so the main thread keeps the dialogue and decisions.
2. **Map.** Lay out, in a few lines, which workflows, skills, and agents from the routing table apply to this problem.
3. **Break down.** Split the problem into small sub-problems. For each, name the workflow that handles it and the order in which they run.
4. **Brainstorm.** List the options, what to check first, the unknowns, and your own uncertainties. Grill lightly: read `$CLAUDE_CONFIG_DIR/skills/grilling/SKILL.md` and follow its question format (numbered questions, each with your recommended answer). Ask at least one "why" question to catch an XY problem, where the user asks for Y but the underlying problem is X.
5. **Discuss and iterate.** Revise the breakdown with the user. Hand a sub-problem to its skill when it needs more depth than this conversation should hold (see the routing table). Log each decision as it is made, not at the end:
   ```bash
   bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - --title "Storage for X" --options "Postgres | Redis" --chosen "Postgres" --why "Already in the stack" --by user
   ```
   Use `--by claude` only when you proposed the choice and the user explicitly approved it.
6. **Present the plan.** Show the roadmap using the template below and ask the user to approve or edit it. After approval:
   - Run `work.ts new <slug> --title "<title>"` (or `work.ts use <slug>` if it already exists), then write the approved roadmap into the printed `roadmap.md`, keeping the Steps table format so `work.ts step` can update it.
   - Log any decisions from the discussion that are not yet in `decisions.md`.
   - Mark step 1 active with `work.ts step - 1 active` and start it, or offer a handoff first (below).
7. **Offer a handoff.** Once the roadmap is approved and implementation is next, offer the `handoff` skill so implementation starts in a fresh session that holds only the plan.

As steps finish, update their status with `work.ts step - <n> done` and mark the next one `active`. If a step turns out to be unnecessary, mark it `skipped` and log why with `work.ts decide`.

## Routing table

| Workflow | Skills / agents | Notes |
|---|---|---|
| Requirements and acceptance criteria | spec (+ context, scout, grill-with-docs) | ACs in the local spec, optionally the Linear ticket or a GitHub issue; longer `prd` spec for 5+ PRs |
| Plan and build | pair (+ builder), branch | Slice ladder, planned atomic commits, slice checkpoints; `br` for branches and stacks |
| UI design | ui (impeccable, web-design-guidelines, figma) | Design, critique, polish, browser verify |
| QA | qa (+ tester) | ACs first, then code paths; repro ≥2× or "uncertain" |
| Debug | debug (+ scout, gather-context incident) | Wraps diagnosing-bugs |
| Research | scout (+ scout agent) | Requirements, debug, best-practices, library briefs |
| Review | review (+ reviewer, thermo, explain, post-pr-comments) | Scopes: slice, self, feedback, others |
| Ship and close | ship, done, ticket | Draft PRs only; evidence, ticket or issue close-out, follow-ups |
| Setup upkeep | skills, skill-retro | Third-party skill updates, refine queue |
| Context resets | handoff | Hand off vs compact |

To stress-test the plan, read and follow `$CLAUDE_CONFIG_DIR/skills/grill-me/SKILL.md` (or `grill-with-docs/SKILL.md` when the answers should become glossary/ADR docs). They can't be invoked as skills by Claude, so follow their instructions directly.

Before showing the roadmap or any recommendation, run the self-grill checklist in `references/self-grill.md` on it and show the resulting Grilled block with it.

## Roadmap template

```markdown
# <Title>
Slug: <slug> · Created: <date> · Source: <ticket/thread/user narration>

## Problem
<2–4 sentences: what the user asked (Y) and the underlying problem (X)>

## Sub-problems
1. <sub-problem> → <workflow>

## Steps
| # | Step | Skill / agents | Produces | User involvement | Effort | Status |
|---|------|----------------|----------|------------------|--------|--------|
| 1 | <step> | <skill> | <artifact> | <what the user does> | S/M/L | todo |

## Fresh-session points
- after step N: <why>

## Risks / open questions
- …
```

## Rules

- Write plans, roadmaps, and questions in full, clear sentences. Terse notes are fine for your own scratch work, never for what the user approves.
- Never touch a database. If a step needs data, write a data request for the user to run.
- Keep state out of repositories and `.git`. Everything goes through `work.ts` into `$CLAUDE_CONFIG_DIR/state/work/`.
- The roadmap is a plan, not a contract. When reality changes it, propose the edit, get approval, update `roadmap.md`, and log the decision.
