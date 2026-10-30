# Context sources: tools, queries, caps, gates

Every source is read-only. Caps are per agent run. When a cap is reached, the agent stops and records the gap; it does not keep fishing. Time-box: if a source needs more than a couple of calls before producing anything useful, drop it and note why.

## Agent prompt template

Fill the placeholders and send one prompt per source. Keep the prompt self-contained, because the agent sees nothing else.

```text
You are gathering <SOURCE> context for: <MODE> <ARGUMENT>.
Known identifiers: <ticket key, PR number and URL, branch, title, people, window: since..until local>.
Read-only: the only file written is <OUTDIR>/<source>.md; never post, comment, edit, resolve, or push; never touch a database or read .env files.
Use only these tools: <tools for this source>. Caps: <caps for this source>. Gate notes: <gates>.
Relevance: an item counts only if it carries one of the identifiers, or it mentions the subject AND carries a
decision or problem signal (a choice made, a bug reported, a constraint stated). Passing mentions do not count.
Convert UTC times to local time (`date +%Z`).
Write <OUTDIR>/<source>.md in this format:
  # <Source>: <focus>
  Queried: <each query or call, with hit counts>
  ## Items
  - <YYYY-MM-DD HH:MM local> · <one line: what> · <who> · <link>
  ## Decisions and open questions seen
  - <one line> · <link>
  ## Gaps
  - <what was not found or failed, and why>
Every item needs a link. Private Slack: one summarized line plus the link, never a verbatim quote.
Return at most 150 words: the 3 to 5 most important findings with links, and the gaps.
```

## GitHub (haiku · low)

Tool: `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts` only. All commands accept `--json`.

| Mode | Calls |
|---|---|
| `pr` | `pr <arg> --json` (metadata, checks, reviewers, review threads with `isResolved` and `isOutdated`) |
| `ticket` | `pr <branch or url>` for each PR linked from the ticket (at most 3) |
| `window`, `person me` | `me --since <since> [--until <until>] --json` |
| `person <other>` | `me --user <github login> --since <since> --json`. Pushes for another user are public events only. Find the login from the person's Slack or Linear profile; if none is listed, ask the user once. |
| `incident`, `topic` | only `pr <url>` for PRs another source surfaced (at most 2) |

Caps: at most 3 script calls. Classify review threads as (resolved explained, resolved unexplained, unresolved answered, unresolved no reply, outdated), quoting the reason or citing the commit; never invent a reason.

## Linear (sonnet · medium; haiku · low for a single `get_issue`)

Tools: Linear MCP `get_issue`, `list_comments`, `list_issues` (with filters such as assignee `me`, `updatedAt`, `query`), `get_user`, `list_users`.

- `ticket`, `pr`: the focus issue, its parent, and up to 3 issues it lists as blocked-by, blocking, or related. Comments on up to 5 issues. Looking for the problem statement, acceptance criteria, rejected alternatives, and prior attempts.
- `window`, `person`: `list_issues` for the assignee, updated in the window (at most 2 queries, 50 issues each).
- `incident`, `topic`: `list_issues` with a text query (at most 2 queries), then `get_issue` on at most 3 hits that pass the relevance test.
- If the MCP is not authenticated, stop and record the error; the main thread asks the user to run `/mcp`.

## Slack (sonnet · medium)

Tools: `slack_search_public_and_private`, `slack_search_public`, `slack_read_thread`, `slack_search_users`, `slack_read_user_profile`, `slack_list_user_channels`.

- **Tier 1, identifiers (always):** ticket key, PR number, branch name, or a distinctive symbol or file name. Private channels and DMs are allowed only for these identifier hits.
- **Tier 2, topic (only when tier 1 is empty or thin):** feature or module names, public channels only, from about 60 days before the work started through today. Apply the relevance test before reading a thread.
- `window`: `from:<@ME>` and `to:<@ME>` with `after:`/`before:` dates. `person`: resolve the user id with `slack_search_users`, then `from:<@ID>` in the window.
- Caps: at most 4 search queries across both tiers, and at most 5 threads read. Nothing relevant after that: stop and say background was thin.

## Notion (sonnet · medium)

Tools: `notion-search`, `notion-fetch`.

- Gate: the ticket, PR body, or a Slack thread links a Notion doc, or the focus touches an area with a known doc (listed in the repo's `AGENTS.md` reference paths).
- Fetch linked docs first. Then at most 2 searches (ticket key, feature or module name) and at most 3 fetches in total. No hit in two searches: stop.
- Record the doc title, its status if shown, its last edit date, and the specific sections that matter, with the link.

## Wispr Flow: meetings and calendar (sonnet · medium for meetings, haiku · low for calendar only)

Tools: `search_meetings`, `get_meeting`, `search_scratchpad_notes`, `search_calendar_events`, `list_upcoming_meetings`, `get_meeting_participants_enriched`.

- Gate for `ticket`, `pr`, `topic`: another source surfaced a decision with no written rationale. Search by ticket key or feature name in a window around the work's first commit or ticket creation date.
- `window`: meetings and calendar events in the window; `person`: meetings shared with that person in the window.
- Caps: at most 2 searches and 3 `get_meeting` calls. All times come back in UTC; convert them to local time before writing.
- Write decisions and action items with their speaker, not whole transcripts.

## Sentry (haiku · low for an id or URL, sonnet · medium for a description)

Tools: `get_sentry_resource`, `search_issues`, `search_errors`, `search_traces`. Do not run `analyze_issue_with_seer` unless the user asks.

- With an id or URL: the issue, its latest event (stack, tags, release, first and last seen, event count), and at most 2 searches for related issues in the same culprit or release.
- With a description: at most 3 searches, then the top 2 matching issues.
- Record the release or commit that first shows the error, so the GitHub agent can look at the matching PR.

## Braintrust (sonnet · medium)

Tools: `resolve_object`, `list_recent_objects`, `summarize_experiment`, `sql_query` (read-only queries). Load the relevant Braintrust workflow skill only if a query needs it.

- Gate: the focus is an incident or topic about an agent, prompt, model, or eval, or the PR touches AI code (prompts, agents, workflows, evals, tracing, model ids, `generateText`/`streamText`, Mastra, CopilotKit).
- Looking for the baseline a change tries to beat, or the production failure mode it fixes: failing spans, score changes, error rates, with permalinks.
- Caps: at most 3 calls. Never write datasets, prompts, scorers, or automations.

## Code (sonnet · medium)

Tools: Read, Grep, Glob, and read-only `git` (`git grep`, `git log`, `git blame`, `git ls-files`). Never run builds, tests, installs or scripts, and never read `.env` files.

- Gate: the focus is a change to the current repo (a feature to build, a bug to fix, a PR or incident to trace into the code). Skip it when the focus carries no repo work.
- Seed the search from the identifiers and the ask: symbols, file names, routes, UI copy, error messages, stack frames.
- Map the area the change lands in: the entry points it starts from (route, page, component, procedure, job), the path the behaviour runs through, the callers of anything likely to change (the blast radius), existing helpers, components or patterns that already do part of it (reuse), and the tests that cover it today.
- Caps: at most 10 searches and 15 file reads. Stop at the edge of the change; the map covers the area the work touches, never the whole app.
- Write `code.md` in the template's format with `## Entry points`, `## Path`, `## Callers`, `## Reuse` and `## Tests` in place of `## Items`. Each item is `<file:line> · <one line: what it is and why it matters>`; the `file:line` is its link.
