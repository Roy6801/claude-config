# Conventions mode

Discover how a repo wants work done, fresh on every run. There are no stored repo profiles: conventions drift, so they are read from the repo and from GitHub each time, and every convention is written down with its source.

Never read `.env*` files and never run a script that touches a database. This mode only reads files and runs read-only commands; it does not run lint, tests, or builds.

## Inputs

- Repo path: the argument, or the current directory. Resolve the root with `git -C <path> rev-parse --show-toplevel`.
- Areas touched: when a caller passes a plan, a diff, or a list of paths, the areas are the top-level directories and modules those paths fall in (at most 3). Without that, pick the 2 or 3 most active areas from `git log --since=60.days --format= --name-only | cut -d/ -f1-3 | sort | uniq -c | sort -rn | head`.

## Dispatch

Run these in parallel in a single message, then merge:

1. Main thread: `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts conventions --cwd <root> --json`.
2. One haiku agent for written rules and tool-enforced conventions, writing `<outdir>/conventions-written.md`.
3. One sonnet agent per area touched for code patterns, writing `<outdir>/conventions-code-<area>.md`.

Each agent returns at most 150 words. The main thread writes `<outdir>/conventions.md` from the template below.

## 1. Written rules

List tracked files only, so that `node_modules`, build output, and secrets are never read. `.agents/` holds vendored third-party skills and is skipped; the repo's own `.claude/skills/` (often a `*-conventions` skill) and `CONTEXT.md` (domain glossary) are written rules too:

```bash
git -C <root> ls-files | grep -E '(^|/)(CLAUDE|AGENTS|CONTEXT)\.md$|(^|/)(CONTRIBUTING|CODING_STANDARDS)[^/]*$|^README\.md$|^docs/.*([Aa][Dd][Rr]|[Dd]ecisions)|^\.github/(pull_request_template|PULL_REQUEST_TEMPLATE)|^\.github/copilot-instructions\.md$|^\.cursor/rules/|^\.claude/(rules/|skills/[^/]+/SKILL\.md$|skills/[^/]*convention)' | grep -v '^\.agents/'
```

Read the root files first, then the nested ones inside the areas touched (a nested `AGENTS.md` or `CLAUDE.md` overrides the root for its directory). For a repo skill, read its `SKILL.md` and only the references that match the areas touched. Extract enforceable rules, quoting them, each with `path:line`. Note reference paths the docs point to (copy guidelines, form guidelines, QA guidance) so later steps can read them.

## 2. Tool-enforced conventions

Read the config files that exist, and record what they enforce rather than restating them:

- Lint and format: `biome.json`/`biome.jsonc`, `eslint.config.*`/`.eslintrc*`, `.prettierrc*`, `.editorconfig`. Record the formatter, indentation, quote style, and any rule that is set to error and is unusual.
- Types: `tsconfig*.json`. Record `strict`, `noUncheckedIndexedAccess`, path aliases, and project references.
- Monorepo: `turbo.json`, `nx.json`, workspace globs in `package.json`. Record the task names and their dependencies.
- Hooks and release: `lefthook.yml`, `.husky/`, `.changeset/config.json`, commitlint config. Record what runs on commit and push, and whether changesets are required.
- Scripts: `package.json` `scripts` at the root and in the packages touched. Record the names for check, lint, typecheck, test, and codegen, and how to run them with `nr <script>` (ni picks the package manager). Mark any script that touches a database as off-limits.

## 3. Code patterns (learned from code)

For each area touched, pick 2 or 3 representative files: recently changed by several authors (`git log --since=90.days --format='%an' -- <file> | sort -u | wc -l`), not generated, not tests unless tests are the category. Record each pattern with at least one `file:line` example:

- Data fetching and mutations (client, cache, procedures or routes, loaders)
- Error handling (thrown types, result types, boundaries, logging, user-facing messages)
- State (stores, context, URL state, form state)
- Tests (runner, location, naming, fixtures, mocks, what is covered)
- Feature flags (provider, naming, where checks live)
- Folder layout and naming (feature folders, barrel files, file and component naming)
- Anything the diff or plan adds that already has a named abstraction elsewhere: `grep -rn` for the helper and count call sites. A helper with many call sites is a decision; hand-rolling around it is a deviation.

## 4. Git and GitHub conventions

From `gh-activity conventions`: the integration target with its source and evidence, the default branch, branch prefixes and recent branch names, PR title patterns and samples, commit subject patterns, ticket prefixes, and the gh stack (parent and trunk) when the current branch is in one. Derive the branch naming pattern (for example `feature/<key>-<slug>`) and the PR title pattern (for example `[KEY] type(scope): summary`) from the data, and state the counts.

## Precedence and conflicts

Codebase conventions come first, then official framework guidance, then general practice. Written repo rules and patterns in the code are both codebase conventions. When they disagree (for example, `AGENTS.md` says one thing and most files do another), never pick silently: list the conflict with both sources and recommend one, usually the written rule for new code unless the code shows the rule was abandoned. Fetch official framework guidance (Context7, or `scout best-practices` for deeper research) only when a conflict or a new mechanism needs it.

## Output template (`conventions.md`)

```markdown
# Conventions: <owner/repo> (<root>)
Generated <local date and time> · Areas sampled: <areas> · Raw files: conventions-written.md, conventions-code-*.md

## Git and GitHub
- Integration target: <branch> (<source>: <evidence>)
- Branch naming: <pattern> (<counts>)
- PR titles: <pattern> (<counts>, 2 samples)
- Commits: <pattern> (<counts>)
- Ticket prefixes: <list with counts> · Stack: <parent ← branch, or none>

## Written rules
- <rule, quoted or tight paraphrase> · <path:line>

## Tool-enforced
- <what is enforced> · <config path> · run with `nr <script>`

## Code patterns
### <area>
- <pattern> · <file:line>, <file:line>

## Conflicts
- <source A says X> vs <source B does Y> · recommendation: <which and why>

## Gaps
- <what could not be determined, and why>
```
