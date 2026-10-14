---
name: branch
description: |
  Create and manage git branches the way the repo expects: discovers the integration target new work merges into, suggests branch names from the repo's conventions, creates plain branches in the current checkout or worktrees under ~/worktrees/<project>/<name>, pushes without force, turns an approved plan into a gh stack with optional draft PRs under an open-PR cap, and lists, removes and prunes worktrees. One deterministic script (`br`) owns every git and gh sequence.

  Use when: starting work on a branch (here or in a worktree), asked "what branch should this be called", "which branch do PRs go to", "create a branch", "open a worktree", "push this branch", "create the stack for this plan", "open draft PRs for the slices", planning, rebasing, syncing or merging a multi-PR stack, "list/show worktrees", "clean up / remove / prune worktrees", env files missing or out of date in a worktree, or after a branch merged and its worktree is no longer needed.
user-invocable: true
metadata:
  origin: local
---

# Branch

Every branch starts from the repo's integration target, which is discovered at run time and never hardcoded. A branch lives either in the current checkout (`--here`) or in its own worktree at `~/worktrees/<project>/<name>/`, opened in a separate terminal with its own Claude Code session. Claude Code's built-in `EnterWorktree` is a different tool (it moves this session into a temporary worktree); do not mix the two.

## Running the script

`br` means `bun <base directory of this skill>/scripts/br.ts`. Use the "Base directory for this skill" path shown when the skill loaded. Run it from the repo or any of its worktrees; `ls --all`, `prune --all` and `rm <absolute path>` also work outside a repo.

Every command takes `--json`. Failures print one line to stderr and exit 1. Warnings go to stderr and into the JSON `warnings` array; relay them. Do not re-implement any step with raw git or gh: if the script cannot do it, say so.

## Start here

Run `br where` first. It shows the main checkout, the current branch, the integration target with its evidence, the ref new branches start from, the current branch's open PR (number, base, draft) and its gh stack, if any.

The integration target comes from the most common base among the last 30 merged PRs, falling back to the repo's default branch. It describes new work only: a branch whose PR targets a feature branch does not change it. The default branch is always read from the remote (`git ls-remote --symref origin HEAD`, then GitHub); a local `origin/HEAD` is used only when the remote is unreachable, with a warning. Without gh or a GitHub remote, the target falls back to that default branch and warns. If `origin/<target>` is not fetched, `br` fetches it; it never silently starts from another branch.

## Intent to command

| Intent | Command |
|---|---|
| Which branch does new work merge into | `br target` |
| Name a branch | `br name --type <feature\|fix\|chore\|docs\|test\|poc\|refactor> --desc "<words>" [--ticket KEY-123]` |
| Start a branch in this checkout | `br new <branch> --here [--base <ref>]` |
| Start a branch in a worktree | `br new <branch> --worktree [--base <ref>] [--name <dir>] [--no-install]` |
| Scratch checkout of a commit | `br new --worktree --detach <ref> --name <dir> [--no-install]` |
| Do env files exist in a worktree (names only) | `br env --check [<name\|branch\|path>]` |
| Env files missing or stale in a worktree | `br env [<name\|branch\|path>] [--from <checkout>]` (`--overwrite` after the user agrees) |
| Push a branch | `br push [<branch>]` |
| Create a stack from an approved plan | `br stack <plan.json> --dry-run`, then the same without `--dry-run` |
| Also open draft PRs for the slices | add `--draft-prs [--cap <n>]` |
| Stack layers, PRs, ahead/behind | `br stack status [<branch>]` |
| List this project's worktrees | `br ls` (`--pr` adds PR number and state) |
| Every worktree on the machine | `br ls --all --pr` |
| Remove a worktree | `br rm <name\|branch\|path>` (`--delete-branch` runs `git branch -d`, never `-D`) |
| Find cleanup candidates | `br prune [--merged] [--gone] [--stale <days>] [--orphans]` (no flags means all) |

## Here or worktree

`br new` needs exactly one of `--here` or `--worktree`. Ask the user when the request does not make it clear. Suggest `--worktree` when they want a parallel session or the current tree is busy with other work; suggest `--here` for a quick, single-session change.

- `--here` refuses a dirty tree and lists `status -s`; show the list and let the user commit or stash. It fetches, then switches to an existing local branch, tracks an existing remote branch, or creates a new branch from `origin/<target>` without an upstream.
- `--worktree` fetches, reuses an existing worktree for the branch, syncs env files (below), installs with `ni` and runs codegen with `nr`. If install fails the worktree is kept and the retry command is printed; relay it.

## Env files

`br` handles env files by path only: it copies them with copyFile and compares them with `cmp`, never reads or prints a value. Shell commands that name `.env` files (`ls … | grep .env`, `cat`, `grep`, `test -f`) are denied or unreliable here, so `br env` is the only way to inspect them.

- **Source.** A worktree takes its env files from the checkout it was spawned from: `br new --worktree` run from another worktree records that worktree as the source (in the worktree's private git dir); run from the main checkout, the source is the main checkout. `br env --from <name|branch|path>` changes the source and remembers it after a real sync.
- **Check whether env files exist:** `br env --check [<worktree>]`. Read-only. Lists file names as `missing`, `same`, `differs` (against the source) and `only here`. Run it before saying a file is missing, and never guess a filename such as `.env.local`; the app's own scripts say which file it loads.
- **Copy missing files:** `br env`. Files that differ are reported and left alone; `br new --worktree` does the same.
- **Replace differing files:** `br env --overwrite`, only after the user agrees, because a differing file may be a deliberate per-worktree change. Old copies move to `<worktree git dir>/br-env-backup/<stamp>/`, outside the working tree, so they can never be committed.
- Never ask the user to copy, link or paste env files.

## Naming

`br name` prints a suggestion and its evidence: the prefix the repo uses most for that type, and how recent branches place the ticket key. It never creates anything. Show the name and evidence, and get the user's confirmation or their own name before `br new`.

## Pushing

`br push` runs `git push --no-verify -u origin <branch>` and never forces. It refuses to push the default branch or the integration target. If the push is rejected as non-fast-forward, report the reason and let the user decide. Pass `--force-with-lease` only after the user explicitly agrees to overwrite the remote branch.

## Stacks from a plan

The plan file is JSON, layers bottom to top:

```json
{ "base": "optional, defaults to the integration target",
  "branches": [ { "name": "feature/upload-retry-api", "title": "feat(api): retry failed uploads" } ] }
```

`br stack` validates the names (conventional prefix, unique, not already on origin unless the layer is in this stack), creates the bottom layer from `origin/<base>`, runs `gh stack init` or `gh stack add` with explicit flags only, and pushes every layer. It runs in the current checkout and switches branches, so the tree must be clean. Rerunning the same plan resumes: layers already in the stack are skipped, and a plan that extends the stack adds the new layers on top. A plan that reorders or renames existing layers is refused.

With `--draft-prs` it counts the user's open PRs in the repo, drafts included, and opens draft PRs bottom-up with the plan's titles until open plus new PRs reach the cap (default 5). A layer with no commits yet, or above a layer without a PR, waits: its branch is pushed and the report says why. Once every layer has a PR, `gh stack link` links them on GitHub. Rerun the command later to open the waiting PRs.

## Stack lifecycle

Multi-PR work is always a gh stack. Each layer is built and shipped when it is ready: build one layer, rebase it on its parent, push it, open its draft PR, then start the next. `br` owns creation, pushing and status; for the other steps use the non-interactive commands from the `gh-stack` skill.

1. **Plan.** One layer per PR, bottom to top in merge order. Every layer is self-contained: it builds, passes the gates and leaves the product working, and whatever switches behavior on (an allowlist entry, a flag) lands in the same layer as the code it enables. Tickets: reuse existing ones when they exist. One PR may carry two tickets and one ticket may span several PRs; a body then says "Part of KEY-123", never a closing keyword. Without tickets, create one sub-ticket per layer under a parent and order them with blockedBy. Branch names come from the ticket's gitBranchName with the prefix set to the work type (`br name --ticket`). No layer numbers in titles or branch names, and PR bodies never mention the stack.
2. **Build one layer.** Create the layer as a local branch on the one below (`br new <branch> --here --base <layer below>`, the bottom one on `origin/<target>`). It carries its own changeset if the repo uses changesets, and the gates run on it.
3. **Rebase on its parent.** Fetch, then replay the layer onto its current parent (`origin/<target>` for the bottom layer; `git rebase --onto <new parent> <old parent> <layer>` while it is a plain branch, `gh stack rebase` once the stack exists). Rerun the gates.
4. **Push and open the PR.** `br stack <plan.json> --dry-run` (the plan lists the layers so far), the user's yes, then the real run with `--draft-prs`. It adopts the existing local branches, pushes each with an upstream, opens the new draft and links the stack. Raw `gh stack push`/`submit` leave no upstream; set it per branch if they were used. Labels and assignee follow what the repo's recent stack PRs carry (read them, don't assume). If the repo has a CI job that rewrites PR bodies on open, push or label, wait for its runs to finish before writing bodies, and recheck bodies after later pushes or label changes. When CI is triggered by a label, put it on the top PR only.
5. **Next layer.** Repeat steps 2 to 4 on top of the shipped layer, extending the plan file; rerunning `br stack` adds the new layer.
6. **Keep in sync.** A review fix goes on the layer that owns the code, then `gh stack rebase --upstack` from that layer. `gh stack sync` fetches, rebases on the trunk and pushes. Rewriting pushed layers is a force push, so it needs the user's explicit yes first.
7. **Merge (the user's action).** `gh stack merge <PR> --yes` merges that PR and every unmerged PR below it, bottom-up, and the PRs above retarget to the trunk. Any layer is therefore a merge point, picked at merge time; don't ask the user about merge shape while planning, only make sure each layer is self-contained. A single merge point at the top is a user decision recorded in the initiative, never a default. Claude never merges and never marks a PR ready unless told to for that PR.
8. **After merge.** `gh stack sync --prune` or `br prune --merged` cleans up merged branches and worktrees. Superseded PRs and tickets close only after the user approves the closing text.

While a stack is in play, bulk requests such as "all PRs" or "cancel CI" mean that stack's PRs only.

## Confirmation rules

- Confirm the branch name before `br new`.
- Before `br stack`, show the `--dry-run` output (layers, every command, PR plan) and get an explicit yes.
- PRs are always drafts. Marking a PR ready for review is never done by this skill.
- Never force-push without the user's explicit consent for that branch.
- `br new --worktree`: if the folder exists as an orphan, the script refuses; show it and ask before `br rm <path> --force`.
- `br rm`: always confirm the exact targets first. The script refuses a dirty worktree and lists `status -s`; show that list and get an explicit yes before rerunning with `--force`.
- `--delete-branch`: confirm separately. If git refuses (not merged), report it; never escalate to `-D`.
- `br prune` is a dry run. Show the candidates with reasons and dirty counts, let the user pick, then run `br rm` on only the picked paths.
- Harness worktrees (`claude-*`, flag `harness`) belong to other sessions; prune skips them unless `--all`, and they still need explicit confirmation.
- Never remove the main checkout or a worktree the current session is running in (the script refuses both).

## Reading `br ls`

Flags: `detached` (no branch), `harness`, `merged` (pushed branch contained in the default branch or the integration target, or PR merged; catches squash merges with `--pr`), `gone` (upstream deleted), `stale` (no commits in 30 days), `orphan` (folder under `~/worktrees` that git does not know), `missing` (registered, folder gone; `br rm` prunes it). `UP +/-` is ahead/behind upstream.

## Handoff

After `br new --worktree`, tell the user to open a new terminal and run the printed `next` command (`cd <path> && <launch>`, built by `bin/launch.ts`). Never `cd` this session into the worktree and never start work there from this session unless asked. After `br new --here`, the session continues in the current checkout.

## Conventions

- Worktree location is always `~/worktrees/<project>/<name>/`; the project comes from the origin remote name (e.g. `saas`, not `SaaS`).
- New branches start from `origin/<integration target>` (never the local HEAD) without an upstream, so the first push sets one: `br push`.
- Package manager is auto-detected by `ni`/`nr`; never substitute `npm`/`npx`.
