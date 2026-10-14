# Claude Code Config (personal)

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) configuration for personal projects (`CLAUDE_CONFIG_DIR=~/.claude-personal`): a human-in-the-loop workflow where curated upstream skills supply domain expertise and thin local skills supply the workflow, scripts and integrations. The main thread orchestrates; agents do the heavy work.

## Structure

```
~/.claude-personal/
├── CLAUDE.md              # Working agreement: flow, orchestration, hard rules, skill catalog
├── settings.json          # Permissions, plugins, hooks, autoCompactWindow
├── statusline-command.sh  # Status line: context, cost, tokens, skills updates, pair progress
├── bin/                   # Deterministic scripts (bun, no deps)
│   ├── work.ts            # Initiative state: roadmap, decisions, handoff (state/work/<slug>/)
│   ├── gh-activity.ts     # Read-only GitHub: my activity, PR state, repo conventions, integration target
│   └── skills-audit.ts    # Third-party skill updates, clashes, refine queue
├── hooks/                 # Hard safety only, plus context re-injection
│   ├── db-guard.js        # Blocks any database access (CLIs, ORM migrate/push, DB scripts, DB MCP tools)
│   ├── deny-env-read.sh   # Blocks reading env files
│   └── post-compact.js    # Re-injects the active initiative and pair state after /compact
├── agents/                # builder, reviewer, tester, scout
├── skills/                # Local skills (real dirs, `metadata.origin: local`) + upstream symlinks into ~/.agents/skills
└── state/                 # Local working state (initiatives, context bundles, queues); not shared
```

## Workflow

`/brainstorm` → `/spec` → `/pair` (slices, planned commits, checkpoints) → `/ship` → `/done`, with `/ui`, `/qa`, `/debug`, `/scout`, `/review`, `/ticket` (Linear, when connected) and `/handoff` along the way. The full catalog is at the end of `CLAUDE.md`.

## Upstream skills

Installed with the `skills` CLI (`bunx skills add <repo> -g -s <skill>`) into `~/.agents/skills` and symlinked here; `/skills` reviews updates tracked by `bin/skills-audit.ts`.
