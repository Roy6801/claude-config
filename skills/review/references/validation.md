# Validation: which findings become comments

Review passes and bots produce candidate findings cheaply and unreliably. Validation verifies each candidate against the code at the head SHA; it reads code to test a claim, and a new problem found on the way enters as another candidate facing the same tests.

## The tests

A candidate survives when every test holds, each with its evidence inline: a `file:line`, a convention with its call sites, a quote, or the output of a scratch script run outside the repo.

- **True:** the behaviour happens at the head SHA. Where a function decides the outcome, run it over real input rather than reasoning about how it reads.
- **This PR's:** the PR caused it. Grep for the pattern first: a convention with many call sites is a decision, and a baseline that already does the same or less means the PR improved on it.
- **Unsettled:** the PR description, a code comment or a thread has not already answered it. A resolved thread with no reply counts as considered; a different fix in the same commit usually means the author solved it their way.
- **Consequential:** someone reaches the path and the bad state stays bad. Trace the actual consumer (the fallback, the join, the default) and state the consequence at its true size: stale is not lost, recoverable is not irreversible.

## Shape

- Fold candidates that share a root cause into one comment, carrying the strongest evidence.
- Deduplicate against open threads per `posting.md`.
- Assert what the evidence proves. Ask when a fact outside the repo decides it, or a structural blocker (a constraint, a missing endpoint, an API shape) rules out the obvious fix.
- Keep the severity the pass gave, on the scale in `$CLAUDE_CONFIG_DIR/skills/thermo/references/findings.md`. Mark a finding with no convention, rule, AC or consequence behind it `preference`.

## Record in `comments.md`

- Each survivor: claim with its anchor, evidence, severity, assert or ask, the text to quote, and anything folded into it.
- Each drop: the claim and the test that dropped it, with its evidence, so the user can bring it back.
- The head SHA validated against. An empty survivor list is a good outcome.
