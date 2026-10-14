---
name: done
description: |
  Close a piece of work properly, at one of three scopes: a PR, a milestone, or the whole roadmap (the default). Verifies every acceptance criterion in scope has real evidence (QA verdicts, tests, PR links, screenshots) and lists the gaps, checks that the PRs merged and the definition of done, self-grills "is it really done?", drafts the closing comments and status changes (through `ticket` when Linear is connected, else on the GitHub issues), files follow-up issues for loose ends, marks the PR, milestone or roadmap done in roadmap.md, and offers `handoff`. Every outward write is shown in full and runs only after approval.

  Use when: a PR merged, a milestone's PRs all merged, a whole roadmap is finished, a ticket's or issue's work is complete, or asked to "wrap this up", "close the issue", "are we done", "mark it done", or `/done [<slug>] [pr <n> | milestone <m>]`, `/done <ticket|issue>`.
user-invocable: true
metadata:
  origin: local
---

# Done

Work is done when every AC has evidence, the code is merged, and the issue (if there is one) says so. This skill checks all three and fixes what it can with the user's approval. It never closes anything on assumption.

## Scope

| You get | Scope |
|---|---|
| `/done <slug>` | The whole roadmap (default): every PR and milestone |
| `/done <slug> milestone <m>` | Milestone m: the PRs whose `milestone` in pair.json is m (`pair plan show` groups them) |
| `/done <slug> pr <n>` | PR n alone |
| `/done <ticket>` or `/done <issue>` | Work without a roadmap: that ticket or issue and its sub-tickets or linked issues |

With a slug, close that roadmap at the given scope without asking which. Without one, run `work.ts list`: one match, name it and ask the user to confirm; several or none, list them and ask. Never guess. Say the scope in one line before loading.

Everything below runs on the scope only: its ACs, its PRs, its tickets or issues. A PR scope closes the PR's own ticket or issue; a milestone closes its PRs' tickets or issues; the roadmap closes every remaining one and then the parent, when there is one.

## 1. Load

- Initiative: `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json` (or the slug given). Read `roadmap.md`, `decisions.md`, `spec.md` and `pair.json` in its directory if they exist, and the newest `qa-*.md` reports.
- ACs: `bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json`. No spec: the ticket's or issue's Acceptance Criteria checkboxes are the ACs.
- Ticket or issue for each PR in scope (from `pair.json`), plus the parent for the roadmap scope (the spec's `ticket:` key, or the one given): `ticket` read mode for a Linear key when Linear is connected, else `gh issue view <n> --json title,body,state,comments`.
- PRs: for each PR in scope (its branch, or its `pr` number in `pair.json`), `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <branch|number> --json` (state, merged, base, checks, unresolved threads).

No initiative and no issue given: ask which piece of work to close.

## 2. Evidence per AC

Build one table, one row per live AC:

| AC | Verdict | Evidence | Gap |
|---|---|---|---|
| AC-1 Admin creates a role | pass | qa-2026-10-09.md case 3 (GIF); PR #412 | |
| AC-4 Empty name is rejected | not covered | | no test or QA case |

Evidence counts only when it exists: a QA verdict in a report, a test that ran (name and result), a PR that merged with the change, a screenshot or recording the user supplied. A PR that is still open is not evidence that the AC shipped. Verdicts: `pass`, `fail`, `uncertain`, `not covered`.

Then check the spec's Definition of done the same way, and list: PRs not merged (and unresolved threads), ACs failing or uncovered, DoD items unmet.

## 3. Self-grill

Run `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md` on the question "is this really done?": what would a reviewer, QA or the issue's author say is missing? Show the Grilled block with the table.

## 4. Decide with the user

Show the table, the gaps and the grill result. For each gap, offer: fix it now (back to `pair` or `qa`), file a follow-up issue, or accept it as out of scope with a reason. Nothing closes until the user decides every gap. Record the decision with `work.ts decide - --title "Done: <scope>" --chosen "<close|keep open>" --why "<user's words>"`.

## 5. Follow-ups

For each loose end the user wants tracked, draft a follow-up that references the original, with the gap as its problem and one AC: through `ticket` create (parent or `relatedTo` the original) when Linear is connected, else a GitHub issue. Show all drafts together; create only after approval.

## 6. Close the ticket or issue

Draft a closing comment (what shipped with PR links, the AC table in short form with evidence links, follow-ups, what was deliberately left out). Do slice tickets or issues first, then the parent. Check the current state first and never move a ticket backwards. Show the exact comment and status change; on approval apply it through `ticket` finish mode for Linear, or `gh issue comment` and `gh issue close` for a GitHub issue (skip the close when a merged PR already closed it).

## 7. Wrap up

- Optional: estimate vs actual per slice from `pair.json` (`est_days` against the first and last commit dates), one line each, for the retro.
- Run `bun $CLAUDE_CONFIG_DIR/skills/pair/scripts/pair.ts slice live <n>… --slug <slug>` for each merged PR in scope (step 1 checked the merge). It records them as live in `pair.json` and rewrites the roadmap's statuses and Next up line; once every PR is live the Next up line says the roadmap is done. For a milestone, also add ` (done)` to its heading in `roadmap.md`.
  Older roadmaps with a Steps table use `bun $CLAUDE_CONFIG_DIR/bin/work.ts step - <n> done`.
- Offer a private artifact page of the completion summary (AC table, PRs, follow-ups); publish only on a yes.
- When more of the roadmap remains, end with the handoff question from `pair` for the next PR.

## Rules

- Every outward write (comment, status or close, new ticket or issue) is shown in its exact form and runs only after approval.
- Evidence is real or the AC is a gap. Never tick, close or claim on assumption.
- Discover labels and issue state at run time.
- No AI attribution and no session links or ids in anything written.
