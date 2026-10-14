---
name: handoff
description: |
  Reset context without losing the thread. Decides between handing off to a fresh session and compacting in place, makes sure the decision log is current, writes a short handoff note under $CLAUDE_CONFIG_DIR/state/work/<slug>/, and copies the exact starter (the workspace's launch command with `"/brainstorm resume <slug>"`, or `/compact <focus>`) to the clipboard.

  Use when: a roadmap was just approved and implementation is next, a slice shipped and the next one starts, the context is long mid-discussion or mid-debug, or the user says "hand off", "fresh session", "compact", "context is getting long". Also invoked by brainstorm after roadmap approval.
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

| Situation | Move | Why |
|---|---|---|
| Plan or roadmap just approved, implementation next | Hand off (fresh session) | Implementation works best from a clean context that holds only the plan |
| A slice shipped and the next slice starts | Hand off | Slices are self-contained and the state lives in files |
| Long discussion mid-flow (brainstorm, spec grilling) | Compact with a focus line | The decisions and nuance are too costly to re-explain |
| Mid-debug with lots of evidence | Compact ("keep hypotheses, evidence, ruled-out causes") | Starting over would repeat the investigation |
| Switching to an unrelated task | New session, no handoff | There is nothing to carry |

State the move and the reason in one line before acting. If the situation is ambiguous, recommend one and ask.

## 3. Log open decisions first

Read `decisions.md`. For every decision made in this session that is not logged yet, run:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - --title "<decision>" --options "a | b" --chosen "a" --why "<reason>" --by user
```

Update the roadmap statuses too (`work.ts step - <n> done`, `work.ts step - <n+1> active`) so the current step is correct.

## 4a. Hand off

Draft the note in the scratchpad directory (never in a repository), at most 40 lines, with these sections:

```markdown
# Handoff: <title> (<slug>)

## Goal
<one or two sentences>

## Where we are
<current step from the roadmap, and what is half-done>

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

Use pointers, not pasted content: list paths and line ranges instead of copying code or long excerpts. Then run:

```bash
bun $CLAUDE_CONFIG_DIR/bin/work.ts handoff - --file <path-to-draft.md>
```

This archives the previous `handoff.md`, writes the new one, and copies `<launch> "/brainstorm resume <slug>"` to the clipboard, where `<launch>` comes from `bin/launch.ts`: the user's alias for this workspace with `-d`, or the full `CLAUDE_CONFIG_DIR=… claude --dangerously-skip-permissions` command when no alias exists. It also prints an in-session line, `resume "<slug>" · workspace: <ws> (<dir>)`. When a later skill owns the next step, pass `--resume "<slash command>"` to change what the new session runs.

Tell the user both lines exactly as printed: "Copied for a new terminal: `<starter>`. In any open session, paste: `<in-session line>`."

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
