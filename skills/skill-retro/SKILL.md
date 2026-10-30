---
name: skill-retro
description: |
  Retrospective on the agent environment (skills, agents, CLAUDE.md, hooks, status line) for a session. Finds where they failed or got in the way, backed by quoted transcript moments, and queues approved findings for the `/skills` refine step.

  Use when: end of a session with friction from skills/agents/CLAUDE.md, or user says retro on skills/config.
metadata:
  origin: local
---

# skill-retro

Scope: the agent environment only, not repo code standards.

## 1. Read the session

Current conversation by default; if the user names a past session, read that transcript instead. Look for friction moments.

## 2. Categories

- A skill/agent ignored when it should have fired
- One that fired when it shouldn't have
- Guidance that was wrong or stale
- Links to skills, agents or tools that don't exist
- A missing skill
- A CLAUDE.md instruction that changed nothing (or was contradicted)
- An expensive or misused tool path

## 3. List candidates

Ordered by severity. Each candidate:

- **Target**: a skill name, agent name, `CLAUDE.md`, `statusline`, or `hook:<file>`
- **Category** from above
- **Evidence**: quote the transcript moment (user correction, wrong tool call, retry). No evidence, no candidate.
- **Note**: concrete fix, max 200 chars

No session IDs or transcript paths in notes or quotes beyond the short quote itself.

## 4. Approval gate

Present the list and ask which to queue. Queue nothing without approval.

## 5. Queue

Per approved candidate:

```bash
bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts refine add <name> "<note>"
```

Never edit the queue JSON by hand. Report the ids. Remind: `/skills` works the queue.
