---
name: debug
description: |
  Root-cause debugging on top of the upstream `diagnosing-bugs` discipline (feedback loop first, reproduce and minimise, ranked falsifiable hypotheses, one-variable probes, regression test, cleanup). Adds incident context (Sentry, Braintrust, Slack, GitHub issues through `gather-context incident`, when connected), routing to the right evidence source (browser, Sentry or Vercel, Braintrust or LangSmith, `scout` for library source, issues and releases), a running `debug.md` in the initiative directory, data requests instead of database access, a self-grilled fix that lands through `pair`, and a write-up for others when the fix lands.

  Use when: something is broken, throwing, failing, flaky or slow; a `qa` run hands over a failing or uncertain case; a Sentry issue, alert or bug report needs a root cause; or asked to "debug this", "diagnose", "why is X failing", "find the root cause", or `/debug [sentry id|issue|"symptom"]`.
user-invocable: true
metadata:
  origin: local
---

# Debug

Find the cause, not a cure for the symptom. The method is upstream: read `$CLAUDE_CONFIG_DIR/skills/diagnosing-bugs/SKILL.md` in full and follow its phases in order (it cannot be invoked as a skill). This skill adds the inputs, the record, the routing and the outputs around it. Never jump to a hypothesis before the feedback loop exists; that is the failure the upstream skill prevents.

## The record: `debug.md`

Run `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json`. When no initiative is active, offer `work.ts new debug-<short-symptom> --title "<symptom>"`; the record needs a home that survives compaction. Keep `<initiative dir>/debug.md` (template in `references/debug-log.md`) current as you go, not at the end: symptom, evidence with links, the feedback loop command, hypotheses with predictions, what was ruled out and why, and the next check. Several bugs in one initiative get `debug-<topic>.md` each. Log real decisions (which hypothesis to chase when the user re-ranks, fix approach) with `work.ts decide`.

## Flow

1. **Symptom.** Write the user's exact symptom into `debug.md`: what was expected, what happened, where, since when, how often. A `qa` handoff brings its reproduction report; use it as the first feedback-loop candidate.
2. **Context.** For a production or reported issue, run the `gather-context` skill in `incident` mode (Sentry id or URL, or the description); it gathers Sentry, Slack and GitHub issues, plus Braintrust for agent or model failures, from whichever sources are connected. Read the bundle's Summary and Timeline, and copy each relevant item with its link into Evidence. Check recent changes on the suspect paths (`git log --since`, merged PRs) through an agent.
3. **Feedback loop (upstream Phase 1).** Build the tight, red-capable loop and record the exact command and its red output in `debug.md`. When no loop can be built, stop and say so, as upstream says.
4. **Route for evidence.** Pick the source that matches where the bug lives, through agents, and record each finding with its link:
   - UI: the browser per CLAUDE.md "Browser Automation" (console, network, DOM).
   - Production: Sentry (events, traces, breadcrumbs) and Vercel (runtime logs, deployments).
   - Agents, prompts and models: Braintrust or LangSmith traces.
   - Libraries: the `scout` skill in `debug` mode, for the library's source at the installed version, matching open and closed issues, and release notes. Never trust memory of a library's behaviour over its source.
5. **Reproduce, minimise, hypothesise (upstream Phases 2 and 3).** Write 3 to 5 ranked, falsifiable hypotheses into `debug.md`, then run the self-grill checklist (`$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md`) on the ranking and show the user the ranked list with the Grilled block. Do not block if the user is away.
6. **Instrument (upstream Phase 4).** One variable per probe, tagged `[DEBUG-xxxx]` logs. After each probe, move the hypothesis to Ruled out (with the evidence) or keep it, and update Next check.
7. **Data.** Never query, migrate or script a database, not even read-only. When a fact lives in data, write a data request (format in `references/writeups.md`) for the user to run, record it in `debug.md`, and wait for the answer.
8. **Fix.** Self-grill the proposed fix with one extra question first: "does this fix the cause or hide the symptom?" Show the root cause, the fix, its blast radius and the regression-test seam (upstream Phase 5) as options with a recommendation; the user approves. The fix then lands through `pair`: a small fix is a single planned commit (regression test first where a correct seam exists), a larger one gets its own slice plan. Never commit a fix outside `pair`.
9. **Close (upstream Phase 6).** Re-run the original loop, remove every `[DEBUG-` tag (grep it), set `debug.md` Status to `fixed` with the commit, and re-dispatch `qa` re-verification when the bug came from QA.
10. **Write-up.** When the fix lands, draft the SOAP write-up from `references/writeups.md` for whoever needs it (the Linear ticket through `ticket` when Linear is connected, a GitHub issue comment, or the PR body through `ship`). Show the exact text; post or update only after the user approves.

## Long sessions

Debugging piles up evidence. When the context gets long mid-debug, make sure `debug.md` is current, then run the `handoff` skill and choose compact with a focus line such as "keep hypotheses, evidence and ruled-out causes; record at <path to debug.md>". After compaction, read `debug.md` again before the next probe. Hand off to a fresh session only once the fix is planned.

## Rules

- Upstream phases in order: no hypothesis before a red-capable loop, no fix before a reproduction.
- Every evidence item in `debug.md` carries a link, a command with its output, or a `file:line`.
- Never touch a database or read `.env` files. Data needs become data requests.
- The fix goes through `pair` after the user approves it; debug never commits on its own.
- Tickets, issues, comments and PR text are created or changed only after the user approves the exact content.
- Write hypotheses, the root cause and the write-up in full, clear sentences.
