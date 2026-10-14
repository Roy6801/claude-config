# Size budget

A PR stays at or under **500 net lines** (`size.net` from `pr facts`: added minus deleted, with lockfiles, generated files, changesets and snapshots excluded). Tests count, since a reviewer reads them. The same budget is the pair slice budget, so a planned slice that kept its plan fits.

Net lines hide churn: a rewrite of 600 lines in place nets 0. When `size.added` is far above 500 even though `net` fits, say so in one line and ask whether the reviewer would be better served by a split.

## Over budget: stop and offer two options

Show the numbers (`files`, `added`, `deleted`, `net`, `excluded`) and the biggest files (`git diff --numstat <base.ref>...<headRef> | sort -rn | head`), then offer:

1. **Split (recommended unless a reason below applies).** Group the diff into layers bottom to top: shared types, helpers and refactors first, then the behavior built on them, then the UI. Tests ride with the code they cover. Every layer fits the budget, builds, and passes its own tests. Show each layer with its file count and net lines.
   - With a roadmap: this is a roadmap change. Hand it to `/brainstorm resume <slug>` to split the PR into stacked PRs; the change goes to the user. Never split silently at ship time.
   - Without a plan: optionally propose one GitHub issue per extra layer (referencing the original issue, titles naming the behavior), branches named with `br name`, and a stack plan for `br stack` (`--dry-run` first). Reuse the existing commits per layer; never rewrite the code from scratch. Each step needs its own yes.
2. **Exception.** Keep it whole when splitting would hurt the reviewer: one atomic migration, a mechanical rename, vendored or generated code that the exclusion patterns miss, a revert. Draft the reasoning for the body's Exceptions section ("<net> net lines because <reason>; a split would <cost>") and get the user's approval of that text.

The user decides. Record the decision with `bun $CLAUDE_CONFIG_DIR/bin/work.ts decide - --title "PR size" --chosen "<split|exception>" --why "<user's words>"` when an initiative is active.
