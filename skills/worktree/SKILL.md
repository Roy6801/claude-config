---
name: worktree
description: "Git worktrees under ~/worktrees/<project>/ through the wt script. Use when creating a worktree or a scratch checkout of a PR or commit, fixing a worktree's env files, or listing, removing or pruning worktrees."
metadata:
  origin: local
---

# Worktree

A worktree lives at `~/worktrees/<project>/<name>/` and is opened in a separate terminal with its own Claude Code session. Claude Code's built-in `EnterWorktree` is a different tool (it moves this session into a temporary worktree); this skill never uses it.

## Running the script

`wt` means `bun <base directory of this skill>/scripts/wt.ts`. Use the "Base directory for this skill" path shown when the skill loaded. Run it from the repo or any of its worktrees; `ls --all`, `prune --all` and `rm <absolute path>` also work outside a repo. The project is the origin repo name (e.g. `saas`, not `SaaS`).

Every command takes `--json`. Failures print one line to stderr and exit 1. Warnings go to stderr and into the JSON `warnings` array; relay them. If the script cannot do a step, say so and leave raw git and gh out of it.

## Intent to command

| Intent | Command |
|---|---|
| Worktree for a branch | `wt new <branch> [--base <ref>] [--name <dir>] [--no-install]` |
| Scratch checkout of a commit | `wt new --detach <ref> --name <dir> [--no-install]` |
| Do env files exist in a worktree (names only) | `wt env --check [<name\|branch\|path>]` |
| Env files missing or stale in a worktree | `wt env [<name\|branch\|path>] [--from <checkout>]` (`--overwrite` after the user agrees) |
| List this project's worktrees | `wt ls` (`--pr` adds PR number and state) |
| Every worktree on the machine | `wt ls --all --pr` |
| Remove a worktree | `wt rm <name\|branch\|path>` (`--delete-branch` runs `git branch -d`, never `-D`) |
| Find cleanup candidates | `wt prune [--merged] [--gone] [--stale <days>] [--orphans]` (no flags means all; `--all` adds every project and harness worktrees) |

## Creating

The branch name follows the branching rule in CLAUDE.md, taken from the ticket when there is one. `wt new` bases on origin/<integration target>; `--base` overrides. `wt new` always makes a worktree.

`wt new` fetches, reuses an existing worktree for the branch, creates the worktree, syncs env files (below), installs with `ni` and runs codegen with `nr`. A new branch has no upstream. If install fails the worktree is kept and the retry command is printed; relay it.

## Env files

`wt` handles env files by path only: it copies them with copyFile and compares them with `cmp`, never reads or prints a value. Shell commands that name `.env` files (`ls … | grep .env`, `cat`, `grep`, `test -f`) are denied or unreliable here, so `wt env` is the only way to inspect them.

- **Source.** A worktree takes its env files from the checkout it was spawned from: `wt new` run from another worktree records that worktree as the source (in the worktree's private git dir); run from the main checkout, the source is the main checkout. `wt env --from <name|branch|path>` changes the source and remembers it after a real sync.
- **Check whether env files exist:** `wt env --check [<worktree>]`. Read-only. Lists file names as `missing`, `same`, `differs` (against the source) and `only here`. Run it before saying a file is missing, and read the app's own scripts for which file it loads instead of guessing a filename such as `.env.local`.
- **Copy missing files:** `wt env`. Files that differ are reported and left alone; `wt new` does the same.
- **Replace differing files:** `wt env --overwrite`, only after the user agrees, because a differing file may be a deliberate per-worktree change. Old copies move to `<worktree git dir>/wt-env-backup/<stamp>/`, outside the working tree, so they can never be committed.
- The script does every copy; the user never copies, links or pastes env files.

## Confirmation rules

- `wt env --overwrite`: only after the user agrees.
- `wt new`: if the folder exists as an orphan, the script refuses; show it and ask before `wt rm <path> --force`.
- `wt rm`: confirm the exact targets first. The script refuses a dirty worktree and lists `status -s`; show that list and get an explicit yes before rerunning with `--force`.
- `--delete-branch`: confirm separately. If git refuses (not merged), report it and keep the branch.
- `wt prune` is a dry run. Show the candidates with reasons and dirty counts, let the user pick, then run `wt rm` on only the picked paths.
- Orphan folders are deleted only after the user has seen the file counts and said yes.
- Harness worktrees (`claude-*`, flag `harness`) belong to other sessions; prune skips them unless `--all`, and they still need explicit confirmation.
- The main checkout and the worktree this session runs in are never removed (the script refuses both).

## Reading `wt ls`

Flags: `detached` (no branch), `harness`, `merged` (pushed branch contained in the default branch or the integration target, or PR merged; catches squash merges with `--pr`), `gone` (upstream deleted), `stale` (no commits in 30 days), `orphan` (folder under `~/worktrees` that git does not know), `missing` (registered, folder gone; `wt rm` prunes it). `UP +/-` is ahead/behind upstream.

## Handoff

After `wt new`, tell the user to open a new terminal and run the printed `next` command (`cd <path> && <launch>`, built by `bin/launch.ts`). This session stays where it is and starts no work in the worktree unless the user asks.
