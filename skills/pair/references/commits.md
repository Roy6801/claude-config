# Commits

Each planned commit goes through the same loop, one after another until the PR is built, with no pause for the user in between: the builder writes the code; the main thread reviews, checks, stages and commits. The commit message is the decision record reviewers read, so every field is written for a reader who was not in the chat.

## The loop, per commit

1. Dispatch the `builder` agent with the prompt below.
2. Read its diff yourself. Fix small problems inline or send the builder back with specific corrections. Its report is a claim until the diff and the check agree.
3. Run `pair check`. Exit 2 means a file is outside the planned commit or the budget is exceeded: stop and ask the user whether to split, move the change to another commit or PR, or raise the limit with a reason.
4. Run the commit's check command and read its output.
5. Stage the planned files by path, write the notes file, and run `pair commit`.
6. Push with `br push` (never force) and post one line: the commit title, the check result, anything noticed. Then start the next commit.

## Dispatching the builder

Use the `builder` agent (`subagent_type: builder`) with a self-contained prompt:

```text
Implement planned commit <commit n> of PR <n> in <repo path> on branch <branch>.
Title: <planned title>
Why: <planned why>
Files (touch only these): <paths>
The approved plan for this commit, snippets included: <the commit's section of pr-<n>-plan.md>
Patterns to follow: <file:line list from the plan>
ACs this commit serves: <AC ids with their one-line titles>
Check: <check command>
Constraints: <approved exceptions, things to avoid, earlier review feedback, no code comments unless the code cannot say it>
```

The builder returns its notes per file, the check result, deviations, things noticed out of scope, and open questions.

## Staging and notes

Stage the planned files by path: `git add <path> <path>`, never `git add -A` or `git add .`. Run `git diff --cached --name-status` and confirm it matches the plan.

The notes file maps every staged path to one line saying what changed in that file. Write it to the scratchpad directory, not the repo:

```json
{
  "src/api/roles.ts": "POST /roles validates the name and stores the role",
  "src/api/roles.test.ts": "covers the happy path and the empty-name error",
  "src/api/old-roles.ts": "removed; its only caller now uses roles.ts"
}
```

For a rename, key the note by the new path. `pair commit` refuses when a staged path has no note.

## Running `pair commit`

```bash
pair commit --why "<why, refined by what actually happened>" --notes <notes.json> \
  --alt "<alternatives weighed, or omit>" \
  --deviation "<what differs from the plan and why, or omit>" \
  --noticed "<out-of-scope findings, or omit>" \
  --checked "<the command actually run, or omit to use the planned check>"
```

It commits to the PR whose branch HEAD is on, as its next planned commit, using the planned title. Pass `--deviation` whenever the staged files differ from the planned ones; the script refuses otherwise. A deviation also goes into the one-line report.

## Message format

The script builds the message from the plan and the flags. Added, Modified and Deleted come from `git diff --cached --name-status`; empty groups are left out; a rename appears under Modified as `old → new`.

```text
feat(api): roles can be created through the API

Why: The screen needs an endpoint that validates and stores a role.

Added:
- src/api/roles.ts: POST /roles validates the name and stores the role
- src/api/roles.test.ts: covers the happy path and the empty-name error
Deleted:
- src/api/old-roles.ts: removed; its only caller now uses roles.ts

Alternatives: Extending the teams endpoint; rejected because roles have their own permissions model.
Deviation: none
Noticed (out of scope): teams.ts duplicates the name validator.
Checked with: nr test -- src/api/roles.test.ts
ACs: AC-1
```

The commit uses `git commit -F`, so the repo's hooks run. There are no trailers, no AI attribution and no session links.

## Extra commits

Review fixes, `/simplify` results, the user's test findings and fixes to a shipped PR are commits too. Run `pair commit --title "<conventional title>" --why … --notes …`: the script appends an extra commit to the PR (marked `extra`, already done), checks its staged files against all of the PR's planned files, and defaults `--checked` to the PR's green check. Name the source in the why (for example "from /simplify" or "review feedback from @<login>"). Commits made outside `pair commit` show up in `pair walk` as "no reasoning recorded"; avoid them.
