# Scope `others`: reviewing someone else's PR

Read-only until the user approves comments. Nothing here edits their branch or posts.

## 1. Seed and fetch

```bash
bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json     # head, base, headSha, ticket, author, threads
git fetch origin <base> "pull/<n>/head"                 # refs only; never check out their branch in the user's tree
```

Range: `origin/<base>...<headSha>`. When the repo is not cloned locally, the reviewer reads the PR with `gh pr diff <n>` and `gh api` instead; say so in the report.

## 2. Gather, in parallel

- `gather-context pr <n>`: the heavy bundle (ticket, threads, history, Slack, meetings when gated). Keep the bundle path.
- `gather-context conventions` on the repo, with the areas taken from the PR's files. Their conventions are the standard, not ours.
- `explain <n>`: intent vs the ticket's ACs, the before-state, review thread status, and provisional risks.
- Both `reviewer` passes (thermo and correctness, see `SKILL.md`): the range, the conventions bundle, the ticket's ACs from the context bundle (or "none"), and, as focus, every point already raised in an open thread, so they do not repeat them.
- When the PR touches UI files: the `ui` skill's review step (report only), so `web-design-guidelines` and `impeccable` critique run on the changed screens.

`/simplify` is not run here: it edits the working tree. The reviewer's `simplification` category covers the same ground as a report.

## 3. Triage

Merge the candidates (both reviewer passes, the UI critique, explain risks) into one list, deduplicate by root cause, and run every one through `triage.md`. Then:

- **Dedupe against existing threads.** A candidate an open thread already raises becomes "already raised by @x, still open" (support it in that thread only if you have new evidence). A candidate settled by a resolved and explained thread is dropped, citing the thread.
- **Self-grill each survivor.** Is it my preference or provable? Does it cite a codebase pattern, a written rule, an AC, or a consequence? Would the author's likely objection beat it? Then run `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md` on the whole report.

## 4. Report

Write `report.md` in the output directory and show it. Offer it as a private artifact page.

```markdown
# Review: <owner/repo>#<n> <title> (@<author>, <head sha short>)
Verdict: <request changes | comment | looks good> · Ticket: <key> · Context: <bundle path>

## Intent vs ACs
<from explain: per-AC verdict (covered, partial, missing, contradicted, not judgeable from code), plus Extra>

## Findings (survivors)
| # | Severity | Where | Claim | Shape |
|---|---|---|---|---|
| 1 | blocker | `citations.ts:140` | Deletes before insert, no transaction | assert |
<then one block per finding: evidence, suggestion, what would change this>

## Dropped (casualties)
- <claim> · <test that killed it, with evidence>

## Existing threads
<explain's thread-status table, only rows not cleanly closed>

## Questions for you
- <fact outside the repo that a finding hinges on>

**Grilled** <block>
```

## 5. Comments

Ask what to do next; never chain into posting. Options: draft the survivors as inline comments; raise some as tickets or a direct conversation instead; or stop because nothing is worth raising. When the user picks comments, hand the settled set (`triage.md`), the head SHA and the review event from the verdict (`REQUEST_CHANGES` when any survivor asks for an edit, else `COMMENT`) to `post-pr-comments`, which drafts in the user's voice, verifies every suggested fix, shows the exact batch, and posts only after explicit approval.
