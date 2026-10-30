---
name: ticket
description: Read, create, update, start, finish or split Linear tickets, or apply ticket text another skill hands over. Use for any of those, or `/ticket [mode] [KEY]`.
user-invocable: true
metadata:
  origin: local
---

# Ticket

Linear is where others see the work. This skill keeps tickets accurate.

## Tools

All calls go through the Linear MCP server (`mcp__plugin_linear_linear__*`); load their schemas with ToolSearch before the first call.

| Purpose | Tool |
|---|---|
| Read one ticket | `get_issue` (`includeRelations: true` for blockers and parent context; `fields` to trim) |
| Find tickets | `list_issues` (`query`, `team`, `assignee: "me"`, `parentId`, `state`, `updatedAt`) |
| Comments | `list_comments` to read, `save_comment` (`issueId`, `body`) to write |
| Create or update | `save_issue` (no `id` creates; `id` updates) |
| Discovery | `list_teams`, `list_issue_statuses` (`team`), `list_issue_labels` (`team`), `list_users`, `get_user` (`"me"`), `list_projects`, `list_cycles` |

`save_issue` details that matter: `assignee` takes a name, email or `"me"`; `state` takes a status name or type; `addLabels`/`removeLabels` change labels incrementally (prefer them over `labels`, which replaces the whole set); `parentId` sets the parent; `blockedBy`/`blocks`/`relatedTo` are append-only; `links: [{url, title}]` attaches a PR or doc; `patch` edits part of the description in place (exact anchors), which is safer than resending the whole description.

## Before a write

Resolve what it needs from the workspace: the team (from the parent ticket, the ticket key prefix, or `list_teams` and ask), the team's statuses (`list_issue_statuses`), labels (`list_issue_labels`), and people (`get_user "me"`, `list_users`). Pick labels from that list by fit with the work and give a one-line reason each; if the team has a label for a reframed request (an "XY problem" label or similar), propose it when the ticket's real problem differs from what was asked.

## Modes

### read (default when given only a key)

`get_issue` with relations, plus `list_comments`. Summarize in a few lines: title, status, assignee, parent, Purpose, ACs with their checkbox state, blockers, linked PRs and docs, the latest decision-bearing comments. No writes.

### create

Draft the ticket in the format in `references/format.md`. Fields to settle: team, title, description, priority, estimate (only if the team uses estimates), assignee (`"me"` unless the user names someone), labels (proposed from the discovered list), project or cycle when the user wants one, parent, relations, links. Ask for anything that cannot be derived. Show the full draft; on approval, `save_issue`, then return the identifier, URL and `gitBranchName`.

### update

`get_issue` first. Show the change diff-style: description edits (as the `patch` operations or the full new text), checkbox changes on ACs from the current PR and code state, labels added or removed, links, relations. Expand the AC checklist as scope evolves; never silently delete an AC (strike it through with a reason). On approval, `save_issue` with `id`.

### start

The user begins work. Discover the team's statuses of type `started`. Teams often have several (for example design review, development, review, QA): propose the one that names active development, and ask when it is not obvious. Draft a short comment: what is starting, the plan or first slice, the branch name. Show both; on approval, `save_issue` (`state`) and `save_comment`.

### finish

When the user says the work is complete. Discover the completed status (type `completed`). Check the current status first: the GitHub integration may already have moved the ticket on merge, and a team may require a QA or review status before completion. Never move a ticket backwards or skip a status the team's flow requires; ask when unsure. Draft the closing comment: what shipped (PR links), the AC verdicts with evidence links, follow-ups created, anything deliberately left out. Show both; on approval, `save_comment` then `save_issue` (`state`). If any AC is unverified, say so and let the user choose to close anyway, keep it open, or file a follow-up.

### split (sub-tickets per PR)

From kickoff's PR list or a stack the review-fix loop sets up: one child per PR with `parentId` set to the parent ticket. Titles follow `references/format.md`. Order goes in `blockedBy` relations between siblings. Each child's description uses the format with only that PR's ACs. Show every child together; on approval, create them bottom-up so `blockedBy` can reference earlier ones. Return each `gitBranchName`.

### apply handed-over text (from `to-spec`, `ship`, `review-fix-loop`)

Use the text verbatim: create the ticket or update the description (`patch` when only sections change); do not re-draft the content. Confirm the one-line action before the write ("update AI-615 description with the approved spec text?"), except inside `ship` and `review-fix-loop`.

## Linking PRs

`get_issue` with `fields: ["attachments"]` first: the GitHub integration usually links a PR whose branch contains the key. Only when it is missing, propose `save_issue` with `links: [{url, title}]`.

## Rules

- Every write is shown first in its exact form and runs only after approval; a yes covers only what was shown. The exception is the pre-approved writes inside `ship` and `review-fix-loop`.
- Read mode never writes, not even a comment.
- Titles, descriptions and comments are world-facing (CLAUDE.md); their format is in `references/format.md`.
- After a write, return the ticket identifier, URL and a one-line summary of what changed.
