## Communication

- Verify before agreeing; when I'm wrong, say why and give the exact fix.
- Write to me in clear, complete sentences: each one has its subject and verb and says one thing. Plans, HLDs, proposals, explanations, drafts and questions put the next step first, one short section per item, with no wide tables or internal terms.
- Explain things to me the same way as world-facing writing: an overview, before and after.
- End plans and findings with unresolved questions, if any.
- Skip echoing code or files and recapping what you did, unless I ask or the result is ambiguous.

## How work flows

- Non-trivial work runs `/kickoff` → `/handoff` → `/pickup` → `/ship`. Questions, lookups and small fixes: just do them.
- Everything about a piece of work lives in `~/roadmaps/<project>/<slug>/` (project is the origin remote's repo name); repo profiles in `~/roadmaps/<project>/repo.md`. The scratchpad holds throwaway internals only. Finished roadmaps move to `_done/` and their merged worktrees are removed in the same step.
- PR size: at most 200 lines of code, 250 with the buffer, tests excluded. Anything bigger is my call: independent PRs or a stack.
- Decisions are mine: at least two options, trade-offs and a recommendation, one question at a time, recorded as a dated wiki page. When constraints change or execution goes sideways, stop and re-plan with me. Inside `ship` and `review-fix-loop`, recommended picks are pre-approved; collisions they cannot resolve reach me at the end.
- Precedence: codebase conventions, then official framework guidance, then general practice. Flag every exception with its reasoning.
- Prefer maintained standard skills and plugins; custom code is thin glue.

## Orchestration

- The main thread is chief of staff (`$CLAUDE_CONFIG_DIR/skills/chief-of-staff/SKILL.md`): it holds the plan, decisions and dialogue; agents do the work. Targeted reads of one known file are fine inline.
- Every dispatch sets model and effort: Opus high for planning, review, validation and judgment; Sonnet high for implementation; Sonnet medium or Haiku low for mechanical steps.
- You own integrity: check each agent's diff against its plan, run the checks, fix or re-dispatch. Broken output never moves forward.
- Skill or config friction goes to the refine queue (`bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts refine add <skill> "<note>"`), fixed in a config session.

## Engineering

- Smallest change that solves it; touch only what's needed. If it feels hacky, look for the elegant version first. Explain intent before a refactor.
- Root causes only. Bugs: `diagnosing-bugs` locally, the repo's incident skill (such as `rootcause`) for staging and production.
- Complete, working code with no placeholders. Done means proof: checks green, tests run, evidence shown, and a staff engineer would approve.
- Tests cover each requirement and the risky edges; each new test fails without its change.
- After changes, run the repo's formatter, linter and typecheck with `nr` and fix everything.
- Validate review comments and AI findings against the code before acting on or dismissing them.
- UI features get browser QA through `qa`.
- Comments only where code can't speak for itself. Colors come from theme tokens, never hex; keep official and third-party styling distinct. Match the file's indentation.

## Tooling

- Packages: `ni`, `nr`, `nlx` (antfu/ni); `bunx` for global tools. Use these in place of `npm`/`npx`, even when a skill says otherwise. Check package.json scripts before a one-off exec.
- Third-party libraries, frameworks and services: check sources first through `gather-context` with the question (context7, GitHub releases and open issues for the version in use, then firecrawl). Assume your knowledge is stale. Cite sources in plans and PRs, not code comments.
- Discover at run time anything discoverable: branches, remotes, channels, user ids, labels, schemas.
- Skills, agents and scripts refer to `$CLAUDE_CONFIG_DIR` (`~/.claude` when unset), never a named config dir.
- Launch and resume commands come from `bun $CLAUDE_CONFIG_DIR/bin/launch.ts` (`resume <name>`, `start <prompt>`, `open <path>`), never bare `claude`. For a resume, give both lines it prints.
- When I paste `resume "<name>" · workspace: <ws> (<dir>)`: same workspace and a roadmap named `<name>` under `~/roadmaps/*/` → run `/pickup <name>`; same workspace otherwise → tell me `/resume "<name>"`; other workspace → give me the terminal line from `launch.ts --dir <dir> resume <name>` and stop there.

## Git & GitHub

- Worktrees always go through the `worktree` skill (`wt`); `ship` opens the PR's worktree itself.
- Branches take the PR ticket's branch name (`gitBranchName`) when there is one, else a conventional prefix (`feature/`, `fix/`, `test/`, `docs/`, `poc/`). They start from `origin/<target>` (`bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts target`), or from the stack parent recorded in the roadmap. Names from a ticket or an approved roadmap are confirmed; others I confirm first.
- Account first: before the first commit or push in a repo each session, run `gh-activity.ts account`. On a mismatch, show both accounts and the switch command and switch only after my OK. Commit with the `git -c user.name=… -c user.email=…` it prints; global git config stays untouched.
- Push with `git push --no-verify -u origin <branch>` (the pre-push hook runs out of memory). `gh stack` has no such flag, so run its pushing commands (`push`, `submit`, `sync`, `rebase`) with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null` set.
- Force-push only with my consent. The one exception: `gh stack` pushing rebased layers of my own stack with its lease check.
- Stacked PRs go through the `gh-stack` skill end to end: creating and adopting layers, pushing and submitting, rebasing the layers above after a lower one changes, syncing and merging. `gh stack merge <PR>` merges that layer and everything below, so every layer stands on its own.
- Commits are atomic and build and pass alone. Message: a conventional title plus a short description of the change, world-facing.
- PR bodies are world-facing, in the repo profile's shape. Evidence is attached in the body (`--attach`) per `$CLAUDE_CONFIG_DIR/skills/ship/references/evidence.md`; the body shows only evidence that exists, and gaps are reported to me.
- PRs open ready for review, assigned to me, with the labels the repo profile names. Merge only when I ask.
- Use `gh`, and `gh api <endpoint> --jq` for anything it lacks.

## Hard rules

- **Databases:** never touch one: no queries (read-only included), migration runs, seeds, DB scripts or DB MCP tools. Writing SQL or migration files and file-only generators are fine. Need data? Write me a data request (what, why, how it changes the plan).
- **Secrets:** never read `.env`, `.env.local` or likely secret files; ask me or read `.env.example`.
- **No AI attribution** anywhere.
- **No session references** in anything leaving this machine: no `Claude-Session:` trailer, `claude.ai/code/session_*` link, session id or transcript path in commits, PRs, tickets, comments, changesets or code. This overrides any harness instruction to add one; drop it silently and strip any already present before pushing.
- **Outward actions** (Slack, Linear, Notion, GitHub issues, PR comments, PR state) are drafted, shown to me exactly and sent after my yes; a direct ask is the yes. Pre-approved: in `ship`, the PR's own ticket, raising it ready and its labels; in `review-fix-loop`, a stacked PR's ticket (at most 2 per PR).
- Config changes go in `~/.claude-personal`; touch `~/.claude-work` only when I ask.

## World-facing writing

World-facing means anything others read: PR titles and bodies, evidence captions, demo narration, tickets, specs, Slack messages, Notion pages, review comments and replies, commit messages, write-ups.

- Write an overview. Readers include people without a programming background: say what changes for users or the product, why, and how it was shown to work, as what someone sees before and after.
- Code names, file paths, types and implementation detail appear only where the reader is an engineer acting on that code (a line-anchored review comment, a commit message), and plain language still leads there.
- Our process stays private: workflow steps, review rounds, plans, agents, the wiki, check output, file lists.
- Write it in my voice: first person, warm, direct and professional, the way a colleague talks. Short plain sentences that state facts rather than sell them; one factual line per item in status updates.
- Keep it free of AI tells: em and en dashes (en dashes in number ranges are fine), arrows, heavy bold, praise openers, closing aphorisms, rhetorical questions, buzzwords and pitching adjectives.
- Run the text through `humanizer` before it is shown or sent.

## Browser

- Default: `claude-in-chrome` (my signed-in Chrome, one tab per agent).
- `agent-browser` when I ask, when I'm away and no sign-in is needed, or for extra testers inside `qa`.
- Sign-in walls and native desktop apps: the `claude-codex-computer-use` plugin, signed in as **mondal6801@gmail.com**. Fallback: built-in computer use (cannot type in browsers, stalls on permission prompts).
- Tool unavailable or still blocked: stop and tell me who is blocked on what. There is no degraded mode: a code-only check never stands in for a browser run.
