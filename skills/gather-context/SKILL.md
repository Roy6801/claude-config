---
name: gather-context
description: |
  Gather read-only context for an issue or ticket, a PR, a person, a time window, an incident, a topic, or a repo's conventions. One agent per connected source (GitHub, Linear, Slack, Notion, Wispr Flow meetings and calendar, Sentry, Braintrust, and the repo's code) runs in parallel and writes a cited file, and the main thread merges them into a bundle with a summary, timeline, code map, decisions, open questions, people, and links. Conventions mode discovers a repo's written, tool-enforced, code-level, and git/GitHub conventions fresh every time.

  Use when: another skill needs background (spec, pair, review, explain, debug, qa), or asked "get context on issue #42", "what happened on PR #4226", "what did I do yesterday", "what's going on with <topic>", "what are this repo's conventions", or `/gather-context <mode> <arg>`.
user-invocable: true
metadata:
  origin: local
---

# Gather context

Collect what is known about one focus, from every source that applies, into one cited bundle file. The bundle holds pointers and short summaries, never pasted dumps.

Sources are used only when connected: a source whose MCP server or CLI is not set up is skipped without asking and listed under Gaps. This skill is read-only everywhere. It never posts, comments, reviews, resolves, edits, or pushes, and it never touches a database or reads `.env` files. Anything it wraps inherits these rules.

## Focus modes

| Mode | Argument | Default sources | Gated sources |
|---|---|---|---|
| `ticket` | GitHub issue number or URL, e.g. `#42`, or a Linear key | GitHub, Linear (Linear key), Slack | Code (repo work), Notion (ticket links a doc), Wispr (decision without written rationale), Braintrust (AI work) |
| `pr` | number, URL, or branch | GitHub, Linear (ticket key found), Slack | Code, Notion, Wispr, Braintrust, as for `ticket` |
| `person` | a name, or `me` | Slack, Linear, GitHub | Wispr (shared meetings in the window) |
| `window` | `<since> [until]`: `today`, `yesterday`, `<n>d`, `YYYY-MM-DD` | GitHub, Linear, Slack, Wispr (meetings and calendar) | Notion (links found in other sources) |
| `incident` | Sentry id or URL, or a description | Sentry, Slack, Linear | Code (repo work), Braintrust (agent or model failure), GitHub (a suspect PR or deploy surfaced) |
| `topic` | quoted text | Slack, Notion, Linear | Code (repo work), Wispr, GitHub (a PR or ticket surfaced), Braintrust (AI topic) |
| `conventions` | optional repo path (default: cwd) | repo files, configs, code, `gh-activity conventions` | none |

`person` and `window` default to the last 7 days and to today, respectively, when no window is given. `me` is the current user (Slack: the id from `slack_read_user_profile` called with no user id, used as `<@ME>` in searches; GitHub: the active `gh` account).

Per-source tools, queries, caps, and gates are in `references/sources.md`. Conventions mode is described in `references/conventions.md`; read it before running that mode, and skip steps 4 to 6 below.

## Flow

1. **Name the focus.** Build a kebab-case focus slug, such as `ticket-42`, `pr-4226`, `window-2026-10-08`, or `topic-citation-regeneration` (at most 50 characters).
2. **Pick the output directory.** Run `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json`. When `slug` is not null, write to `<dir>/context/<focus-slug>/`. Otherwise write to `$CLAUDE_CONFIG_DIR/state/context/<YYYY-MM-DD>-<focus-slug>/`. Create it if missing. A rerun overwrites the source files, because the bundle is a snapshot.
3. **Seed identifiers (main thread, one call).** For `pr`, run `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <arg> --json` and keep only `ticket`, `head`, `base`, `title`, `author`, and `url`. For `ticket`, run `gh issue view <arg> --json title,url,assignees,labels,body` for a GitHub issue, or call Linear `get_issue` for a Linear key, and keep the title, branch name, linked PRs, assignee, and parent. Other modes need no seed.
4. **Choose sources.** Start from the mode's defaults, then apply each gate in `references/sources.md`. Print one line before dispatching, for example `gather-context: pr 4226 → github, linear, slack (skipped: notion, wispr, braintrust)`.
5. **Dispatch one agent per source, in parallel, in a single message.** Use general-purpose agents. Use `haiku` for sources that are one or two direct lookups (GitHub through the script, Sentry by id, calendar), and `sonnet` for sources that need search and judgment (Slack, Notion, Linear with related tickets, Wispr meetings, Braintrust, code). Build each prompt from the template in `references/sources.md`. Each agent writes `<outdir>/<source>.md` and returns at most 150 words.
6. **Merge.** Read the source files and write `<outdir>/bundle.md` using the template below. Resolve duplicates across sources into one entry that carries every link. When two sources disagree, keep both with their links and list the conflict under Open questions.
7. **Report.** Give the caller the bundle path and the Summary section. When the user will act on the bundle directly, run the self-grill checklist (`$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md`) on the Summary and Decisions first and show the Grilled block with it.

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
- Never guess that a source item relates to the focus. It relates through a matching identifier (ticket key, PR number, branch, file or symbol name) or by passing the relevance test in `references/sources.md`, or it is left out.
- GitHub data comes only from `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts` (plus the one `gh issue view` seed), never from ad-hoc `gh` chains. If the script lacks something, note the gap.
- Private Slack channels and DMs are read only on an identifier hit or a link the user gave. Never quote them verbatim; write one summarized line plus the link.
- Wispr Flow and Sentry return UTC. Convert every time to the local time zone (`date +%Z`) before writing it.
- When a source fails (for example, the MCP is not authenticated), record it under Gaps with the error, and ask the user to run `/mcp` if it is an auth problem. Never fill the gap with a guess.
- Finding nothing is a finding. Say "no recorded rationale" or "no discussion found" out loud in Gaps.
