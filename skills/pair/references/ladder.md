# Ladder rules

The ladder is the plan for the whole piece of work: slices from smallest to largest, each a branch and a draft PR, each split into planned atomic commits. Everything after approval checks against it.

## Slices

- **Slice 1 is the thinnest end-to-end path.** It touches every layer the feature needs (for example the endpoint, the hook and one bare screen) with the simplest behaviour that works, so integration problems surface on day one.
- **Each later slice adds one behaviour the user can test on its own.** Write its `after` as "after this you can …" from the user's point of view, and give it a `test_script`: numbered steps the user can follow in the running app, with the expected result of each.
- **Prefactor first.** When existing code must change shape before the feature fits, that refactor is its own slice (no behaviour change, parity checked), ahead of the feature slices.
- **Risky work early.** Unknown libraries, migrations, performance-sensitive paths and anything that could invalidate the plan go into the earliest slice that can carry them.
- **Milestones.** Group slices into milestones that are demo-able points (`M1`, `M2` …). Each milestone ends in something worth showing.
- **Budget.** At most 500 net lines per slice (`budget.net_lines`). If a slice will not fit, split it; never raise the budget at plan time.
- **ACs.** Every slice lists the AC ids it delivers. Every live AC is covered by at least one slice; `pair plan show` flags uncovered ACs.
- **Patterns.** List the codebase examples the slice follows as `file:line` (from the conventions bundle), or a doc link.
- **Exceptions.** Any planned departure from the repo's conventions goes in `exceptions` with what and why, `approved: false` until the user approves it.
- **Estimates.** `est_days` per slice from the work itself. Compare the sum with the working days to the deadline. When the plan does not fit, show the gap and the options: cut scope, put an incomplete slice behind a flag, move work to a follow-up slice, or move the date. Never shrink an estimate to make it fit.
- **Open-PR cap.** Optional. Set `cap` only when the user wants a limit on open PRs, drafts included; the script records 5 when it is omitted, and only `br stack --draft-prs --cap <n>` enforces a cap (slices beyond it get their PRs later).

## Commits inside a slice

- One behaviour or one mechanical step per commit, in an order where every commit builds and passes its check.
- `title` is a Conventional Commit, at most 72 characters, with a plain-language summary: `feat(hub): admins can create a role`, not `feat(hub): add RoleForm component`.
- `why` is the reason for this commit, not a restatement of the title.
- `files` lists every path the commit is expected to touch. A file outside this list stops the build (`pair check` exit 2).
- `est_lines` is a rough size; `check` is the command that proves the commit green (`nr typecheck`, `nr test -- <path>`).
- Tests travel with the code they test, in the same commit.

## Plan file shape

`pair plan save <file>` validates this shape. `deadline`, `milestone`, `ticket`, `target_date` and `green_check` are optional; without `green_check`, `pair green` runs the slice's commit checks, de-duplicated.

Every slice lists at least one AC, except a prefactor slice: `"prefactor": true` with `"why"` (the reason it must come first) allows `"acs": []`, and `pair plan show` lists it as "prefactor (no AC)".

```json
{
  "slug": "role-admin", "repo": "/Users/me/code/saas", "mode": "on",
  "deadline": "2026-10-20", "base": "staging",
  "slices": [
    {
      "n": 1, "title": "Create a role", "milestone": "M1", "ticket": "#412",
      "goal": "Admins can create a role from the hub settings page",
      "after": "After this you can create a role named Editor and see it in the roles list",
      "branch": "feature/hub/roles/create-role",
      "acs": ["AC-1", "AC-2"],
      "test_script": [
        "Sign in as an admin and open Settings → Roles",
        "Click New role, type Editor, save: Editor appears in the list",
        "Save with an empty name: the field shows 'Name is required'"
      ],
      "patterns": ["src/hub/teams/CreateTeam.tsx:12", "src/api/teams.ts:40"],
      "exceptions": [{ "what": "Inline fetch instead of the query hook", "why": "Hook lacks mutation support", "approved": false }],
      "est_days": 1, "target_date": "2026-10-13",
      "budget": { "net_lines": 400 },
      "green_check": "nr typecheck && nr test",
      "status": "todo",
      "commits": [
        { "n": 1, "title": "feat(api): roles can be created through the API",
          "why": "The screen needs an endpoint that validates and stores a role",
          "files": ["src/api/roles.ts", "src/api/roles.test.ts"], "est_lines": 90,
          "check": "nr test -- src/api/roles.test.ts", "acs": ["AC-1"], "status": "todo" },
        { "n": 2, "title": "feat(hub): admins can create a role",
          "why": "Admins need a form on the roles page that calls the new endpoint",
          "files": ["src/hub/roles/CreateRole.tsx", "src/hub/roles/RolesPage.tsx"], "est_lines": 140,
          "check": "nr typecheck", "acs": ["AC-1", "AC-2"], "status": "todo" }
      ]
    }
  ]
}
```

The script adds `started_at`, `done_at`, `net_lines` (insertions minus deletions against the slice base, working tree included; it can be negative) and `net_at` per slice, and `sha` and `done_at` per commit, as work lands. Re-saving a changed plan keeps the `done` markers matched by slice number and commit title, and prints a plan diff; show that diff to the user.
