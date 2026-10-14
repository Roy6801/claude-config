# Explain: output sections

Plain language. A reader who did not write this code should follow it.

- No jargon without a plain-English gloss on first use.
- Every claim anchored to `path/to/file.ts:42` or a short snippet (under about 10 lines, deciding lines only).
- Never paste whole functions or whole diffs back.
- "No findings" beats padding. Omit a section that has nothing to say, and say so in one line.

## Background Context

What existed before, and why it is changing. Two bullets at most per item, each attributed and dated.

```markdown
- **Before:** Citation prompts were inlined as string literals in the agent file, one copy
  per agent. `packages/agents/src/citations.ts:40` on `staging`; that shape dates to `146e0b4`.
- **Why it changed:** Issue #615 says prompt edits needed a redeploy, so non-engineers could not
  touch them. [#615]
- **Decided:** Slack #ai-eng, 12 Sep, move prompts to Mastra prompt blocks rather than a DB
  table, because the DB option needs a migration per tenant. [thread]
- **Not found:** no recorded rationale for keeping the legacy fallback path.
```

- Attribute every line: ticket key, commit sha, doc title, or thread link. Unattributed background is speculation; cut it.
- Link, do not transcribe. Private chat, doc and meeting content stays one summarized line plus the link.
- Date anything that could be stale, and say so if the source predates the branch by months.
- Contradictions between a source's plan and the code go to Code vs Stated Intent, not here.

## Intent

- What this is trying to accomplish, one or two sentences, in user-visible terms.
- Where that intent came from (spec, ticket, PR body, or commits only).
- If intent is only inferable from code, say so. Do not invent a rationale.

## Summary of Changes

Grouped by behaviour, not by file.

```markdown
- **Regeneration now respects permissions.** A caller without write access gets a 403
  instead of a silent no-op. `apps/hub/src/server/citations.ts:88`
```

Call out separately when present: new dependencies, schema or migration changes, config or env changes, deleted files, renames, feature flags.

## Intent vs ACs

One row per acceptance criterion, from the spec (`spec.ts acs`) or, without a spec, from the ticket. Skip the section when there are no ACs, and say "no acceptance criteria to compare against".

```markdown
| AC | Verdict | Code | Test |
|---|---|---|---|
| AC-1 Admin can create a role | covered | `roles/create.ts:31` | `roles.test.ts:12` |
| AC-3 Duplicate name shows an error | missing | none | none |
```

Verdicts: `covered` (code and a test), `implemented, untested`, `partial` (say what is missing), `missing`, `contradicted` (quote the AC and cite the code), `not judgeable from code` (needs QA or data). Then list **Extra**: behaviour in the diff that no AC asks for.

## Code vs Stated Intent

Compare the claims from the PR body, the ticket text outside the ACs, and any decision found in background against what the diff does. Each item lands on one verdict:

- **Matches**: claim backed by code (cite it).
- **Missing**: claimed, not in the diff.
- **Extra**: in the diff, not claimed (scope creep, drive-by fixes).
- **Contradicts**: code does something different (cite the claim text and the code).

No PR body, no ticket, no recorded decision: say "No stated intent to compare against" and skip. Do not manufacture a conflict.

Convention counts as unstated intent. A departure from an established pattern found in the conventions step belongs here as drift, since the repo asserts it by repetition. Following the pattern is not drift.

## Review Conversation Status

Table first, then detail only for anything not cleanly closed.

```markdown
| Thread | Raised by | Status | Reason given |
|---|---|---|---|
| `citations.ts:88` permission gate | @reviewer | Resolved, explained | Fixed in `6aaaae3` |
| `regenerate.ts:140` no transaction | @reviewer | Unresolved, answered | Author: "follow-up issue #620" |
| `types.ts:12` naming | @reviewer | Resolved, unexplained | None. No reply, no commit on this file. |
```

Then, in bullets, every Unresolved, no reply and every Resolved, unexplained thread, with the original comment quoted and the current state of that code. No threads: say "no review comments yet".

## Risks and Impact

One block per risk, never a bare list. Use the before-state: a risk is sharper when the old path handled the case and the new one does not. Check every candidate against the conventions step first: if the code follows the repo's convention, or the surrounding cases do less than this PR does, it is not this PR's risk; leave it out or say plainly that it is pre-existing and repo-wide.

Every risk carries a **provisional** severity on the shared scale in `$CLAUDE_CONFIG_DIR/skills/thermo/references/findings.md` (`blocker`, `major`, `minor`, `nit`). Provisional, because nothing here has been triaged; never drop the word. The `review` skill's triage validates them before anything is raised with the author.

```markdown
- **Risk (provisional: major):** Regeneration writes without a transaction.
  `apps/hub/src/server/citations.ts:140`
  **Impact:** A crash mid-run leaves half the citations updated; the UI shows a mixed
  state until the next run.
  **Likelihood and blast radius:** low frequency, tenant-wide when it hits.
  **What would change this:** whether the backend exposes a transactional or bulk endpoint.
```

`What would change this` is the fact that flips the verdict, and whether it is reachable from the repo. Anything that hinges on a service or decision outside this codebase is a question, not an assertion.

Sweep for: destructive writes, auth or permission gaps, secrets or PII in logs, N+1 and unbounded queries, silent catches, breaking API or type changes for callers, migration backward compatibility, flag defaults shipping on.

## Reviewer Hotspots

Three to five places to look first, ordered, with why.

## Verification Gaps

- What the tests in this diff cover.
- What behaviour changed with no test.
- Concrete manual steps for the risky paths.

## Open Questions

Genuinely unresolved things, directed at the author. Fold in every unanswered review thread. No filler.
