---
name: review
description: Review someone else's PR in one pass, draft comments in the user's voice, and post them after the user's yes.
disable-model-invocation: true
metadata:
  origin: local
---

# Review

- `/review #<number>`: review someone else's PR once and post the comments the user approves.
- `/review edit <comment-link>`: edit a comment already posted.
- Output: `~/roadmaps/<project>/reviews/pr-<number>/` (project from the origin remote).

## Rules

- **Read-only on their code:** fetch the PR's refs; their branch stays unchecked-out and unedited.
- **Their conventions** are the standard, found in their repo.
- **Posting:** only the exact batch the user saw and said yes to, as the user's account, per `references/posting.md`.

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run as chief of staff.
- Every subagent is fresh, runs in the background, reads `brief.md` first, writes into the output folder, and returns at most 150 words.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - `general-purpose · haiku · low`: `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <number> --json` (head, base, head SHA, ticket, author, threads; for an edit, the number from the comment link) and `git fetch origin <base> "pull/<number>/head"`; write `brief.md`: range `origin/<base>...<head SHA>`, ticket, author, open threads.
   - `/review #<number>` runs steps 2 to 4; `/review edit` runs step 5.
2. **Context** (parallel)
   - `general-purpose · sonnet · medium`: `gather-context pr <number>` (ticket, threads, Slack, history).
   - `general-purpose · sonnet · medium`: `gather-context conventions` for the PR's areas.
3. **Review** (parallel), each into `review/`, told which points open threads already raise:
   - The applicable `pr-review-toolkit` agents (`code-reviewer` always; `pr-test-analyzer`, `silent-failure-hunter`, `type-design-analyzer`, `comment-analyzer` when the diff touches tests, error handling, types or comments) `· opus · high`.
   - `general-purpose · opus · high`: `thermo` on the range, against their conventions.
   - `general-purpose · opus · high`: `code-review` on the range, with the ticket's acceptance criteria as the spec.
   - `general-purpose · opus · high`: the code against the ticket's acceptance criteria: gaps and scope creep.
   - UI changes only, `general-purpose · sonnet · high`: `impeccable` critique and `web-design-guidelines` on the changed screens, report only.
4. **Validate and draft** (sequential)
   - `Plan · opus · high`: validate every finding in `review/` per `references/validation.md`; draft each survivor per `references/posting.md`, its fix verified per `references/fixes.md`. Save as `comments.md`.
   - `general-purpose · sonnet · medium`: run `humanizer` on the drafts.
   - Gate: every survivor carries evidence at the head SHA, and every drop names the test that dropped it.
5. **Edit** (sequential)
   - `general-purpose · sonnet · high`: fetch the comment's current body (`references/api.md`); draft the new body per `references/posting.md` (Editing), any added fix verified per `references/fixes.md`; run `humanizer`. Save as `edit.md`.
6. **Approve** (sequential)
   - Show the batch per `references/posting.md` (Checkpoint), review event included; for a review, then the dropped findings with the evidence that dropped each.
   - With no comments left, tell the user; post an `APPROVE` review only when they ask for one.
   - The user says yes or no, per comment or for the batch.
   - Gate: the user's explicit yes to the exact batch shown.
7. **Post** (sequential, on yes)
   - `general-purpose · haiku · low`: post the approved batch as the user's account per `references/posting.md` (Posting) and `references/api.md`; confirm each comment landed under the user's login.
8. **End** (sequential)
   - Tell the user the review link and what was posted, dropped or turned into replies.
