---
name: pair
description: |
  One PR per chat from a brainstorm roadmap. Plans the next unshipped PR in plan mode (an elaborate plan: every commit's change, files, snippets, tests and check), builds it as planned atomic commits through the `builder` agent without pausing, runs the checkpoint (simplify, review, green on every commit, QA per AC), walks the user through every commit in one message, ships the draft PR with `/ship`, keeps roadmap.md current, and offers the handoff to the next PR. The ladder lives in pair.json in the initiative directory, never in the repo.

  Use when: `/pair plan <slug> [<n>]`, `/pair implement <slug>`, `/pair status <slug>`, or a handoff starter names one; the user asks to "build the next PR", "continue the PR", "build the approved plan", "where are we on the roadmap"; or review comments, CI failures or test findings arrive for the PR this chat shipped.
user-invocable: true
metadata:
  origin: local
---

# Pair

Each chat takes one PR of the roadmap from plan to draft PR: plan, build, checkpoint, walkthrough, ship, then hand off. Brainstorm owns the whole feature (milestones, PR order, tickets or issues, branch names, the stack); pair owns one PR at a time. The main thread holds the dialogue, the decisions and the gates; the `builder` agent writes the code for one planned commit at a time.

## Arguments and the roadmap

| You get | Meaning |
|---|---|
| `/pair plan <slug>` | Plan the next unshipped PR of that roadmap in plan mode, then build it in this chat unless the user says build later |
| `/pair plan <slug> <n>` | Same for PR n, jumping ahead; relay the script's warning about earlier unshipped PRs |
| `/pair implement <slug>` | Build the PR whose plan is approved, or continue a half-built one, from its `pr-<n>-plan.md` |
| `/pair status <slug>` | Where the roadmap stands and how the current PR is doing |
| `/pair` alone | Works as `/pair plan` |

**With a slug**, pair resumes that roadmap: pass `--slug <slug>` to every script call and ask nothing about which roadmap. **Without a slug**, run `pair roadmaps` and never guess. Exactly one initiative of this repo has an unshipped PR: name it with its Next up line in one sentence and ask the user to confirm. Several or none: ask what the user is pointing to, listing each candidate slug with its Next up line, plus "new work: start with /brainstorm".

## Running the script

`pair` means `bun $CLAUDE_CONFIG_DIR/skills/pair/scripts/pair.ts`, always with `--slug <slug>` (except `pair roadmaps`). Every command takes `--json`. Failures print one line to stderr and exit 1; exit 2 from `pair check` means stop and ask the user. Warnings go to stderr; relay them. Do a step through the script, never with raw git; when the script cannot do it, say so.

| Command | Use it to |
|---|---|
| `pair next [<n>] [--implement]` | Route a `/pair` call: prints the action for this chat (below) |
| `pair status` | Every PR's state, this chat's PR, the current PR's commits, size and time |
| `pair plan show` | The ladder by milestone, timeline against the deadline, AC coverage |
| `pair plan save <slice.json> --slice <n> --plan <plan.md>` | Store an approved PR plan (see `references/plan-mode.md`) |
| `pair plan save <ladder.json>` | Store a whole ladder (brainstorm's job; pair uses it only when the user changes the roadmap here) |
| `pair slice start <n>` | This chat takes PR n; prints the `br new` command for its branch |
| `pair check` / `pair commit …` | Gate and record each commit (`references/commits.md`) |
| `pair green` / `pair walk` | Every commit passes its check; the walkthrough source (`references/checkpoint.md`) |
| `pair slice ship <n> --pr <number>` | Record the draft PR that `/ship` opened |
| `pair roadmap sync` | Rewrite the PR statuses and the Next up line of roadmap.md from the ladder |
| `pair roadmaps` | Initiatives of this repo with an unshipped PR, for picking the slug |

State lives in `$CLAUDE_CONFIG_DIR/state/work/<slug>/`: `pair.json` (the ladder, the machine record; shape in `references/ladder.md`), `pr-<n>-plan.md` (each approved plan), and `roadmap.md` (the readable tracker). Plan save, slice start, commit and slice ship rewrite the roadmap's status parts on their own; run `pair roadmap sync` after any hand edit to the ladder.

## Routing

Run `pair next` (`pair next <n>` for `/pair plan <slug> <n>`, `pair next --implement` for `/pair implement <slug>`), say in one line which PR and which step, then act on its `action`:

| Action | Do |
|---|---|
| `plan` | No approved plan yet: run the plan gate (`references/plan-mode.md`), then build |
| `build` | Plan approved, possibly half built: read `plan_file` and the ladder, `pair slice start <n>`, build from the next unbuilt commit |
| `checkpoint` | Built in this chat: the full checkpoint, then walkthrough and ship |
| `ship` | Built in an earlier chat: `pair slice start <n>` (it holds the PR for this chat and prints the branch command), then green, walkthrough, ship; no plan gate, no rebuild |
| `fixes` | This chat shipped this PR: take only fixes to it and roadmap updates |
| `refuse` | This chat holds another PR: say so and ask the handoff question |
| `no-plan` | `/pair implement` found no approved or half-built PR: say so and point to `/pair plan <slug>` |
| `all-shipped` | Every PR is shipped: say so and offer the `done` skill |

## One PR per chat

The script holds each chat to one PR through `CLAUDE_CODE_SESSION_ID`: the chat that saves a PR's plan, starts it, commits to it or ships it holds it. A fresh chat may take over a PR an earlier chat held (a handoff mid-PR); a chat that holds a PR is refused any other. After `/ship`, the chat takes only fixes to its PR (review comments, CI failures, the user's test findings, each as an extra commit through `pair commit --title`) and roadmap updates. Pass `--batch` only when the user explicitly asks to work on more than one PR in this chat.

## Plan

Run the plan gate in `references/plan-mode.md` for this PR only. The plan is elaborate: every commit carries its plain explanation, files, real snippets, tests and check. On approval, save the plan before any code edit, so a chat that dies mid-build resumes with `/pair implement <slug>`. Then build in this chat, unless the user said to build later: then write no code and ask the build-later handoff question below.

## Build

Run `pair slice start <n>`; ask whether to switch here or open a worktree when that is not already clear, and run the printed `br new` command. Then build the whole PR in one run, commit after commit, with no pause for the user between commits: builder, review of its diff, `pair check`, the commit's check, staging by path, `pair commit`, `br push`. The loop and the message format are in `references/commits.md`. Stop only for a `pair check` exit 2, a planned commit that proves wrong, or about 30 minutes blocked; each of those goes to the user as options with a recommendation, and an answer that changes the plan opens the re-plan gate.

## Checkpoint, walkthrough, ship

When the last planned commit lands, run `references/checkpoint.md`: the checkpoint, then one question asking whether to walk through the PR (with the steps to check it themselves), the walkthrough of every commit in one message, the user's one OK, `/ship`, and `pair slice ship <n> --pr <number>`.

## Handoff questions

Wherever the chat's work ends, close with exactly one yes/no question; on yes, run the `handoff` skill with the starter the script printed, and on no, stop.

- After ship: "PR <n> is open as draft #<number>. Hand off to a fresh chat for PR <n+1>, <name>?" (starter from `pair slice ship`, for example `/pair plan <slug>`).
- After a plan approved to build later: "Plan saved. Hand off to a fresh chat to build PR <n>?" (starter `/pair implement <slug>`).
- When refusing another PR in this chat: the after-ship question, naming the PR the user asked for.
- When nothing is left to ship: say every PR is shipped and offer the `done` skill instead.

## Status

For `/pair status <slug>`, run `pair status` and relay it in plain sentences: how many PRs shipped, each PR's state in one line, this chat's PR, the next step and its starter, then the current PR's commits, size and time. Warnings first.

## Decisions

Log only decisions the user made or must know about (a scope change, a convention exception, a plan change after approval) with `bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - … --by user`; use `--by claude` only for a choice you proposed and the user explicitly approved. Skip mechanical ones. Every real decision reaches the user as options in prose with a recommendation first.

## Rules

- Write everything the user reads in plain sentences, next step first, without internal terms; say "goes live together with PR 3" in place of "merge point".
- Never mark a PR ready for review, never merge, never force-push, never pass `--no-verify` to a commit.
- Never touch a database. If a PR needs data, write a data request for the user to run.
- Never add AI attribution, session links or trailers to commits, PRs, tickets or issues.
- Keep pair state out of repositories and `.git`; it lives only in the initiative directory.
- Ticket, issue and PR writes happen only after the user approves the exact content.
