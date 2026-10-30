# Prompts

Adapted from the loop run on 2026-10-29. Fill the angle brackets; every agent reads `brief.md` first.

## Requirements and HLD check

> You are the requirements and HLD check of round <n> of <N>. Read <brief.md>, then the requirements and `hld.md` it points to. Review `<diff command>` read-only. For each requirement, find the code that delivers it, or name the gap. Flag behaviour in the diff that no requirement asks for (scope creep). For each place the code and the HLD disagree, judge which one is wrong, with file:line evidence: the code (a fix), the HLD (a correction), or a deviation this PR needs (with why). Write findings to <round>/review/requirements-hld.md: id, kind (gap, scope-creep, code-wrong, hld-wrong, deviation), severity (blocker, major, minor, nit), file:line, claim, evidence, suggested fix or HLD note, confidence. Return at most 150 words: counts by kind and severity, one line per blocker or major.

## Thermo

> You are the thermo review of round <n> of <N>. Read <brief.md>. Run the `thermo` skill on `<diff command>` read-only, against the repo's conventions. Write findings to <round>/review/thermo.md with id, severity, file:line, claim, evidence, suggested fix, confidence. Leave out what the brief lists as settled. Return at most 150 words: counts by severity, one line per blocker or major.

## Validate and plan

> You are the planning step of round <n> of <N>. Read <brief.md>, every file in <round>/review/, and the queued threads. Re-verify each finding against the code yourself; reviewers can be wrong. Sort each into fix, skip (wrong, out of scope, or settled, with the reason) or collision (leaves the scope, breaks the size budget, or changes a contract other planned PRs depend on; name what it collides with). For each fix, give two options with trade-offs and mark one Recommended; the recommended pick is pre-approved. For each HLD correction or deviation, write the dated note for `hld.md`. For each thread that raised a real point, a person's or a bot's, draft the reply per `$CLAUDE_CONFIG_DIR/skills/review/references/posting.md` (Drafting, Voice), whether it is fixed, skipped, discussed, folded or stacked; bot summaries and noise get none. Then write atomic commits for an implementer with no context: conventional title in plain language, a one or two sentence description of the change, the exact files, the precise change, the test and what it asserts (failing without the change), and the check. Prefer disjoint files; where commits share a file, say which hunks belong to which. Return the whole plan in sections Decisions, Collisions, HLD notes, Replies, Commits, followed by a summary of at most 150 words. In the Final pass, write only Decisions and Collisions; its findings go to the user.

## Decider

> You decide the collisions of round <n>. Read <brief.md>, <round>/plan.md (its Collisions section), `hld.md`, the PR list in `roadmap.md`, and `<diff command>`. For each collision, decide: fold (this PR stays within the brief's size budget and the fix touches only parts this PR already changes) or stack (everything else). A fix this PR's own requirements need is always fold. For a stack, name the ticket relation to this PR's ticket (sibling when it is parallel work, child when it is part of this PR's work) and the findings that move. This PR has <k> of its 2 stacked PRs already; past that, assign the collision to an existing stacked PR whose scope fits, else mark it for the user. Return one line per collision: decision, target, reason; then a summary of at most 150 words.

## Fix

> Read <brief.md> and <plan file> (a round's `plan.md`, or the PR's `plan.md` from ship). Implement only commit <k>, exactly as planned: the planned files only, matching the surrounding style, following the skills the commit names. Show the new test failing without the source change and passing with it; run the brief's checks. Leave staging, committing and branches to the caller. If the plan is wrong or impossible, stop and say why. Return at most 120 words: files, fail-then-pass evidence, check results.
