---
name: ticket
description: |
  Read, create and update Linear tickets through the Linear MCP tools, when Linear is connected. Modes: read (fetch and summarize, no writes), create (structured description with Purpose, Business Use Case, User Stories and checkbox acceptance criteria), update (description, ACs, labels, links, relations), start and finish (status change plus a comment), sub-tickets per slice under a parent, and applying approved spec text from `spec`. Teams, statuses, labels and users are discovered at run time, never hardcoded. Every write is shown in full and runs only after the user approves it.

  Use when: reading or summarizing a ticket, creating a ticket, updating a ticket's description, ACs, status, labels or links, starting or finishing work on a ticket, creating sub-tickets for slices, linking a PR, another skill hands over approved ticket text (spec, pair, ship, done, qa, debug), or asked to "get AI-615", "create a ticket", "update the ticket", "move it to In Progress", "close the ticket", or `/ticket [read|create|update|start|finish|split] [KEY]`.
user-invocable: true
metadata:
  origin: local
---

# Ticket

Used only when the Linear MCP is connected; without it, other skills fall back to the local spec or a GitHub issue. Linear is where others see the work. This skill keeps tickets accurate and never writes anything the user has not seen and approved in its exact form.

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

## Discover, never hardcode

Before a write, resolve what it needs from the workspace: the team (from the parent ticket, the ticket key prefix, or `list_teams` and ask), the team's statuses (`list_issue_statuses`), labels (`list_issue_labels`), and people (`get_user "me"`, `list_users`). Pick labels from that list by fit with the work and give a one-line reason each; if the team has a label for a reframed request (an "XY problem" label or similar), propose it when the ticket's real problem differs from what was asked. Never invent a label, status or user.

## Modes

### read (default when given only a key)

`get_issue` with relations, plus `list_comments`. Summarize in a few lines: title, status, assignee, parent, Purpose, ACs with their checkbox state, blockers, linked PRs and docs, the latest decision-bearing comments. No writes. Other skills (`ship`, `done`, `gather-context` seeds, `spec`) use this mode.

### create

Draft the ticket in the format in `references/format.md`. Fields to settle: team, title, description, priority, estimate (only if the team uses estimates), assignee (`"me"` unless the user names someone), labels (proposed from the discovered list), project or cycle when the user wants one, parent, relations, links. Ask for anything that cannot be derived. Show the full draft; on approval, `save_issue`, then return the identifier and URL.

### update

`get_issue` first. Show the change diff-style: description edits (as the `patch` operations or the full new text), checkbox changes on ACs from the current PR and code state, labels added or removed, links, relations. Expand the AC checklist as scope evolves; never silently delete an AC (strike it through with a reason, as `spec` does). On approval, `save_issue` with `id`.

### start

The user begins work. Discover the team's statuses of type `started`. Teams often have several (for example design review, development, review, QA): propose the one that names active development, and ask when it is not obvious. Draft a short comment: what is starting, the plan or first slice, the branch name. Show both; on approval, `save_issue` (`state`) and `save_comment`.

### finish

Called by `done`, or when the user says the work is complete. Discover the completed status (type `completed`). Check the current status first: the GitHub integration may already have moved the ticket on merge, and a team may require a QA or review status before completion. Never move a ticket backwards or skip a status the team's flow requires; ask when unsure. Draft the closing comment: what shipped (PR links), the AC verdicts with evidence links, follow-ups created, anything deliberately left out. Show both; on approval, `save_comment` then `save_issue` (`state`). If any AC is unverified, say so and let the user choose to close anyway, keep it open, or file a follow-up.

### split (sub-tickets per slice)

From a `pair` ladder or a `ship` split: one child per slice with `parentId` set to the parent ticket. Titles name the behavior the slice delivers, never "part N of M", "PR A", "split" or ordering words, and never restate the parent's scope. Order goes in `blockedBy` relations between siblings. Each child's description uses the format with only that slice's ACs. Show every child together; on approval, create them bottom-up so `blockedBy` can reference earlier ones. Return the identifiers and each `gitBranchName` for `br name --ticket`.

### apply approved text (from `spec`, `qa`, `debug`, `done`)

Another skill already showed the user the exact text and got approval. Use it verbatim: create the ticket or update the description (`patch` when only sections change). Confirm the one-line action before the write ("update AI-615 description with the approved spec text?"); do not re-draft the content.

## Linking PRs

`get_issue` with `fields: ["attachments"]` first: the GitHub integration usually links a PR whose branch contains the key. Only when it is missing, propose `save_issue` with `links: [{url, title}]`.

## Rules

- Every write is shown first in its exact form and runs only after approval. A yes covers only what was shown.
- Read mode never writes, not even a comment.
- Statuses, labels, teams and users are discovered at run time.
- Writing rules for every title, description and comment are in `references/format.md`.
- After a write, return the ticket identifier, URL and a one-line summary of what changed.
