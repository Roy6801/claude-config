---
name: ship
description: |
  Create or update the draft pull request for a branch or a planned slice. A script (`pr.ts`) resolves the facts: the base (the open PR's base, the gh stack parent, else the integration target from `gh-activity.ts target`), commits since the base, net lines against the 500-line budget, the linked ticket, the pair slice, the repo's PR template, and any open PR. Runs `review self` first, stops on an over-budget diff to propose a split or an explained exception, drafts a Conventional title and a human-readable body (what the PR does, never the output of checks) from the template, the ticket and spec ACs, the commits, and an Evidence section whose screenshots or video the user has reviewed, shows the exact text, and only after approval pushes with `git push --no-verify -u origin <branch>` and creates or edits the PR. PRs open as drafts assigned to the user; this skill never force-pushes, and marks ready or merges only when the user asks.

  Use when: a slice passed its checkpoint and needs its PR, creating a PR, updating an open PR's title or description, drafting a PR description, or asked to "ship this", "write the PR", "prep the PR", "create a PR", "update the PR", or `/ship [branch]`.
user-invocable: true
metadata:
  origin: local
---

# Ship

Turn a branch into a draft PR a reviewer can hold in their head: the right base, at most 500 net lines, a body that carries the why, the ACs with their evidence, an Evidence section, and how to test. One PR per slice. Nothing is pushed, created or edited without a yes for that action.

## Scripts

- `pr` means `bun <base directory of this skill>/scripts/pr.ts`. Run it inside the repo or one of its worktrees; `--branch <b>` targets a branch other than the current one. Every command takes `--json`. Failures print one line to stderr and exit 1; warnings go to stderr and into the JSON `warnings` array. Relay every warning.
  - `pr facts`: branch, checkout path, push state, base with its source and evidence, commits since the base, size (`net` = added minus deleted, lockfiles, generated files, changesets and snapshots excluded; `over` when net exceeds 500), ticket key, the pair slice whose branch this is, the PR template path (or the choices when a template folder holds several), and the open PR (number, draft, base, url).
  - `pr upsert --title <t> --body-file <f> [--base <b>] [--attach ./<file>[#alt]]... [--dry-run]`: creates a draft PR assigned to the user (`@me`) when none is open (the branch must be on origin), else edits the open PR's title and body and adds the user as assignee. Each `--attach` uploads an image or video that sits next to the body file and that the body references as `](./<file>)`; gh rewrites the reference to the uploaded asset. An attachment the body never references is appended at the end, and `upsert` warns. `--base` on an open PR retargets it, refused inside a gh stack. It never changes draft state, never marks ready, and refuses a title or body that carries a session link or AI attribution.
- Pushing is `git push --no-verify -u origin <branch>`, never forced without the user's consent.
- Before the first push or PR in a session, run `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts account --json`. When `match` is false or `ambiguous` is true, show the user the active account, the account the repo belongs to and the `switch` command, and switch only after their OK. Commits use the printed identity: `git -c user.name=… -c user.email=… commit`.
- Never re-implement a script step with raw git or gh. If a script cannot do something, say so.

## Workflow

### 1. Facts

Run `pr facts`. State the base, its source and evidence in one line, and wait for the user to confirm it. No open PR: create mode. An open PR: update mode, and its base stays unless the user asks to change it. If `otherPrs` is not empty, ask which PR this is. If the open PR is ready for review rather than a draft, say so: only its title and body change.

For a pair slice (`slice` is set), the slice's ticket, ACs and planned base come from the plan. The base `pr facts` reports must match the plan: slice 1 targets the plan's base, each later slice targets the slice below it. A mismatch stops here; show both and ask.

### 2. Self-review gate

Run the `review` skill in `self` scope on this branch before drafting anything. Blockers it reports are fixed first (through `pair` when a plan exists) or explicitly waived by the user; record a waiver as an exception in the body. Its checklist feeds the body: AC coverage, tests, exceptions, simplify results.

### 3. Size

`size.over` false: continue. Over 500 net lines: stop before drafting and follow `references/size.md`, which proposes a split along the diff's seams or drafts the exception reasoning. The user decides. A pair slice that went over its planned budget is a deviation from the plan: say by how much and why.

### 4. Gather (in parallel)

- **Ticket or issue**: for the `ticket` key from `pr facts` or the spec, `ticket` in read mode when it is a Linear key and Linear is connected, else `gh issue view <n>`. No key: ask for one, or "none".
- **ACs**: `bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts acs <slug> --json` when an initiative is active (`bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json`). Restrict them to the slice's `acs` when `slice` is set.
- **Commits**: from `pr facts`. Read `git show --stat <sha>` and commit bodies for the Added / Modified / Deleted rollup and the rationale. Read the full diff only when it is small; otherwise dispatch one read-only agent to summarize it by behavior.
- **Template**: `git show <headRef>:<template.path>`. Several choices: pick by change type and say which. None: the default sections in `references/body.md`.
- **Evidence**: the newest `qa-*.md` in the initiative directory (verdict per AC, GIFs), browser screenshots and recordings from this session's checks, screenshots or videos the user supplies. Copy every image or video for the Evidence section into one scratchpad folder, named in the order they appear (`1-before.png`, `2-after.png`); the body file goes in the same folder. No visual evidence for a UI change: capture it now through the browser tool, or ask the user whether to skip. Never invent a command, a count or a result. Check output (typecheck, lint, tests) is never evidence.
- **Voice and title style**: `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts conventions --json` for the repo's PR title style; the author's last 3 merged PR bodies for density and how they link tickets and embed media (style only, never content).
- **Changeset tooling**: see `references/body.md`.

### 5. Draft

Title: Conventional Commit (`<type>(<scope>): <plain-language summary>`, under 70 characters), unless the repo's merged PRs use another style; follow the repo. Body: `references/body.md`, which covers the required sections by change type, the AC and evidence table, rollout and rollback, exceptions, update mode, and voice. A body drafted in an earlier session is input, not a finished draft: rewrite every section of it against these rules.

Before showing it, self-grill per `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md`: answer the three questions a reviewer is most likely to ask, and fix the body where it does not.

### 5b. Evidence review

Send every attachment to the user (`SendUserFile`), each with a caption saying what it shows, which fix or AC it backs, and anything staged for it (markup injected in the browser, test data, a local build). The user approves, drops or replaces each one; only approved files are attached. Captions in the body say the same staging facts, so a reviewer never mistakes a staged screen for real data.

### 6. Confirm, then act

Write the body to a scratchpad file. Show the exact title, the full body, the base, and the list of actions that will run:

1. Push (`git push --no-verify -u origin <branch>`) when `remote.exists` is false or `remote.ahead` is above 0. When `remote.behind` is above 0, stop and ask.
2. `pr upsert --title "<title>" --body-file <file> --attach ./<file>#<alt> ... --dry-run`, with one `--attach` per approved file, then show its command.
3. The same without `--dry-run`.

Invoking ship is the user's OK: when the user asked to create or update the PR, or said yes to shipping after a `pair` walkthrough, run these actions right after showing them, without asking again. Attachments are the exception: they are reviewed in step 5b before anything is uploaded. Labels and anything beyond these actions still need their own yes. Then run `pr facts` again and check: the PR exists, is a draft (create mode), is assigned to the user, targets the confirmed base, and `gh pr view <n> --json body` matches the approved body with every `](./<file>)` rewritten to an uploaded asset. Report the URL. When the repo has a bot that rewrites PR bodies, recheck the Evidence section after its run and restore it if it was dropped.

### 7. Stacked slices

One PR per slice, each based on the slice below it. Ship drives the `gh-stack` skill's non-interactive commands directly: build one layer, rebase it on its parent, push, open its draft PR, then the next.

- After every `gh stack push` or `submit`, set upstream per branch (`git branch --set-upstream-to=origin/<b> <b>`) and confirm `git rev-list --left-right --count <b>...origin/<b>` is `0 0`.
- When the user set an open-PR cap, count their open PRs in the repo (drafts included) before opening PRs and stop at the cap.
- A CI-trigger label goes on the top PR only.
- When the repo has a CI job that rewrites PR bodies on open, push or label, wait for it before writing bodies.
- PR bodies never mention the stack or link siblings.

### 8. After

Optional labels: suggest up to 3 from `gh label list --json name,description` with a reason each; apply with `gh pr edit <n> --add-label` only after a yes. Then offer, without running them: `review` in `feedback` scope once comments arrive, and `done` once the work merges.

## Rules

- **The body is for humans.** It says in plain words what the PR does and why. It never carries the output of checks (typecheck, lint, tests).
- **Evidence is mandatory and reviewed first.** Every PR body carries an Evidence section (screenshots or video for anything UI-visible; otherwise output that shows the behavior itself, such as a script run, a log excerpt or an API response), unless the user explicitly says to skip it for this PR. Every attachment is shown to the user and approved before it is uploaded. Evidence goes in the PR body, never in a PR comment.
- PRs open as drafts assigned to the user. They stay drafts and unmerged until the user asks; when the user asks to mark one ready for review or merge it, do it directly (`gh pr ready <n>`, `gh pr merge`), without a second confirmation. Never force-push or close a PR.
- The user's ask to create or update the PR (or their yes to ship after a walkthrough) is the yes for its push, create or edit and the approved uploads. Every other side effect (labels, retargeting, anything not in the action list) needs its own yes.
- At most 500 net lines per PR unless the user approves an exception, and the body then says why.
- Template headings are kept; a heading that does not apply gets `N/A` and a reason.
- Evidence is real or absent. No invented output, no unbacked checkbox.
- Nothing hardcoded: base, labels, title style and ticket prefix come from the scripts or the repo at run time.
- No AI attribution and no session links or ids in the title, body, commits or media.
