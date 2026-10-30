---
name: qa
description: Browser QA of a PR against its roadmap scope and requirements, with one case writer and parallel testers; failures are reported with their reproduction.
disable-model-invocation: true
metadata:
  origin: local
---

# QA

- `/qa #<number>` or `/qa <slug> <pr-name>`: QA one PR. From `ship`: QA ship's branch, using ship's `brief.md`.
- Cases come from the roadmap's PR entry, the scope, the requirements (the PR plan, else the ticket) and the diff.
- Output in the PR folder (`~/roadmaps/<project>/<slug>/prs/<pr-name>/`; for a PR outside any roadmap, `~/roadmaps/<project>/pr-<number>/`): `qa-cases.md`, `qa.md`, `evidence/`.

## Rules

- **Browser:** every tester starts in `claude-in-chrome`, one tab each, at most 3. Testers beyond 3 start in `agent-browser`; on opening the URL, one that meets a sign-in hands its cases back to a `claude-in-chrome` tester.
- **Sign-in walls:** per CLAUDE.md's Browser section. Still blocked: stop every tester and tell the user who is blocked on what.
- **Real runs only:** every verdict comes from a browser run. A tester that cannot run a case reports it blocked.
- **Failures:** a failure counts when it reproduces 2 of 2 times; anything less is reported uncertain.
- **Evidence:** as cases run, capture before and after per `$CLAUDE_CONFIG_DIR/skills/ship/references/evidence.md`; a GIF for each failure and for the main flow.
- **App:** use the URL in the brief or from the user. Otherwise start the app with the repo's dev script; when its port is taken, start it on a free port (the script's port flag or `PORT`). A taken port never blocks QA.
- **Data:** cases set up their data through the UI; a state the UI cannot create becomes a data request for the user.

## Chief of staff

- Read `$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md` and run as chief of staff.
- Every subagent writes into the PR folder, and returns at most 150 words.
- Agent entries read `type · model · effort`: task → output.

### Dispatch plan

1. **Start** (sequential)
   - From ship: use ship's `brief.md`. On a PR: resolve the roadmap and PR folders from the PR's branch; read the requirements, the roadmap entry, the scope and `git diff <merge-base>`.
   - Get the app running and its URL, per the App rule.
2. **Cases** (sequential)
   - `general-purpose · sonnet · high`: write `qa-cases.md`, one line per case (starting state, steps, expected):
     - Requirement cases, at least one per requirement.
     - Edge cases: boundaries, odd inputs, combinations, neighbouring behaviour the diff touches.
     - Diff touches UI: loading, error and empty states; accessibility per the repo's conventions, with `accessibility` and `web-design-guidelines`.
     - Diff touches permissions or auth: permission and auth cases.
     - Drop duplicates and group cases that change the same data into shares, one share per tester.
   - Show the case list to the user in one message and start.
3. **Run** (parallel)
   - `tester · sonnet · high`, one per share: run the share per the Rules; write results and evidence into `qa/<share>.md` and `evidence/`.
   - Gate: every case is pass, fail (2 of 2), uncertain or blocked.
4. **End** (sequential)
   - `general-purpose · haiku · low`: merge the share results into `qa.md`: verdict per requirement, then each case.
   - Tell the user: the verdict per requirement, then each failure with its reproduction, then uncertain and blocked cases, then the path to `qa.md`.
