---
name: gather-context
description: Read-only, cited context on a ticket, PR, person, time window, incident, topic, repo conventions, or a library, framework or service question. Use when another skill needs background, or asked "get context on AI-615", "what happened on PR #4226", "what did I do yesterday", "what's going on with X", "this repo's conventions", "how does library X behave".
user-invocable: true
metadata:
  origin: local
---

# Gather context

Collect what is known about one focus, from every source that applies, into one cited bundle file. The bundle holds pointers and short summaries, never pasted dumps.

Read-only: the only files written are source files and the bundle.

## Focus modes

| Mode | Argument | Default sources | Gated sources |
|---|---|---|---|
| `ticket` | Linear key, e.g. `AI-615` | Linear, GitHub, Slack | Code (repo work), Notion (ticket links a doc), Wispr (decision without written rationale), Braintrust (AI work) |
| `pr` | number, URL, or branch | GitHub, Linear (ticket key found), Slack | Code, Notion, Wispr, Braintrust, as for `ticket` |
| `person` | a name, or `me` | Slack, Linear, GitHub | Wispr (shared meetings in the window) |
| `window` | `<since> [until]`: `today`, `yesterday`, `<n>d`, `YYYY-MM-DD` | GitHub, Linear, Slack, Wispr (meetings and calendar) | Notion (links found in other sources) |
| `incident` | Sentry id or URL, or a description | Sentry, Slack, Linear | Code (repo work), Braintrust (agent or model failure), GitHub (a suspect PR or deploy surfaced) |
| `topic` | quoted text | Slack, Notion, Linear | Code (repo work), Wispr, GitHub (a PR or ticket surfaced), Braintrust (AI topic) |
| `conventions` | optional repo path (default: cwd) | repo files, configs, code, `gh-activity conventions` | none |
| `research` | a question about a library, framework or service (the kind is detected from it) | context7, GitHub source, issues and releases, changelogs, firecrawl | community posts (labelled lower confidence) |

**Detect the mode from the argument**; the user never names it:
- a ticket key (`AI-615`) → `ticket`; a PR number, PR URL or branch → `pr`; a Sentry id or URL, or an error report → `incident`
- `me`, or a person's name → `person`; a date or range (`today`, `yesterday`, `3d`, `2026-10-08`) → `window`
- "conventions" or a repo path → `conventions`
- a question about a library, framework or service → `research`
- anything else → `topic`
- Say the detected mode in the dispatch line; when two fit equally, pick the narrower one and say so.

`person` and `window` default to the last 7 days and to today, respectively, when no window is given. `me` is the current user (Slack: the id from `slack_read_user_profile` called with no user id, used as `<@ME>` in searches; GitHub: the active `gh` account).

Per-source tools, queries, caps, and gates are in `references/sources.md`. Conventions mode is described in `references/conventions.md`; read it before running that mode, and skip steps 4 to 6 below. Research mode is described in `references/research.md`: detect the kind from the question, then one `general-purpose · sonnet · high` agent per question writes `research-<topic-slug>.md`; skip steps 4 to 6.

## Flow

1. **Name the focus.** Build a kebab-case focus slug, such as `ticket-ai-615`, `pr-4226`, `window-2026-10-08`, or `topic-citation-regeneration` (at most 50 characters).
2. **Pick the output directory.** The caller names it (a roadmap's `research/`). Otherwise write to `~/roadmaps/<project>/context/<YYYY-MM-DD>-<focus-slug>/` (project from the origin remote; `~/roadmaps/_context/` outside a repo). Create it if missing. A rerun overwrites the source files, because the bundle is a snapshot.
3. **Seed identifiers (main thread, one call).** For `pr`, run `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <arg> --json` and keep only `ticket`, `head`, `base`, `title`, `author`, and `url`. For `ticket`, call Linear `get_issue` and keep the title, branch name, attached PR links, assignee, and parent. Other modes need no seed.
4. **Choose sources.** Start from the mode's defaults, then apply each gate in `references/sources.md`. Print one line before dispatching, for example `gather-context: pr 4226 → github, linear, slack (skipped: notion, wispr, braintrust)`.
5. **Dispatch one agent per source, in parallel, in a single message.** Use general-purpose agents. Use the `model · effort` in each source's heading. Build each prompt from the template in `references/sources.md`. Each agent writes `<outdir>/<source>.md` and returns at most 150 words.
6. **Merge.** Read the source files and write `<outdir>/bundle.md` using the template below. Resolve duplicates across sources into one entry that carries every link. When two sources disagree, keep both with their links and list the conflict under Open questions.
7. **Report.** Give the caller the bundle path and the Summary section.

## Bundle template

```markdown
# Context: <mode> <argument>
Generated <local date and time> · Sources: <source files alongside, e.g. github.md, slack.md> · Window: <if any>

## Summary
<at most 5 lines: what this is, where it stands, what is unresolved>

## Timeline
- <YYYY-MM-DD HH:MM local> · <what happened> · <who> · <link>

## Code map
- <file:line> · <entry point, path step, caller, reuse candidate or test, and why it matters>

## Decisions
- <decision> · <who decided, when> · <link to where it was decided>

## Open questions
- <question or conflict> · <link>

## People
- <name> (<Slack or GitHub handle>): <role in this focus>

## Links
- <source>: <label> <url>

## Gaps
- <source skipped or thin, and why>
```

## Rules

- Every item in a source file and in the bundle carries a link (a `file:line` for code). An item without a link is left out, unless the source file names exactly where it was seen.
- An item relates only through a matching identifier (ticket key, PR number, branch, file or symbol name) or the relevance test in `references/sources.md`; everything else is left out.
- When a source fails (for example, the MCP is not authenticated), record it under Gaps with the error, and ask the user to run `/mcp` if it is an auth problem. Never fill the gap with a guess.
- Finding nothing is a finding. Say "no recorded rationale" or "no discussion found" out loud in Gaps.
