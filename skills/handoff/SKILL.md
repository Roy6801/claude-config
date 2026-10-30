---
name: handoff
description: Save where the work stands into its roadmap folder and copy `/pickup <slug>` for a fresh chat.
disable-model-invocation: true
metadata:
  origin: local
---

# Handoff

- Carries a roadmap across a chat reset; `/pickup <slug>` in the fresh chat continues from it.
- This roadmap: `~/roadmaps/<project>/<slug>/` (CLAUDE.md); slug is the roadmap this session worked on.
- State lives there: `roadmap.md`, `wiki/`, `prs/`.

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and act as chief of staff.
- Every subagent is fresh, writes into the roadmap folder, and returns at most 150 words.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - Resolve the roadmap folder from the project and slug; ask the user for the slug when this session did not work on one.
   - Read its `roadmap.md`, `handoff.md` and `wiki/index.md`.
2. **Record** (sequential)
   - List what this session learned that the folder lacks: decisions, user corrections, findings, PR status changes, the next step.
   - `general-purpose · sonnet · medium`: ingest the decisions, corrections and findings into the wiki (dated pages citing their sources, listed in `wiki/index.md`); update the PR statuses and the `**Next:**` line in `roadmap.md`.
   - Gate: every listed item is in the wiki or `roadmap.md`.
3. **Note** (sequential)
   - Rewrite `handoff.md`, the roadmap's only note, at most 20 lines of bullets: where things stand, what is half-done (for a PR mid-ship, the last ship step passed), the next action, open questions, and paths to read. Point at files; leave goal, PR list and decisions to `roadmap.md` and the wiki.
4. **End** (sequential)
   - Copy `/pickup <slug>` with `pbcopy`.
   - Get the terminal line from `bun $CLAUDE_CONFIG_DIR/bin/launch.ts start "/pickup <slug>"`.
   - Tell the user: "Copied `/pickup <slug>`. Clear the chat and paste." Then, on its own line: "From a terminal: `<terminal line>`".
