# Posting comments and replies

Used by `review` for comments and edits on someone else's PR, and by `review-fix-loop` for replies on the user's own PR.

## Batches

A batch is everything one approval covers and the API calls in `api.md` send:

- **Comments** (`review`): validated findings (`validation.md`), posted as one review: inline comments plus an optional summary body.
- **Replies** (`review-fix-loop`): one reply per thread on the user's own PR, each starting with its label (`Fixed in <sha>:`, `Follow-up in <ticket>:`, `Discussed:`, `Won't Fix:`).
- **Edit** (`review edit`): an in-place edit of one posted comment, review body or top-level comment.

## Drafting

One comment per finding, anchored to the lines it is about; small items get their own comments too. Add a summary body only when the list is long enough to need an overview.

- **Quote the source verbatim.** A blockquote of the AC, the PR description line or the convention is shorter than describing it and settles the point. When the PR description contradicts the code, quote the description line and put the correction underneath.
- **Link properly.** Tickets in the form the repo already uses (take it from the PR body). Code in other files as SHA-pinned permalinks, `https://github.com/{owner}/{repo}/blob/{sha}/{path}#L{start}-L{end}`; the anchored lines are already in view.
- **Severity labels** only when there are enough comments that the author must prioritise, or something is a `blocker`. Below that, the consequence sentence carries the weight.
- **Suggested fixes** per `fixes.md`, verified against the head SHA before they are shown.
- **Replies** start with their label, then one or two sentences: what changed and where (with the commit sha), the answer, or why it stays as is, with its evidence.

### Voice

The user's voice is in CLAUDE.md. On top of it:

- Humble, like a regular colleague, on any PR: acknowledge a right point plainly ("Good catch.", "You're right, this was off."), own a mistake without over-apologising, state a concern or a reason directly and respectfully, and stay open to the other view. Leave out selling and gratitude formulas: never thank a bot, and thank a person only when something genuinely earns it.
- State facts directly, without the tooling that found them.
- An `ask` finding names the likely objection.
- Post only comments worth an answer, unranked.
- Vary the length; some comments are two sentences.
- On a reopened thread, describe what you see neutrally: "Codex raised this and the thread's resolved but I can't see a change to X".
- Use only names the author knows: threads by link, code by permalink. Check the drafts for internal labels such as thread or finding numbers before the checkpoint (`rg '\bT[0-9]+\b'`).

## Deduplicate against existing threads

Before showing drafts, fetch the PR's threads and top-level comments (`api.md`). For each draft:

- **Same concern already raised** in a thread on the same file within a few lines (or an overlapping range): drop the draft, or turn it into a reply in that thread when it adds new evidence.
- **Already posted by the user** (same login, path, line and body), for example on a rerun: drop it.
- **Resolved and explained** thread settling the point: drop it, citing the thread.
- **Reply drafts**: when the user already replied in that thread after the last comment, drop the draft unless the user asks for another reply.

Show what was dropped or converted, with the thread links.

## Checkpoint: approval per batch

Every batch is approved on its own, a single comment or one-line fix included.

Show every draft in full, exactly as it will appear, with its file and line anchor (or thread link) and its suggestion or diff block. Then state the account it posts as (the active `gh` login, `gh api user --jq .login`), the head SHA, what each fix was verified with and what was not checked, and, for a review, its event:

- `REQUEST_CHANGES` when any comment asks for an edit.
- `COMMENT` when every comment is a question or optional.
- `APPROVE` only when the user asks for it.

Approval is the user's explicit yes to this batch after seeing it; when unsure, ask. It covers the whole batch and its stated event; post everything unless the user names exclusions. Any change after approval (a rewording, a new anchor, an added comment) resets it: show the revised batch and ask again.

## Posting

Post only the exact batch the user approved. Preconditions, checked before any write:

- Every anchor line appears in the PR's diff at the head SHA; the API rejects the whole review otherwise.
- The active `gh` login is the user's account for this org (reviewing needs no push access); on a mismatch, stop and show both with the switch command.
- The head SHA still matches the PR. When the branch moved, re-verify anchors and suggested fixes and show the batch again.

Then post per `api.md`: comments once, as a single review with the stated event; replies one per thread, stopping at the first failure. Resolve a thread only on the user's own PR, after its reply landed and the user said yes (one "Resolve all" covers every listed thread); threads on someone else's PR are theirs to resolve. Afterwards verify that every comment landed under the user's login at the intended place, and report the links and anything refused or failed.

## Editing what is already posted

Correct a posted comment by editing it in place, so the thread keeps its position and replies. Draft the new body under the same Drafting and Voice rules. The anchor stays fixed on an edit, so a suggestion block can replace only the lines the comment is already anchored to; anything wider goes in as a `diff` block.
