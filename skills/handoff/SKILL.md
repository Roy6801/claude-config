---
name: handoff
description: |
  Reset context without losing the thread. Decides between handing off to a fresh session and compacting in place, makes sure the decision log is current, writes a short handoff note under $CLAUDE_CONFIG_DIR/state/work/<slug>/, and copies the skill command to start with (`/pair plan <slug>`, `/pair implement <slug>`, `/brainstorm resume <slug>` or `/compact <focus>`) to the clipboard; the terminal launch line and the in-session line are shown in chat.

  Use when: a roadmap was just approved, a PR plan was approved to build in a fresh chat, a PR is half built, a PR shipped and the next one starts, the context is long mid-discussion or mid-debug, or the user says "hand off", "fresh session", "compact", "context is getting long". Also invoked by brainstorm after roadmap approval.
user-invocable: true
metadata:
  origin: local
---

# Handoff

Carry an initiative across a context reset. The files under `$CLAUDE_CONFIG_DIR/state/work/<slug>/` hold the state; the handoff note only points at them.

Script: `bun $CLAUDE_CONFIG_DIR/bin/work.ts <command>`. Use `-` as the slug to mean the initiative active for the current directory.

## 1. Find the initiative

Run `bun $CLAUDE_CONFIG_DIR/bin/work.ts current`. If nothing is active and the work deserves carrying over, run `work.ts list` and `work.ts use <slug>`, or create one with `work.ts new <slug> --title "<title>"`. If the user is switching to an unrelated task, there is nothing to carry: tell them to start a new session and stop here.

## 2. Choose the move

First decide what is being carried. The roadmap is the tracker: read `roadmap.md` (its "Next up" line and each PR's status) and offer the carry-over that matches; the user confirms or picks another:

- **Brainstorm**: the roadmap discussion is unfinished, or the roadmap needs regrouping. Starter: `/brainstorm resume <slug>`.
- **Pair plan**: a PR's plan is approved but nothing is built. Starter: `/pair implement <slug>`. The note points to the plan file pair saved (`pr-<n>-plan.md` in the initiative directory); it never copies it.
- **Pair implementation**: a PR is half built, or shipped with fixes still open. Starter: `/pair implement <slug>`, which continues that same PR from its plan file.
- **Next PR**: the last PR shipped and the next one is ready to plan. Starter: `/pair plan <slug>`.

Every carry-over is a hand-off to a fresh session. The note is written in the initiative directory with the same slug, so the in-session line is always `resume "<slug>"` and the new session picks the starter from the state.

Compact instead of handing off only in two cases: a long discussion mid-flow (compact with a focus line, since the nuance is costly to re-explain), and mid-debug with lots of evidence (compact with "keep hypotheses, evidence, ruled-out causes"). When the user switches to an unrelated task there is nothing to carry: tell them to start a new session and stop.

State the move and the reason in one line before acting. If the situation is ambiguous, recommend one and ask.

## 3. Log open decisions first

Read `decisions.md`. For every decision made in this session that is not logged yet, run:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - --title "<decision>" --options "a | b" --chosen "a" --why "<reason>" --by user
```

Check that the roadmap's statuses and its "Next up" line are current; pair keeps them, and `bun $CLAUDE_CONFIG_DIR/skills/pair/scripts/pair.ts roadmap sync --slug <slug>` refreshes them. Older roadmaps with a Steps table use `work.ts step - <n> done`.

## 4a. Hand off

Draft the note in the scratchpad directory (never in a repository), at most 40 lines. Notes and everything shown to the user are plain sentences, one short section per item, the next step first, with no wide tables and no internal terms. Sections:

```markdown
# Handoff: <title> (<slug>)

## Goal
<one or two sentences>

## Where we are
<the roadmap's next PR and its status, and what is half-done>

## Decisions
See decisions.md (authoritative). Most important:
1. …
2. …
3. …

## Next action
<the single concrete thing the next session does first>

## Open questions
- …

## Files to read
- <absolute paths: roadmap.md, decisions.md, spec or code files>
```

When the initiative has a roadmap and a pair ladder, the note points to the roadmap's next PR and holds only what the roadmap does not already say (a half-done detail, a fresh decision, an open question); it does not restate the goal, the PR list or the decisions. Without a roadmap, use the sections above.

Use pointers, not pasted content: list paths and line ranges instead of copying code or long excerpts. Then run:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts handoff - --file <path-to-draft.md>
```

This archives the previous `handoff.md`, writes the new one, and copies the skill command (default `/brainstorm resume <slug>`) to the clipboard. It also prints two alternatives to show in chat, not copied: the terminal line `<launch> "<command>"`, where `<launch>` comes from `bin/launch.ts` (the user's alias for this workspace with `-d`, or the full `CLAUDE_CONFIG_DIR=… claude --dangerously-skip-permissions` command when no alias exists), and the in-session line `resume "<slug>" · workspace: <ws> (<dir>)`. For work with a roadmap and pair ladder, pass `--resume "/pair plan <slug>"` (or `--resume "/pair implement <slug>"` when a PR's plan is approved or it is half built) so the starter opens a fresh chat on that PR, never `/brainstorm resume`. Other skills that own the next step pass their own `--resume "<slash command>"`.

Tell the user exactly as printed: "Copied `<command>`. Paste it in a fresh chat." Then, on their own lines, the alternatives: "From a terminal: `<terminal line>`" and "In an open session: `<in-session line>`".

## 4b. Compact

Write one focus line that names what must survive the compaction (for example "keep the three storage options, the rejected Redis rationale, and the open auth question"). Then run:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts handoff - --mode compact --focus "<focus line>"
```

This copies `/compact <focus line>` to the clipboard. Tell the user: "Copied. Paste it here to compact." After compaction, the post-compact hook injects the initiative's paths, so read `roadmap.md` and `decisions.md` again before continuing.

## Rules

- `decisions.md` is the source of truth. Never put a decision only in the handoff note.
- If `pbcopy` is unavailable, the script prints the starter instead; show it to the user to copy by hand.
- Never paste secrets, `.env` content, or tokens into the note.
