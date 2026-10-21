# Scope `feedback`: comments received on my PR

Every comment is a candidate, not an instruction. Humans and bots are both sometimes wrong, so each one is checked against the code before anything is changed or said. Nothing is fixed, replied to, or resolved without the user's approval.

## 1. Collect

```bash
bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json      # threads.items: isResolved, isOutdated, path, line, comments[{author, body, createdAt, url}]
gh pr view <n> --json comments,reviews                   # top-level comments and review bodies, which the script does not return
```

Take every unresolved thread, every outdated thread whose concern may still apply, and every top-level comment or review body that asks for something. Skip threads the user already answered unless the reviewer replied after them. Note each item's age: the reply target is within 24 hours of the comment, so flag anything older.

A comment's numeric id (needed to reply) is the number after `#discussion_r` in its `url`.

## 2. Verify each item

Read the current code at the commented lines at the PR head, not the snippet in the comment (the code may have moved). Then apply the tests in `triage.md`: is the claim true, is it this PR's problem, does it hurt, is it fixable. Bot comments (codex, bugbot, copilot) are the lowest trust; check them hardest.

Classify each item into exactly one:

| Class | Meaning | Default action |
|---|---|---|
| `valid` | The claim holds at the cited code. | Fix in this PR, or defer to a ticket when it is out of scope (with the user's OK). |
| `invalid` | The claim is wrong, or follows a repo convention, or the PR improved on its baseline. | Reply with the evidence. |
| `question` | The commenter asks something, or the trade-off is genuinely open. | Answer it; propose a change only if the answer exposes one. |

Every `invalid` carries evidence: a `file:line`, the convention and its source, a count, or a quote. "I disagree" is not evidence.

## 3. Propose

For each item, show: the comment (quoted, with its link), the class, the evidence, and a draft reply that starts with one of the labels:

- `Fixed in <sha>:` what changed, in one sentence. The sha is filled in after the fix commit exists.
- `Discussed:` the answer to a question, or the agreed outcome (including "follow-up in <ticket>").
- `Won't Fix:` the rationale with its evidence, written to persuade, not to dismiss.

Then the fix plan for the `valid` items: one commit per coherent fix, each through `pair commit` with `--deviation "review feedback from @<login>"`, and the check that proves it. Group related comments into one commit only when the fix is the same change.

Write the replies in the user's voice, following `post-pr-comments` (no tool narration, no praise sandwich, no AI attribution).

## 4. Act, in order, each step only after approval

1. The user approves or edits the classification and the fix plan.
2. Fixes land as commits (through `pair`, or directly when pair is off, still atomic and with a rationale body). Run the repo's checks. Push after the account check from `ship` (`git push --no-verify`).
3. Fill the commit shas into the `Fixed in` replies and show the final reply set.
4. Hand the approved replies to `post-pr-comments` in reply mode. It posts them and verifies they landed.
5. Resolving a thread is a separate yes or no per thread, asked after the reply is posted. Many teams want the commenter to resolve; when unsure, ask the user.

Report: each item with its class, the action taken, and links to the replies and commits. Anything left open is listed with why.
