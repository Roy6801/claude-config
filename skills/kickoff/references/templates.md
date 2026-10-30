# Kickoff templates

Plain sentences and bullets, behaviour-level. Code and wide tables belong in later PR plans.

## Plan

```markdown
<!-- roadmap: <project>/<slug> -->
# <Title>

## Problem
Two or three sentences.

## Shape of the work
### <Part> (<why it comes at this point in the order>)
- <what changes>

## HLD
Sections per `references/hld.md` for the kind of work.

## Milestones
### <Milestone> (what goes live together)
- <pr-name>, <pr-name>

## PRs
### <pr-name>
- **Does:** one or two sentences.
- **Size:** about <n> lines of code.
- **Depends on:** <pr-name>, or nothing.
- **Ticket:** <id>, or none yet.
- **Evidence:** what will prove it.

## Size decisions
### <part>
- Split points and the size of each piece.
- Independent PRs: <trade-off>.
- Stacked PRs: <trade-off>.
- Recommended: <option>, because <reason>.

## Unresolved questions
```

## roadmap.md

```markdown
# <Title>

**Next:** <one next step, e.g. "Plan <pr-name> with /pickup <slug>">

## Problem
## Shape of the work
## Milestones
## PRs
**Parent ticket:** <id>, when one exists.

### <pr-name> (<status>)
- Does, size, branch (empty until `ship` records it), base or stack parent, ticket when known, evidence.
```

## Roadmap states

The single list of PR statuses. Kickoff, handoff, pickup and ship check a status against its proof here before trusting or writing it.

| Status | Proof | Set by |
| --- | --- | --- |
| `planned` | the PR's record in `roadmap.md` | kickoff (Save plan); pickup when a later status lacks its proof |
| `pr plan approved` | `prs/<pr-name>/plan.md` | pickup (Plan), after the user approves the PR plan |
| `building (step <n> passed)` | `prs/<pr-name>/plan.md` and `brief.md`, the branch in `roadmap.md` | ship |
| `ready #<n> (step <n> passed)` | PR #<n> open (`gh pr view`) | ship |
| `ready #<n> (shipped)` | PR #<n> open, ship's End done | ship |
| `merged` | PR #<n> merged (`gh pr view`) | pickup |

- A status whose proof is missing is wrong: fall back to the latest status whose proof exists, and say so.
- The `**Next:**` line and `handoff.md` name a step only when its input exists: `/ship` needs `prs/<pr-name>/plan.md`; a `planned` PR's next step is "Plan <pr-name> with /pickup <slug>".

## hld.md

The HLD section of the approved plan under a dated heading. Later changes add new dated notes below it.
