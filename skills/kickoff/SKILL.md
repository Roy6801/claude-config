---
name: kickoff
description: Plan a piece of work into a roadmap (context, problem, HLD, milestones, PRs) under ~/roadmaps, as a discussion with the user.
disable-model-invocation: true
metadata:
  origin: local
---

# Kickoff

- Runs in a fresh chat.
- Turns a piece of work into an agreed roadmap in `~/roadmaps/<project>/<slug>/`.
- Slug: a short kebab-case name the user confirms.
- A discussion in chat: research, a short outline, the open decisions settled one at a time, then a save on the user's yes.
- Messages to the user fit one screen and lead with what to look at.

## PR sizing

- A PR whose planned work is clearly over ~200 lines (CLAUDE.md) goes under `## Size decisions`: split points, size of each piece, two options (independent PRs, stacked PRs, the stack's layers designed per the `gh-stack` skill's `references/stack-design.md`), a recommendation. The user decides each one.
- Each PR has one independent scope, is built from atomic commits, and has a stable kebab-case name.
- Linear tickets found in context attach to their PRs, and a parent ticket is recorded in `roadmap.md`. New PR tickets are created by `ship` at Start.
- Each PR gets a record in `roadmap.md`: name, branch, base or stack parent, ticket when known, status (the roadmap states in `references/templates.md`).

## HLD

- The high-level design: an outline of the whole change, grounded in the real code. Each PR's plan in `/pickup` adds the detail.
- Pick the variant by the kind of work and write it per `references/hld.md`: code work (feature, fix, refactor) or other work (investigation, data or pipeline, infra or config, docs, QA).

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run this session as chief of staff.
- Wiki: the roadmap folder's `wiki/`.
- Every subagent is fresh and runs in the background, writes its output into the roadmap folder itself, and returns at most 150 words.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - Confirm the slug with the user.
   - In one message, ask the user for the deadline, the constraints and the scope (in and out). Research waits for the answer.
   - `general-purpose · haiku · low`: read the project from the origin remote; create the folder, `roadmap.md` (title, `**Next:**` line) and `wiki/index.md`; write the deadline, constraints and scope as a dated wiki page.
2. **Context** (parallel)
   - `general-purpose · sonnet · medium`, `gather-context <ticket|pr|topic> <focus>` → `research/context.md`.
   - `general-purpose · sonnet · medium`: the code areas the work touches, within the agreed scope → `research/code.md`.
   - Gate: both research files exist.
3. **Outline** (after context)
   - `general-purpose · opus · high`: read `wiki/index.md`, `research/` and the code it points to; write `outline.md` per `references/templates.md`, sized against the code and fitted to the deadline.
   - Present the outline in chat: the problem, the approach, the PR list with a rough size per PR, the open decisions.
4. **Discuss** (sequential)
   - Settle the open decisions and size decisions one at a time per CLAUDE.md (at least two options, trade-offs, a recommendation).
   - After each answer or correction, record it in `outline.md` (decisions dated, under the decision).
   - When a question turns on a fact neither `research/` nor the code search covers, dispatch one agent for that gap: `general-purpose · sonnet · medium` for code → `research/code-<topic>.md`; `general-purpose · sonnet · high`, `gather-context research "<question>"` for a library, framework or service → `research/research-<library>.md`.
   - Detail beyond the outline only when the user asks to dig in.
   - Gate: every open decision and size decision settled; the user says yes to the outline in chat.
5. **Save** (after the yes)
   - `general-purpose · sonnet · high`: from `outline.md`, `research/` and the code, write `roadmap.md` and `hld.md` per `references/templates.md`, the HLD per `references/hld.md`, every PR's status `planned` and the Next line "Plan <first pr-name> with /pickup <slug>"; list every source in `sources.md`; write one dated wiki page per settled decision, listed in `wiki/index.md`; delete `outline.md`. Return the gate check and anything in the outline the code contradicted.
   - Gate: `roadmap.md` holds the Next line, the parent ticket when one exists, and every PR's record with status `planned`; `hld.md` exists; `wiki/index.md` lists every decision. A contradiction with the code goes to the user before End.
6. **End** (sequential)
   - Tell the user: "Roadmap saved. Next: `/handoff`."
