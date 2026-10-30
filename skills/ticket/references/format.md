# Ticket format and writing rules

`ship` writes each PR's ticket in this format, and `to-spec` output maps onto it.

## Description

```markdown
## Purpose
<Why this work is being done: the real problem first, then what was asked if it differs>

## Business Use Case
<The business value or outcome this work enables>

## User Stories
- As a <user type>, I want to <action> so that <benefit>.

## Acceptance Criteria
- [ ] AC-1 <title>
  <Given / When / Then, or a plain statement>
  Verify: <how it is checked>
- [x] AC-2 <title, already met by the current code or PR>
```

When the text comes from `to-spec`, the ticket adds `## Non-goals`, `## Definition of done` (checkboxes) and, if any, `## Open questions` after the ACs, and links the PRD when there is one. A ticket without a spec may leave the AC ids out, but every AC is still a checkbox.

## Acceptance criteria

- Every AC is a checkbox. Tick one only when the current code or PR meets it.
- Write them at a level a PM, designer or QA person understands: what is achieved, not how. No file names, function names or implementation details.
- The list is living: add ACs as scope grows, strike through retired ones with a reason, never renumber.

## Titles

- Name the feature or behavior the ticket delivers, so it reads the same alone or as part of a larger effort.
- Sub-tickets carry no ordering in the title. Order lives in `blockedBy` relations and the parent link. Linear derives the branch name from the title, so a clean title keeps branch names clean.
- A child title describes only its own slice, never the parent's scope.

## Comments

- Start and finish comments are short: what happened, links (PRs, docs, QA report), what is next or left out.
- Quote error text and AC lines verbatim.
