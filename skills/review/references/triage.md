# Triage: which findings survive

Machine passes (the `reviewer` agent, `thermo`, `explain` risks, the built-in `code-review`, bots such as codex or bugbot) produce candidate findings cheaply and unreliably. A human comment on your own PR is a candidate too: it may be wrong. The user owns what gets said or changed. Triage is the loop between those two, and the measure of a good run is how many candidates die. On the run this was built from, ten candidates produced four comments, and three of the five drops came from the user pushing back.

Treat every candidate as low trust, and never present it in the same register as post-triage output. Triage reads code to test a claim, not to find new ones. If a genuinely new problem surfaces while investigating, it enters as another candidate and faces the same tests.

Before triaging, pin the head SHA and read the diff.

## The tests

Run the checks reachable from the repo before writing a single confident sentence.

**Is the claim true?**
- Test it against real behaviour, not against what the code looks like it would do. Where a function decides the outcome, port it and run it over real input (a scratch script outside the repo) rather than reasoning about it.
- A claim about what rows or records contain is a fact from data: write a data request for the user. Never query a database.
- State what the evidence cannot tell you. A skewed sample does not support a rate.

**Is it this PR's problem?**
- Find the repo convention before calling something a bug. Grep for the pattern elsewhere. A named helper with many call sites is a decision, not an oversight.
- Compare against the baseline the PR inherited. If the surrounding code does less, the PR improved on it, and flagging the gap asks the author to fix something they made better.
- Check whether the concern is already disclosed in the PR: dialog copy, a comment, or the description.

**Did the author already decide this?**
- Treat a resolved thread with no reply as considered and rejected until proven otherwise.
- Look for what the author did instead of what was asked. A different fix in the same commit usually means they understood the problem and solved it their way.
- Check the canonical helper or the documented convention before concluding they got it wrong.

**Does it actually hurt?**
- Can the affected population reach the code path? If not, skipping it is behaviour, not a defect.
- Is the bad state self-correcting, or repairable by something that already exists?
- Trace the actual consumer before claiming a change breaks it: the fallback, the join, the default.
- Grade the consequence honestly. Stale is not lost. Recoverable is not irreversible.

**Is it fixable?**
- Look for the structural blocker before proposing a fix. A constraint, a missing endpoint, or an API shape can make the obvious suggestion impossible, which turns the comment from a request into a question.

**Does anyone have a reason to care?**
- Connect it to a task someone performs. A reporting gap is tidiness until it blocks a workflow the ticket says stays manual; then it is a functional gap.

**Preference or provable?**
- A finding that rests on taste, with no codebase pattern, rule, AC or consequence behind it, is a preference. Drop it, or keep it only as an explicitly optional nit.

**What shape does it survive in?**
- Fold weakened findings into stronger ones rather than raising both.
- Ask where uncertain, assert where not.
- Re-examine your own earlier conclusions when new evidence lands, not only the inherited ones.

## The finding record

Every candidate, alive or dead, carries:

- **Claim**: one sentence, with `file:line`.
- **Disposition**: raise, fold into another finding, ask, or dropped (for feedback on your own PR: fix, rebut, defer, or answer).
- **Cause**: the test that decided it, with the evidence inline: a file and line, a convention, a count, or a quote. Never a bare confidence label.
- **Severity**: survivors only, on the scale in `$CLAUDE_CONFIG_DIR/skills/thermo/references/findings.md` (`blocker`, `major`, `minor`, `nit`), recommended with its reasoning; the user accepts or changes it.
- **What would change this**: the specific fact that flips the verdict, and whether it is reachable from the repo. Reachable facts are fetched now; the rest become questions for the user.

Severity is independent of validity. A `blocker`-grade claim can still be dropped as someone else's problem.

## The checkpoint

Present, in one message:

- **Survivors**, each with claim, evidence, recommended severity and reasoning, and shape (assert or ask).
- **Casualties**, each with the test that killed it. Never cull silently; the user cannot catch a bad drop they never saw.
- **Questions**, batched, covering everything that hinged on a fact outside the repo. Ask in prose; most are factual.

While waiting, do everything that does not depend on an answer. The user can resurrect any casualty, overrule any severity, and add findings the pass missed.

## The settled set (handed to `post-pr-comments`)

Each entry: claim with the `file:line` to anchor to; severity confirmed by the user; shape (assert or ask); the text to quote (the AC, the PR description line, or the convention); references (ticket keys, code paths worth linking); and anything folded into it. Hand over the head SHA the triage was done against, since the anchors are valid only for that commit. An empty set is a good outcome, not a failed run.

## Worked example

From a bulk-action feature PR:

- **Raised, blocker.** A citation replace that deleted before inserting, with two retry attempts, so a persistent backend error lost the originals. It survived because no unique constraint blocked the insert-first fix. The AC asking for the opposite was quoted in the comment.
- **Raised, major.** A completion toast counting skipped items as successes. Weak until it was connected to a rescue pass the ticket says stays manual.
- **Dropped.** A server permission check that verified project membership only. A named helper with 32 call sites showed membership was the convention, and every sibling action had no check at all: the PR improved on its baseline.
- **Dropped.** An author lookup not scoped to tenant. The author had added a different filter, and the canonical resolver's docstring specified exactly that filter for this class of caller.
- **Dropped.** A write guard that checked version but not status. It hinged on whether publishing bumps the version, which lives outside the repo; the user answered in one line and the finding died.
- **Folded.** Items whose correct answer lives in a different field came back skipped. Real, but those item types have no citable answer, so it became a paragraph in the reporting comment.
