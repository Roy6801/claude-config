# The ladder

The ladder is the machine record of a roadmap: `pair.json` in the initiative directory, one slice per PR in ship order. Brainstorm saves it rough (PRs with rough commits); pair adds a PR's details when that PR's plan is approved; the script adds progress as work lands. `roadmap.md` is the readable tracker generated from it. Slice n is PR n.

## Saving

- `pair plan save <ladder.json>` stores a whole ladder (brainstorm, or a roadmap change).
- `pair plan save <slice.json> --slice <n> --plan <plan.md>` stores one PR's approved plan: the file holds that one slice object (only the fields that change are needed; the rest come from the stored slice), the script copies the plan to `pr-<n>-plan.md`, sets `plan_file` and `plan_approved_at`, and holds the PR for this chat. It refuses until the PR's details are complete.

Both validate, print one line per problem, and on success print a plan diff and rewrite `stack.json` (for `br stack`) and the status parts of `roadmap.md`.

A re-save never loses work. Each new slice is matched to its stored slice by branch (by title when the branch was renamed), never by number, so inserting or moving a PR shifts nothing. From the stored slice it keeps the progress (status, timestamps, `pr`, `sessions`), the plan approval, and any detail field the new file leaves out (`test_script`, `budget`, `patterns`, `exceptions`, `green_check`, `merge_point`, `prefactor`, `why`). Commits match by title inside the slice and keep their done markers (`status`, `sha`, `done_at`) and any detail the new file leaves out (`files`, `check`, `est_lines`, `acs`). Extra commits the new file does not list are appended. Done work that no longer has a place (a removed PR, a renamed done commit) is reported as dropped.

## Ladder fields

| Field | Required | Meaning |
|---|---|---|
| `base` | yes | The integration target, from `br target` |
| `repo` | first save | Absolute path of the main checkout; taken from the cwd when left out |
| `slug` | no | Must match the initiative when given |
| `cap` | no | Open-PR cap. Optional. Set `cap` only when the user wants a limit on open PRs, drafts included; the script records 5 when it is omitted, and only `br stack --draft-prs --cap <n>` enforces a cap (slices beyond it get their PRs later) |
| `deadline` | no | `YYYY-MM-DD`; `pair plan show` compares the days left to build with it |
| `slices` | yes | The PRs in ship order, numbered 1..N |

## Slice fields

Brainstorm writes these for every PR:

| Field | Meaning |
|---|---|
| `n`, `title` | Position in ship order and a short name |
| `goal` | What the PR is for, in one plain sentence |
| `after` | "After this you can …", from the user's point of view |
| `branch` | The confirmed branch name (`br name`), unique in the ladder |
| `acs` | AC ids it delivers: `AC-<n>` from the initiative's spec, or `<TICKET>/AC-<n>` for an AC that lives on a Linear ticket (for example `ENG-42/AC-1`). Plain ids are checked against `spec.md` when it exists; ticket-scoped ids are shape-checked only. Empty only on a prefactor PR |
| `merge_point` | `true` (the default) when the PR goes live on its own or takes its group live; `false` when it goes live together with the next PR above it that is `true` |
| `milestone` | The milestone it belongs to. A milestone's PRs are consecutive; the first PR of a later milestone waits (pair asks) until every earlier milestone's PRs are live |
| `est_days` | Estimate in working days |
| `ticket` | Optional Linear ticket key or GitHub issue number (`#412`) |
| `prefactor`, `why` | `prefactor: true` with a `why` lets a no-behaviour-change PR have no ACs |
| `commits` | Rough commits: `n`, `title` (Conventional Commit, at most 72 characters, plain language), `why` |

Pair adds these when the PR's plan is approved; `pair slice start` refuses a PR without them:

| Field | Meaning |
|---|---|
| `test_script` | Numbered steps the user follows in the running app, each with what they see |
| `commits[].files` | Every path the commit touches (exact path, a directory ending in `/`, or a glob); a file outside it stops the build |
| `commits[].check` | The command that proves the commit green; checks never touch a database |
| `commits[].est_lines` | Rough net lines |
| `commits[].acs` | The AC ids this commit serves |
| `budget.net_lines` | At most 500 (the default); the commits' estimates must fit |
| `patterns` | `file:line` examples the PR follows |
| `exceptions` | `{ what, why, approved }` per planned departure from the repo's conventions |
| `green_check` | Optional; without it `pair green` runs the commits' checks, de-duplicated |
| `target_date` | Optional `YYYY-MM-DD` |

The script owns these; never write them by hand: `status` (`todo`, `active`, `checkpoint`, `shipped`; `done` in older ladders means built and approved, not shipped), `plan_file`, `plan_approved_at`, `started_at`, `net_lines`, `net_at`, `pr`, `shipped_at`, `live_at` (set by `pair slice live` once the done skill verifies the merge), `sessions` (the chats that held the PR), and per commit `status`, `sha`, `done_at`, `extra`.

## Commits inside a PR

- One behaviour or one mechanical step per commit, in an order where every commit builds and passes its check.
- The title says what users get: `feat(hub): admins can create a role`, not `feat(hub): add RoleForm component`.
- The why is the reason for this commit, not a restatement of the title.
- Tests travel with the code they test, in the same commit.
- A PR that needs more than 500 net lines is two PRs: change the roadmap, never the budget.

## Example

A rough ladder as brainstorm saves it:

```json
{
  "base": "staging", "deadline": "2026-10-20",
  "slices": [
    {
      "n": 1, "title": "Create a role", "milestone": "M1", "ticket": "#412", "merge_point": true,
      "goal": "Admins can create a role from the hub settings page",
      "after": "After this you can create a role named Editor and see it in the roles list",
      "branch": "feature/create-role", "acs": ["AC-1", "AC-2"], "est_days": 1,
      "commits": [
        { "n": 1, "title": "feat(api): roles can be created through the API", "why": "The screen needs an endpoint that stores a role" },
        { "n": 2, "title": "feat(hub): admins can create a role", "why": "Admins need a form on the roles page" }
      ]
    }
  ]
}
```

The slice file pair saves with `--slice 1 --plan <plan.md>` once PR 1's plan is approved:

```json
{
  "test_script": [
    "Sign in as an admin and open Settings, then Roles",
    "Click New role, type Editor, save: Editor appears in the list",
    "Save with an empty name: the field shows 'Name is required'"
  ],
  "budget": { "net_lines": 400 },
  "patterns": ["src/hub/teams/CreateTeam.tsx:12", "src/api/teams.ts:40"],
  "exceptions": [],
  "commits": [
    { "n": 1, "title": "feat(api): roles can be created through the API", "why": "The screen needs an endpoint that stores a role",
      "files": ["src/api/roles.ts", "src/api/roles.test.ts"], "est_lines": 90, "check": "nr test -- src/api/roles.test.ts", "acs": ["AC-1"] },
    { "n": 2, "title": "feat(hub): admins can create a role", "why": "Admins need a form on the roles page",
      "files": ["src/hub/roles/CreateRole.tsx", "src/hub/roles/RolesPage.tsx"], "est_lines": 140, "check": "nr typecheck", "acs": ["AC-1", "AC-2"] }
  ]
}
```

## Roadmap statuses

Plan save, slice start, commit and slice ship rewrite two parts of `roadmap.md` from the ladder and leave the prose alone; `pair roadmap sync --slug <slug>` does the same on demand. Each `**PR <n>: <name>** (<status>)` line gets one of: `next` (the first unshipped PR, no plan yet), `not started` (a later PR with no plan yet), `plan approved`, `in progress, <k> of <m> commits` (also when built and not yet shipped), `draft #<number>`, or `live` (written by hand after the merge, and kept). The `**Next up: …**` line names the first unshipped PR and its starter: `/pair implement <slug>` once its plan is approved or it is (half) built, else `/pair plan <slug>`.
