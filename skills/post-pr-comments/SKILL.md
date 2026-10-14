---
name: post-pr-comments
description: |
  The single poster for pull request review comments and replies, in the user's voice. Takes a settled set from the `review` skill (triaged findings on someone else's PR, or approved replies to feedback on the user's own PR), drafts each inline comment so it quotes its source and carries a verified suggested fix, deduplicates against the PR's existing threads, shows each batch exactly as it will appear, and posts only after explicit approval: new comments as one review (inline plus an optional summary), replies in their threads. Verifies that everything landed. Also edits comments already posted.

  Use when: `review others` or `review feedback` has a settled set to post, the user says "post these comments", "reply to the review threads", or an already-posted comment needs rewording, links, or quotes added.
user-invocable: true
metadata:
  origin: local
---

# Post PR comments

The writing and posting stage. Everything here assumes the decisions are already made. The comments are the user's, not the model's; that governs both what gets said and how it reads. Exact API calls are in `references/api.md`; suggested-fix rules and verification are in `references/fixes.md`.

## Modes and input

| Mode | Input | Posts as |
|---|---|---|
| `comments` | settled set from `review others`: claim with `file:line` anchor, confirmed severity, shape (assert or ask), text to quote, references, head SHA | one review: inline comments plus an optional summary body |
| `replies` | approved replies from `review feedback`: thread (first comment url), label (`Fixed in <sha>:`, `Discussed:`, `Won't Fix:`), body | one reply per thread, plus an optional top-level summary comment |
| `edit` | a posted comment's url and the change wanted | an in-place edit |

**Refuse untriaged input.** A raw list from either `reviewer` pass, `thermo`, codex or bugbot does not get posted. Say so and point at `review others` (or `review feedback` for comments on the user's own PR). On the run this skill was built from, ten candidates produced four comments; posting all ten would have asked the author to fix four things they had already handled correctly. If the user insists on posting something untriaged, post it, but say once which checks it skipped.

## Drafting

One comment per finding, anchored to the lines it is about. No grouped follow-up bucket, no dumping small items into one comment. A summary body only when the list is long enough to need an overview.

- **Quote, do not paraphrase.** A blockquote of the AC, the PR description line, or the convention is shorter than describing it and impossible to argue with. When the PR description contradicts the code, quote the description line and put the correction underneath.
- **Link properly.** Tickets in the form the repo already uses (take it from the PR body). Code as SHA-pinned permalinks, `https://github.com/{owner}/{repo}/blob/{sha}/{path}#L{start}-L{end}`. Link only across files; linking the anchored lines is noise.
- **Severity labels** only when there are enough comments that the author must prioritise, or something is a `blocker`. Below that, the consequence sentence carries more weight than a label.
- **Suggested fixes** per `references/fixes.md`, verified against the head SHA before they are shown.
- **Replies** start with their label, then one or two sentences: what changed and where (with the commit sha), the answer, or the rationale with its evidence. Persuade, never dismiss.

### Voice

- No narration of tooling: not "grepped for", not "checked the dump". State the fact.
- No praise before criticism, no closing aphorisms or neat summarising lines.
- Real questions, not rhetorical ones. An `ask` finding names the likely objection.
- Never rank which comments you want answers on. If it was not worth an answer, it was not worth posting.
- Vary the length; some comments are two sentences.
- Non-accusatory on reopened threads: "Codex raised this and the thread's resolved but I can't see a change to X".
- Refer to threads by link and to code by permalink. Labels from the review state (thread numbers like T13, finding numbers, files under `state/`) mean nothing to the author; check the drafts for them before the checkpoint (`rg '\bT[0-9]+\b'`).

## Deduplicate against existing threads

Before showing drafts, fetch the PR's threads and top-level comments (`references/api.md`). For each draft:

- **Same concern already raised** in a thread on the same file within a few lines (or an overlapping range): drop the draft, or turn it into a reply in that thread when it adds new evidence. Say which, with the thread link.
- **Already posted by the user** (same login, same path and line, same body), for example on a rerun: drop it, so nothing is posted twice.
- **Resolved and explained** thread settling the point: drop it, citing the thread.
- **Reply drafts**: if the user already replied in that thread after the last comment, drop the draft unless the user asks for another reply.

Show what was dropped or converted, with links.

## Checkpoint: approval per batch

Mandatory, no exceptions, including for a single comment or a one-line fix. A batch is everything one API write will send: one review in `comments` mode, the set of replies in `replies` mode, or one edit.

Show every draft in full, exactly as it will appear, with its file and line anchor (or thread link) and its suggestion or diff block. Then state what will be posted, as which account (`gh api user --jq .login`), against which SHA, as which review event, and what each fix was verified with and what was not checked. The event follows the content: `REQUEST_CHANGES` when any comment asks for an edit, `COMMENT` when every comment is a question or optional. State it; do not ask. Never summarise a draft instead of showing it.

Approval means the user explicitly says to post this batch. It is not implied by silence, by approval at the triage checkpoint, by an earlier instruction to review the PR, or by an answer to an unrelated question. Ambiguous: ask. Approval covers the whole batch and its stated event; post everything unless the user names exclusions. Any change after approval, whether a rewording, a new anchor, or an added comment, resets it; show the revised batch and ask again. Expect to rewrite: voice takes iterations, and the user is the only judge of whether it sounds like them.

## Posting

Preconditions, checked before any write:

- Every anchor line appears in the PR's diff at the head SHA. The API rejects the whole review if one does not.
- `gh auth status` shows the right account for this repo.
- The head SHA still matches the PR. If the branch moved, re-verify anchors and suggested fixes and show the batch again.

Then post the batch (`references/api.md`): new comments once, as a single review with the stated event; replies one per thread, stopping at the first failure. Afterwards verify that every comment landed under the user's login at the intended place, and report the links.

## Editing what is already posted

Edit in place; never add a follow-up comment correcting yourself. The same approval rule applies to edits. The thread keeps its position and replies.

## Rules

- Never post anything the user has not seen in full and explicitly approved, including edits.
- Never post a finding that has not been through the `review` skill's triage, or a suggested fix that has not been applied and checked against the head SHA.
- The review event follows the content (`REQUEST_CHANGES` when any comment asks for an edit, else `COMMENT`) and is stated at the checkpoint. `APPROVE` only when the user explicitly asks.
- Never resolve a thread on someone else's PR. On the user's own PR, resolve a thread only after its reply is posted and the user said yes for that thread.
- No AI attribution anywhere: no "Generated with", no footer, no thumbs-up prompt. No session references, links or ids in any posted text.
- Report what was actually posted, with the links, and say plainly if anything was refused or failed.
