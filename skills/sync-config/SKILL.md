---
name: sync-config
description: |
  Port config changes from this Claude config dir to the other ones on the machine, one target at a time with the user's approval for each, judging for each item whether it makes sense in that workspace (adopt, adapt, drop, or create a counterpart), then commit and push each to its own remote. Config dirs differ on purpose (extra skills, local tweaks), so porting is selective, never mirroring. Config dirs and remotes are discovered at run time, nothing is hardcoded.

  Use when: config changes (CLAUDE.md, skills, agents, hooks, bin, settings) were just made in one workspace and should apply to all of them, or the user says "sync config", "same change for the other config dirs", "copy and push across config dirs", or `/sync-config`.
user-invocable: true
metadata:
  origin: local
---

# Sync config

Source is the current workspace, `$CLAUDE_CONFIG_DIR`, unless the user names another. Every step runs once per target.

Config dirs are allowed to differ: one may have extra skills, its own CLAUDE.md rules or local tweaks. Porting carries a change over; it never makes a target match the source. Always ask before porting into each target (step 3.2), even when the change looks identical.

Fit is semantic, not just textual: a change can apply cleanly and still not belong in a target. Judge each item against what the target workspace is for. Read its CLAUDE.md, its existing skills and agents, and the tools, accounts and integrations it uses. Never assume a fixed list of what belongs where; decide fresh each time and let the user confirm.

## 1. Discover

- Targets: every `~/.claude*/` that is a git repo with an `origin` remote (`git -C <dir> remote get-url origin`), except the source. Skip dirs without a remote and say so.
- Workspace name: the dir's basename without `.claude-` (`.claude-<name>` gives `<name>`).
- Remote account: `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts account --cwd <dir>` names the account the remote belongs to, its switch command and its commit identity. Fetches may borrow that account's token (`GH_TOKEN=$(gh auth token --user <account>) git fetch`); pushes run under a visible switch (step 4).
- Each target must be clean (`git status --short`) and not behind its remote (`git fetch`, then `git status -sb`). If it is dirty or behind, stop and ask.

## 2. Build the changeset in the source

Commit the source change first, then take the unpushed commits as one patch: `git -C <source> diff @{u} HEAD`. If the user wants specific files or commits instead, limit the patch to those (`-- <paths>` or `<a>..<b>`).

Leave out workspace-owned paths: `projects/`, `state/`, `backups/`, `plugins/`, anything gitignored, and per-workspace settings (MCP servers, plugin lists, env) unless the user explicitly asks to sync them.

## 3. Port to each target

1. Shared files (skills, agents, bin) refer to `$CLAUDE_CONFIG_DIR`, never a named dir, so they usually port unchanged. For anything that still names the source dir (mostly CLAUDE.md), rewrite the patch for the target: replace the source dir's basename with the target's (`.claude-<source>` becomes `.claude-<target>`), covering both the `~/` and absolute forms. The rewrite also hits text that names the source on purpose, so step 3.4 checks for that.
2. Ask before touching the target. Present a list of recommended changes for this target, one row per item (file, skill, agent, rule or hunk), each with a recommendation and a one-line reason:
   - **Adopt**: port as is; it fits the target's purpose.
   - **Adapt**: port with changes that fit the target (its wording, its tools, its conventions); say what changes.
   - **Drop**: don't port; it depends on tools, accounts or workflows the target doesn't use, or conflicts with the target's rules.
   - **Create**: the target needs its own counterpart instead (a different skill, rule or variant); describe it.
   - **Remove**: something already in the target becomes obsolete or contradictory because of this change; suggest removing it.

   Include what already differs in the target for those files (`git -C <target> diff --no-index` against the source copy, or a dry run with `git apply --check`). Apply only the rows the user approves for this target. Dropped or skipped rows are fine and get listed in the report.
3. Apply it. Config dirs are separate repos with no shared history, so `--3way` has nothing to merge against. Use `git -C <target> apply --reject <patch>` and resolve each `.rej` by hand. When the change is mechanical (a rename, a path swap), redo the transformation in the target instead of applying the patch: it respects the target's own wording and also reaches target-only files. Either way, keep whatever the target intentionally does differently, and list each case for the user.
4. Review `git -C <target> diff --cached`, then look for leftovers: grep the changed files for the source's workspace name, its shell alias, or its account, and check the rewrite didn't change any text that names a workspace on purpose (for example "don't touch ~/.claude-<other>"). Restore any line that should stay as it was. A shared file the user wants identical in every dir (like this skill) should match the source exactly afterwards (`cmp`).
5. Check: run the same check that was used in the source on any touched script (`bun build --target=bun <file> --outdir <scratch>`, or the dir's tests), now from inside the target dir.

## 4. Commit and push

- Commit message: the source commit's message, with any paths rewritten for the target.
- Identity: the `identity` from step 1's account check, passed with `git -c user.name=… -c user.email=…`.
- Push to the target's own remote and branch with `--no-verify`. When the remote's account is not the active one, show the user both accounts and, after their OK, run the switch, push, and switch back to the account that was active before.
- Push only when the user asked for it in this request. Otherwise show a table of target, commit and diffstat, and ask.

## 5. Report

One row per target: the dir, the commit, the push result, and what was adopted, adapted, dropped, created or removed. Running sessions only load CLAUDE.md and skill changes when they start, so say that.
