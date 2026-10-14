---
name: done
description: |
  Close a piece of work properly. Verifies every acceptance criterion has real evidence (QA verdicts, tests, PR links, screenshots) and lists the gaps, checks the definition of done and that the PRs merged, self-grills "is it really done?", drafts the closing comment and status change (through `ticket` when Linear is connected, else on the GitHub issue), files follow-up issues for loose ends, marks the roadmap step done, and offers `handoff`. Every outward write is shown in full and runs only after approval.

  Use when: the last slice of a piece of work merged, an issue's work is complete, a brainstorm roadmap step is "done" or "close out", or asked to "wrap this up", "close the issue", "are we done", "mark it done", or `/done [slug|issue]`.
user-invocable: true
metadata:
  origin: local
---

# Done

Work is done when every AC has evidence, the code is merged, and the issue (if there is one) says so. This skill checks all three and fixes what it can with the user's approval. It never closes anything on assumption.

## 1. Load

- Initiative: `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json` (or the slug given). Read `roadmap.md`, `decisions.md`, `spec.md` and `pair.json` in its directory if they exist, and the newest `qa-*.md` reports.
- ACs: `bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json`. No spec: the ticket's or issue's Acceptance Criteria checkboxes are the ACs.
- Ticket or issue, for the spec's `ticket:` key (or the one given) plus each slice's from `pair.json`: `ticket` read mode for a Linear key when Linear is connected, else `gh issue view <n> --json title,body,state,comments`.
- PRs: for each slice branch or linked PR, `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <branch|number> --json` (state, merged, base, checks, unresolved threads).

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
- Mark the roadmap step done: `bun $CLAUDE_CONFIG_DIR/bin/work.ts step - <n> done`, after confirming which step.
- Offer a private artifact page of the completion summary (AC table, PRs, follow-ups); publish only on a yes.
- Offer `handoff` when more work follows in this initiative.

## Rules

- Every outward write (comment, status or close, new ticket or issue) is shown in its exact form and runs only after approval.
- Evidence is real or the AC is a gap. Never tick, close or claim on assumption.
- Discover labels and issue state at run time.
- No AI attribution and no session links or ids in anything written.
