---
name: pair
description: |
  Interactive coding, on by default. Plans the work as a ladder of small slices (one branch and one draft PR each, at most 500 net lines, each adding one behaviour the user can test alone) and approves the ladder and each slice plan as plan mode gates, then builds each slice as planned atomic commits whose messages record why, what changed per file, alternatives, deviations and checks, and closes every slice with a checkpoint: simplify, thermo and conventions review, green check on every commit, the user's own test, QA per AC, and a commit-by-commit walkthrough before the user's OK. The `builder` agent implements one planned commit at a time; the main thread reviews, stages and commits. State lives in pair.json under the initiative directory, never in the repo.

  Use when: a spec is approved and implementation is next, a brainstorm roadmap step is "plan and build", the user asks to "plan the slices", "plan the commits", "build this", "continue", "what's next on the slice", "walk me through the commits", or runs `/pair plan`, `/pair`, `/pair checkpoint`, `/pair status`, `/pair off`, `/pair on`, or `/pair resume`.
user-invocable: true
metadata:
  origin: local
---

# Pair

Work grows from small to large in slices the user can test one at a time. Each slice is one branch and one draft PR; each commit is atomic, keeps the repo green, and records its reasoning, so the git history is the decision record. The main thread holds the dialogue, the decisions and the gates; the `builder` agent writes the code for one planned commit at a time.

## Running the script

`pair` means `bun <base directory of this skill>/scripts/pair.ts`. It resolves the initiative with `work.ts current --json` (or `--slug <slug>`), and every command takes `--json`. Failures print one line to stderr and exit 1; exit 2 from `pair check` means "stop and ask the user". Do not re-implement a step with raw git: if the script cannot do it, say so.

| Command | Does |
|---|---|
| `pair plan save <file>` / `pair plan show` | Validate and store the ladder (also writes `stack.json` for `br stack`); print the ladder, timeline and AC coverage |
| `pair status` | Current slice and commit, commits done/planned, net lines vs budget, time vs estimate, mode |
| `pair check` | Compare the working changes with the planned commit's files and the slice budget |
| `pair commit --why … --notes <file.json> [--title …] [--alt …] [--deviation …] [--noticed …] [--checked …]` | Commit what is staged as the next planned commit (or, with `--title`, an extra commit) with the full message |
| `pair green [--slice n]` | Run the slice's check on every commit of the slice; SHAs never change |
| `pair walk [--slice n \| --commit <sha>]` | Plain-text walkthrough, deviations first |
| `pair slice start n` / `pair slice done n` | Status transitions; `start` prints the `br new` commands for the branch, `done` needs every commit done |
| `pair mode on\|off` | Interactive mode switch |

State: `$CLAUDE_CONFIG_DIR/state/work/<slug>/pair.json`. Branch and push mechanics belong to the `branch` skill (`br`); initiative state belongs to `bun $CLAUDE_CONFIG_DIR/bin/work.ts`.

## Modes

- `/pair plan`: build the ladder and approve it in plan mode, then set up issues and branches (sections 1 and 2).
- `/pair`: continue. Run `pair status`; if the current slice has a todo commit, build it (section 3); if the slice is in `checkpoint` (set by `pair commit` when the last planned commit lands), run the checkpoint (section 4); if no slice is active, offer `pair slice start <next>`.
- `/pair checkpoint`: run the checkpoint for the current slice now.
- `/pair status`: run `pair status` and `pair plan show`, and relay both, at-risk flags first.
- `/pair off` and `/pair on`: run `pair mode off|on` and confirm in one line. Off skips the slice and re-plan gates and the per-commit review ceremony (see section 3).
- `/pair resume`: run `work.ts current`, read `roadmap.md`, `decisions.md`, `handoff.md` and `pair.json`, run `pair status`, summarize in five lines (goal, slice, commit, last decision, next action), then continue as `/pair`.

## 1. Plan the ladder (ladder gate)

Approvals in pair are plan mode **gates**: the ladder gate here, a slice gate before each slice, and a re-plan gate when a slice goes sideways. Read `references/plan-mode.md` before opening any gate; it holds when each gate opens or is skipped, how to run it, the plan file templates, and the writes that follow approval.

Inputs, gathered by agents so the main thread stays free: the spec's ACs (`bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json`), the `gather-context` skill in conventions mode (patterns to follow with file:line, and the check commands), and `br target`. If there is no approved spec, say so and offer the `spec` skill first.

Build the ladder smallest-first by the rules in `references/ladder.md`: slice 1 is the thinnest end-to-end path, every later slice adds one behaviour the user can test alone, prefactor slices come first, risky work comes early, slices group into demo-able milestones, and no slice exceeds 500 net lines. Estimate days per slice and compare the total with the deadline; when it does not fit, show the gap and the options (cut scope, put it behind a flag, move it to a follow-up slice, move the date). Never squeeze estimates to make it fit.

Library decisions: read the docs (context7) and the library's GitHub source and issues, through an agent, before proposing anything. Every real decision goes to the user as options with a recommendation, then into `work.ts decide`. Planned exceptions to the repo's conventions are listed in the slice with their reasons, for the user to approve.

Run the self-grill checklist (`$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md`) on the ladder and put the Grilled block in the plan file. Invite the user to grill it in turn; apply their edits to the plan file. Offer a private artifact page of the plan (ladder, milestones, timeline, AC coverage, exceptions). On approval, run the after-approval steps in `references/plan-mode.md`: the ladder JSON (shape in `references/ladder.md`) goes to a draft file in the initiative directory, then `pair plan save <file>`, `pair plan show`, and `work.ts decide` for the approval and every logged decision.

## 2. Set up (after approval, each step confirmed)

1. **Tickets or issues (optional).** When Linear is connected, offer a parent ticket plus one sub-ticket per slice through the `ticket` skill; otherwise a GitHub issue per slice (`gh issue create`), linked to the spec's issue when there is one. Titles name the feature behaviour, never "part 1 of N". Show the exact titles and bodies and create nothing without the user's yes.
2. **Branches.** Run `br name` for each slice and show the suggested names; the user confirms or edits them. Put the confirmed names in the plan and re-run `pair plan save`.
3. **Stack.** `pair plan save` writes `stack.json` next to `pair.json` and prints its path. Run `br stack <that path> --dry-run` and show the output; on the user's OK run it without `--dry-run`. Add `--draft-prs` only if the user wants draft PRs now; PRs open only for layers that have commits, so most appear after a slice's first commit (rerun later). The open-PR cap is optional: pass `--cap <n>` only when the user sets one (`br` falls back to 5 with `--draft-prs`, so pass a number above the slice count when they want none).

## 3. Build, one commit at a time

Open the slice gate (`references/plan-mode.md`) unless the slice qualifies to skip it. After approval, run `pair slice start n`. It prints `br new <branch> --here --base <previous slice branch or base>` and a `--worktree` variant; ask the user which one when it is not already clear, then run it (`pair commit` refuses unless HEAD is on the slice branch). Then, for each planned commit in order:

1. Dispatch the `builder` agent (`$CLAUDE_CONFIG_DIR/agents/builder.md`) with the commit's title, why, files, patterns, ACs, check command and constraints (template in `references/commits.md`).
2. Review the diff yourself. Fix small problems inline or send the builder back with specific corrections.
3. Run `pair check`. Exit 2 means a file is outside the plan or the budget is exceeded: stop and ask the user whether to split, move the change to another commit or slice, or raise the limit with a reason. An answer that changes the plan opens the re-plan gate.
4. Run the commit's check command and read its output.
5. Stage the planned files explicitly by path (never `git add -A` or `git add .`), write the notes JSON, and run `pair commit` with the why, alternatives, deviation, noticed and checked values (format in `references/commits.md`).
6. Push with `br push` (never force). Give the user one line: the commit title, the check result, and anything noticed.

If you have been blocked for about 30 minutes, say so with what was tried and what you suspect, and open the re-plan gate. When a step is unclear, run a quick grilling round instead of guessing.

**Mode off.** Skip the slice and re-plan gates, the per-commit review pause and the one-line report, and implement directly or through the builder. Still commit atomically through `pair commit` with the same message format, and still run the checkpoint at the end of the slice.

## 4. Checkpoint (per slice)

Run the steps in `references/checkpoint.md`, in order: `review slice` (simplify, reviewer with thermo and conventions, AC conformance), `pair green`, the user's test script, QA per AC, the walkthrough, then the user's OK, `pair slice done n` and `work.ts step`. Afterwards offer the `handoff` skill: each new slice starts best in a fresh session.

## Rules

- Never mark a PR ready for review, never merge, never force-push, never pass `--no-verify` to a commit.
- Never touch a database. If a slice needs data, write a data request for the user to run.
- Never add AI attribution, session links or trailers to commits, PRs or issues.
- Keep pair state out of repositories and `.git`; it lives only in the initiative directory.
- Ticket, issue and PR writes happen only after the user approves the exact content.
- Write plans, walkthroughs and questions in full, clear sentences. Status lines can be short.
