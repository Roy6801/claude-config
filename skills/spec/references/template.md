# Spec template and parse format

`spec.ts check` enforces everything on this page. If you change the format, change the script in the same edit so humans and the script keep agreeing. Worked examples: `examples/ticket.md` and `examples/prd.md`.

## Front matter

```yaml
---
slug: bulk-question-import      # kebab-case, same as the initiative slug
size: ticket                    # ticket (fewer than 5 PRs) | prd (5+ PRs: a longer spec, kept locally)
status: draft                   # draft | approved (flip with `spec.ts status <file> approved`)
ticket: #123                    # optional: GitHub issue number or URL
prd: https://…                  # size prd only, optional: link to an external copy of the PRD
---
```

Only these five keys are allowed. Do not add `prd:` before the external copy exists, and never on a `ticket` spec. Set `ticket:` once the GitHub issue exists.

## Sections

Every section is a `## ` heading with a non-empty body. Order is free, but keep the order below.

| Section | ticket | prd | What goes in it |
|---|---|---|---|
| `# <Title>` | yes | yes | The outcome, in plain words (not a ticket id) |
| `## Problem` | yes | yes | An `Asked:` line (what was requested, Y) and a `Real:` line (the underlying problem, X), then 1 to 3 sentences of context with quotes |
| `## Journey` | | yes | The user's path through the feature, as numbered steps with real screen names |
| `## MVP` | | yes | The thinnest version that works end to end, and what is deferred |
| `## Success metric` | | yes | One measurable signal, its baseline, its target, and where it is read |
| `## Acceptance criteria` | yes | yes | AC-1…n in the format below |
| `## Non-goals` | yes | yes | What this work deliberately does not do |
| `## Risks and constraints` | | yes | Technical, data, deadline and dependency risks, each with a mitigation |
| `## Demo milestones` | | yes | What can be shown at each milestone and roughly when |
| `## Release notes` | | yes | `Flag:` line (name or "none, because …"), `Rollback:` line, then rollout and monitoring |
| `## Definition of done` | yes | yes | Checkbox list of the DoD items that apply |
| `## Open questions` | yes | yes | Unsourced assumptions and undecided points, or "None" |
| `## Grilled` | yes | yes | The self-grill block: what was challenged, what changed, what was dropped as slop |

## Acceptance criteria

Each AC is a `### ` heading inside `## Acceptance criteria`, followed by `- ` lines.

### Behaviour AC

```markdown
### AC-1 [happy] Content admin imports 50 questions from a CSV
- Given a content admin on the Question Bank screen of a course with 120 questions
- When they upload a 50-row CSV that matches the import template
- And confirm the preview
- Then the bank shows 170 questions and a toast says "50 questions imported"
- Source: #123 description: "admins need to load a full chapter at once"
- Verify: manual, upload the 50-row sample CSV on staging and check the bank count and toast
```

- Heading: `### AC-<n> [tag] [tag] <title>`. At least one tag. Tags: `[happy]`, `[edge]`, `[error]`, `[perm]`, `[empty]`, `[perf]`, `[a11y]`.
- `- Given`, `- When`, `- Then` each exactly once; `- And` extends the clause above it.
- Concrete values: a real user type, real data shape and size, real screen or endpoint name. Never "the system" or "the user".

### Non-behaviour AC (analytics, flag, docs, monitoring)

```markdown
### AC-6 [happy] Import outcome is tracked
- [ ] A `question_import_completed` analytics event fires with row count and error count
- Source: #123 description: "we need to see how long imports take and how often they fail"
- Verify: event visible in the analytics debugger after one staging import
```

One `- [ ]` checkbox statement replaces Given/When/Then. Tags are optional here.

### Every live AC

- `- Source:` where the AC came from: a ticket quote, a Slack or meeting quote with link, "user, this session (YYYY-MM-DD): <quote>", existing behaviour (`path/file.ts:42`), or a linked doc. No source means it is an assumption: put it under Open questions instead. Placeholders (`TBD`, `assumption`, `none`) fail the check.
- `- Verify:` how the user checks it: a manual step, a test, a screenshot, or a log or metric.
- The heading, Given/When/Then and checkbox text must not name files, functions or line numbers (`foo.ts`, `bar()`, `x.ts:12`). Those belong in Source.

### Ids, superseding and waivers

- Ids run `AC-1` to `AC-n` in document order with no gaps or duplicates. Once the spec is approved, never renumber.
- To retire an AC, strike the heading through and give the reason; it keeps its id and is exempt from the other checks:
  ```markdown
  ### ~~AC-4 [edge] Duplicate questions are merged~~
  - Superseded: user, 2026-10-12: duplicates are flagged instead of merged (see AC-7)
  ```
- At least one live AC must carry `[edge]` or `[error]`. If the user waives this, add a line `Waived: <reason, who, date>` inside the Acceptance criteria section.

## `spec.ts acs --json` output

```json
[{ "id": "AC-1", "title": "…", "tags": ["happy"], "kind": "behaviour",
   "given": "…", "when": "… and …", "then": "…", "check": null,
   "source": "…", "verify": "…", "superseded": false, "reason": null }]
```

`kind` is `behaviour` or `check`; `check` holds the checkbox text for check ACs (Given/When/Then are null). Superseded ACs are included with `superseded: true` and their `reason`, so consumers can show history but must not plan work for them.
