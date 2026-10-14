# Scopes `slice` and `self`

Both review your own work. `slice` runs inside a `pair` checkpoint on one slice; `self` runs on the whole branch before anyone else is asked to look.

## `slice`

1. **Range.** The slice's base and AC ids come from `pair status --json` (the slice branch's parent in the stack). Without pair state, use the base rule in `SKILL.md`. Range: `<base>...HEAD`.
2. **Clean tree.** `git status --porcelain` must be empty. If it is not, stop and say which files are dirty; never stash or discard them.
3. **Simplify.** Invoke the built-in `simplify` skill on the slice diff. It edits the working tree. Show the user each changed file's diff with one line on what it simplifies, and ask which to keep. Accepted changes become their own commits: say "commit through `pair commit`" with `--deviation "from /simplify on slice <n>"`, one commit per coherent change. Rejected changes are reverted only after the user confirms which files (`git restore -- <path>`). Do not continue until the tree is clean again.
4. **Reviewer.** Dispatch the `reviewer` agent on the range (after the simplify commits, so it sees the final code) with the conventions bundle and the slice's ACs only.
5. **AC conformance.** Build the table below from the reviewer's `ac` and `tests` findings plus your own read: each slice AC maps to the code that implements it and the test or manual check that proves it.
6. **Report** grouped the way the pair checkpoint uses them: *fix now*, *follow-up*, *rejected with reason*, each finding with severity, `file:line`, claim and suggestion. Recommend a group for each; the user decides. Accepted fixes become commits through `pair commit` with `--deviation "from review on slice <n>"`; follow-ups go to the ticket or the next slice only with approval.

```markdown
| AC | Implemented at | Proven by | Verdict |
|---|---|---|---|
| AC-2 Draft appears in list | apps/hub/src/items/list.tsx:48 | items-list.test.ts:31 | covered |
| AC-3 Error toast on failure | apps/hub/src/items/create.ts:90 | none (manual in QA) | needs QA |
```

Verdicts: `covered`, `needs QA` (manual verify), `untested`, `missing`, `contradicted`.

## `self`

Whole branch against its base, before the review request. Produce one checklist; every line is pass, fail, or n/a with its evidence. Dispatch the reviewer and `explain` in parallel, then run the mechanical checks yourself.

1. **Base and range.** Use the base rule in `SKILL.md`. Note when the branch is behind its base (`git rev-list --count HEAD..<base>`).
2. **ACs.** Every AC from `spec.ts acs` (or the ticket's ACs when there is no spec) gets a row in the table above, with evidence: a test name and its passing output, a QA verdict from the `qa` report, or a screenshot. "Implemented" without evidence is not covered.
3. **Tests.** List changed source files with non-trivial logic (new branches, loops, data transforms, error paths) and the test that covers each. Missing tests fail unless the user approves an exemption with a reason.
4. **Size.** `bun $CLAUDE_CONFIG_DIR/skills/ship/scripts/pr.ts facts --json` gives the same numbers `ship` uses (net = added minus deleted, lockfiles, generated files, changesets and snapshots excluded). Net over 500 needs an exception explanation in the PR body; propose one, or propose a split through `ship`.
5. **Hygiene, added lines only.** `git diff <range> -U0 | grep '^+[^+]'`, then look for: `console.log`, `console.debug`, `debugger`, `.only(`, `print(` left from debugging; blocks of commented-out code; `TODO` or `FIXME` without a ticket key; and secret-shaped strings (`(api[_-]?key|secret|token|password)\s*[:=]`, `sk-[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`, private key headers). Cite the line; never print a secret's value.
6. **Conventions.** Every `convention` finding from the reviewer is either fixed or listed as an exception with its reason. Planned deviations recorded in commit messages (`Deviation:` lines from `pair commit`) count as listed; any other is a fail until the user gives a reason.
7. **Maintainability.** Reviewer findings across the whole branch (thermo across slices): no open `blocker`, and every `major` fixed or justified.
8. **Cold read.** `explain` on the branch: its Code vs Stated Intent section has no `Missing` or `Contradicts`, and every `Extra` is either intended (say so in the PR body) or removed.
9. **Bots and threads.** Any unresolved review threads (from `gh-activity pr`), including bot findings, are handled through the `feedback` scope: fix, rebut, or defer.
10. **PR body.** If a PR exists, compare its body with the repo's PR template and with what `ship` requires (what, why, how to test, risk, ticket link, AC and evidence table, exceptions). List missing sections and offer to update the body through `ship`. No PR yet (for example when `ship` runs this gate before drafting): n/a, and hand this checklist to `ship` as input for the body.
11. **Reviewer's questions.** Self-grill with `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md`, and add the three questions a reviewer is most likely to ask, each with its answer or "unanswered".

Output template:

```markdown
# Self-review: <branch> → <base> (<head sha>)
Verdict: <ready for review | n failing items>

- [x] ACs covered with evidence (5/5) · table below
- [ ] Tests for non-trivial logic · `create.ts:90` error path untested
- [x] Size: +412 −63, net 349 (≤500)
- [x] Hygiene: no debug leftovers, commented-out code, or secrets
- [ ] Conventions: 1 unlisted exception · `list.tsx:48` local fetch instead of `useItemsQuery`
- [x] Maintainability: no blocker, 1 major justified in PR body
- [x] Cold read: matches stated intent
- [x] Threads: none open
- [ ] PR body: missing "How to test"

<AC table> · <Grilled block> · <reviewer's three likely questions>
```

Offer the checklist as a private artifact page. Nothing is fixed without approval; each accepted fix is a commit through `pair commit`.
