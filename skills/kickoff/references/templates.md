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

Status is one of `planned | plan approved | building (step <n> passed) | ready #<n> (step <n> passed) | ready #<n> (shipped) | merged`.
```

## hld.md

The HLD section of the approved plan under a dated heading. Later changes add new dated notes below it.
