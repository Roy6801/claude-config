---
name: skills
description: "Review third-party skill updates, moves, removals and new upstream skills, and work the refine queue."
disable-model-invocation: true
metadata:
  origin: local
---

# skills

Data comes from `bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts`. Lock: `~/.agents/.skill-lock.json` (`skills.<name>.{source,skillPath,installedAt,updatedAt}`).

Each group runs only after the user confirms it.

Layout: third-party skills live once in `~/.agents/skills/<name>/` and are symlinked (relative, `../../.agents/skills/<name>`) from the `skills/` folder of each config dir that uses them (config dirs: every `~/.claude*/` with a `skills/` folder; dirs differ, so ask which ones get a link). `bunx skills` does not manage those links (lock `lastSelectedAgents` has no Claude entry), so:

- `link <name>`: for each config dir the user picked, `ln -sfn ../../.agents/skills/<name> <dir>/skills/<name>`
- `unlink <name>`: for each config dir, `[ -L <dir>/skills/<name> ] && rm <dir>/skills/<name>` (only ever removes symlinks, never real dirs)

## 1. Scan

```bash
bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts scan
bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts report --json
```

Report `errors[]` first. Sources with errors have stale data; say so. Show counts per group (including `clashes[]`), then handle groups in order below. Skip empty groups.

## Name clashes

Ours are real dirs in `$CLAUDE_CONFIG_DIR/skills/`; upstream are symlinks into `~/.agents/skills/`. First installed keeps the name. `clashes[]` entries (`{name, kind, source, path}`): one line each.
- `kind: lock`: lock entry shares a name with our real dir (stale, e.g. `qa`). Nothing to do; never `link`/`unlink`/`update` it.
- `kind: new`: upstream skill shares a name with ours. Default: skip it with `bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts ignore <source>:<path>`.
- Alias link name (symlink named differently from the upstream skill) only after verifying Claude Code accepts a dir name that differs from frontmatter `name`; do not assume.

## 2. Updates

For each name in `update[]`, `dir` = `dirname(skillPath)`, `since` = `updatedAt` else `installedAt`:

```bash
gh api 'repos/<src>/commits?path=<dir>&since=<since>' --jq '.[].commit.message|split("\n")[0]'
```

Table: name, source, commit count, subjects (max 5 each). Default is update ALL. Ask: "Update all? List any to exclude." Then:

```bash
bunx skills update <names...> -g -y
```

## 3. Moved

Table: name, old path, new path. Confirm, then per item:

```bash
bunx skills remove <name> -g -y
bunx skills add <src> -g -s <name> -y
```

Then `link <name>` (target unchanged, link must still resolve).

## 4. Removed

Destructive; confirm each item individually. Before asking, find references (grep follows no symlinks, so symlinked skill dirs are skipped):

```bash
grep -rn --exclude-dir=.git -e '<name>' $CLAUDE_CONFIG_DIR/CLAUDE.md $CLAUDE_CONFIG_DIR/agents $CLAUDE_CONFIG_DIR/skills
```

Exclude hits inside the skill's own directory. List remaining hits with the ask. Offer "keep" as an option (it stays counted). On yes: `bunx skills remove <name> -g -y`, then `unlink <name>`.

## 5. New

Group by `source`. For each skill, fetch its description:

```bash
gh api repos/<src>/contents/<path>/SKILL.md --jq .content | base64 -d | head -10
```

Show name + description. Per skill the user picks:
- install: `bunx skills add <src> -g -s <name> -y`, then `link <name>`
- ignore: `bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts ignore <source>:<path>`
- skip: do nothing (stays counted)

## 6. Refine queue

```bash
bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts refine list
```

Show id, name, note. User picks entries to work on now or leaves them. After the fix is done and the user agrees: `bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts refine done <id>`.

## 7. Verify

```bash
bun $CLAUDE_CONFIG_DIR/bin/skills-audit.ts scan
ls -l $CLAUDE_CONFIG_DIR/skills
```

- Each lock skill should be symlinked into the `skills/` folder of at least one config dir, pointing into `~/.agents/skills/`; report lock skills linked nowhere and dangling links (`find ~/.claude*/skills -maxdepth 1 -type l ! -exec test -e {} \; -print`). A skill linked in some config dirs but not others is fine: dirs differ on purpose.
- Confirm `bunx skills` actually wrote `~/.agents/skills/<name>` (it may also create links for other agents in `lastSelectedAgents`; leave those alone).
- Final counts should drop by exactly what was applied; report any mismatch.
