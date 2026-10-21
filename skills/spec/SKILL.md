---
name: spec
description: |
  Turn an approved roadmap item, a brainstorm proposal, a Linear ticket or GitHub issue, or a narrated request into a spec with testable, grounded acceptance criteria (AC-1…n, each with a Source and a Verify) before any code. The requirements, ACs and definition of done live in the local spec.md; they can optionally be mirrored, after approval, to the Linear ticket (through `ticket`, when Linear is connected) or a GitHub issue. Huge work, 5 or more PRs, gets the longer `prd` spec, kept locally. Later steps (pair, ship, review, qa, done) consume its ACs through `spec.ts acs`.

  Use when: a roadmap item is "requirements" or "spec", the user asks to "write the spec", "write a PRD", "define the acceptance criteria", "what exactly are we building", or runs `/spec [issue|slug|"text"]`, `/spec check`, or `/spec acs`.
user-invocable: true
metadata:
  origin: local
---

# Spec

Requirements come before code. This skill turns a request into a spec whose acceptance criteria (ACs) are concrete, sourced, and checkable, so every later step can trace back to an AC id. It owns the spec draft and the optional GitHub issue text; it does not plan slices or write code.

The working draft lives at `$CLAUDE_CONFIG_DIR/state/work/<slug>/spec.md`, next to the initiative's roadmap and decision log; `spec.ts check` and `spec.ts acs` read it. The spec is the source of truth; the Linear ticket (when Linear is connected) or a GitHub issue is an optional mirror for others to see. The format, with every rule the checker enforces, is in `references/template.md`; worked examples are `references/examples/ticket.md` and `references/examples/prd.md`. Read the template before drafting.

```bash
bun $CLAUDE_CONFIG_DIR/skills/spec/scripts/spec.ts <check|acs|status>   # run with no arguments for usage
bun $CLAUDE_CONFIG_DIR/bin/work.ts <current|new|decide>                 # initiative state
```

## Modes

- `/spec [issue|slug|"text"]`: write a new spec, or continue the current initiative's spec.
- `/spec check`: run `spec.ts check` on the current spec, then the anti-slop review below, and report both.
- `/spec acs`: run `spec.ts acs <slug>` for the current initiative and print the ACs.

## Size

Size is the number of PRs the work needs, not days; a 2 to 3 day task is normal. Estimate the PRs from the slices the ACs imply, using the `ship` skill's PR size budget. Propose the size with a one-line reason, let the user confirm it, and log it with `work.ts decide`.

- **`size: ticket`** (fewer than 5 PRs): Problem (asked vs real), ACs, non-goals, the DoD items that apply, open questions, Grilled.
- **`size: prd`** (huge: 5 or more PRs): adds journey, MVP, success metric, risks and constraints, demo milestones, and release notes (flag, rollback). A longer spec for work of 5+ PRs, kept locally like the rest.

## Flow

1. **Load.** Run `work.ts current --json`. If an initiative is active, read its `roadmap.md` and `decisions.md`, and an existing `spec.md` if there is one (continue it; never start over). If nothing is active, offer `work.ts new <slug> --title "<title>"`. Quick-read what the user pointed to (a Linear ticket through `ticket` read mode, an issue through `gh issue view`, a thread, a PR). For anything broader, run the `gather-context` skill in `topic` mode, and its `conventions` mode when the spec touches an existing repo. Read the bundle's summary, not the raw source files.
2. **Grill.** Read `$CLAUDE_CONFIG_DIR/skills/grill-with-docs/SKILL.md`: it points to `grilling` and `domain-modeling`, so read and follow `$CLAUDE_CONFIG_DIR/skills/grilling/SKILL.md` and `$CLAUDE_CONFIG_DIR/skills/domain-modeling/SKILL.md` directly (they cannot be invoked as skills). Cover at least: one "why" for the XY check (asked vs real problem), scope and non-goals, the success metric, the number of PRs, and the domain terms that need a glossary entry. Ask **one question at a time**, with your recommended answer first, so each answer can reshape the next question. Look facts up yourself (or through an agent); only decisions go to the user. Log each decision as it is made with `work.ts decide - --title … --chosen … --why …`.
3. **Draft.** Write `spec.md` from `references/template.md` (`ticket` or `prd`). Rules for ACs:
   - Behaviour ACs use Given / When / Then with concrete values: a real user type, a real data shape and size, a real screen or endpoint name from the product. Non-behaviour ACs (analytics, flag, docs, monitoring) are one checkbox statement.
   - Every AC has a `Source:` (issue quote, a thread or meeting quote with link, the user's statement in this session with the date, existing behaviour as `file:line`, or a linked doc) and a `Verify:` (manual step, test, screenshot, log or metric) that a PM or QA can follow.
   - A candidate AC with no source is an assumption: list it under Open questions, never as an AC.
   - Keep AC text mid-to-high level, readable by PM and QA. File, function and line references go in `Source:` only.
   - Tag each behaviour AC (`[happy]`, `[edge]`, `[error]`, `[perm]`, `[empty]`, `[perf]`, `[a11y]`). Include at least one `[edge]` or `[error]` AC unless the user waives it (record the waiver line).
   - Definition of done: list the DoD items that apply to this work, as checkboxes.
4. **Self-grill.** Run `$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md` on the spec, then the anti-slop review: drop or rewrite any AC that restates the title, cannot fail, or only tests the framework (for example, "the upload uses the standard file picker"). Put the results in the spec's `## Grilled` section: what was challenged, what changed, and what was dropped as slop.
5. **Check.** Run `spec.ts check <spec.md>`. It must pass; fix every line it prints and run it again.
6. **Review.** Show the spec to the user. Offer a private artifact page for reading or sharing it. Apply the user's edits, re-run the check, and repeat until they approve. On approval, run `spec.ts status <spec.md> approved` and `work.ts decide - --title "Spec approved" --chosen "<slug> spec, <n> ACs" --why "<user's words>"`.
7. **Ticket or issue (optional).** Both bodies use the same content: the Problem (real problem first, then what was asked), Acceptance Criteria as one `- [ ] AC-<n> <title>` checkbox per live AC with its Given/When/Then (or statement) and Verify under it, then `## Non-goals`, `## Definition of done` (the spec's checkboxes) and, if any, `## Open questions`. For an existing ticket or issue, fetch it first, show what changes, and keep anything the spec does not replace. Show the exact text; write only after the user approves it.
   - **Linear connected:** draft in the `ticket` skill's format (Purpose, Business Use Case, User Stories, then the above) and hand the approved text to `ticket` to create or update.
   - **Otherwise:** a GitHub issue through `gh issue view`, then `gh issue create` or `gh issue edit` (body from a file).
   Write the ticket key or issue number into the `ticket:` front matter key and re-run the check.
8. **Hand off.** When the roadmap already lists the PRs, the next step is `/pair plan <slug>` for the next PR; otherwise `/roadmap <slug>` (or `/roadmap resume <slug>`) places these AC ids on the roadmap's PRs. Offer the `handoff` skill first (a fresh session).

## Changing an approved spec

Never renumber ACs. Add new ACs at the end. To retire one, strike its heading through and add `- Superseded: <who, date, reason>`. Set the status back with `spec.ts status <spec.md> draft`, get the change approved, log it with `work.ts decide`, then approve again. When a ticket or issue mirrors the spec, show the user the matching change and apply it only with their approval (through `ticket` for Linear, `gh issue edit` otherwise).

## Rules

- Linear and GitHub issue writes happen only after the user approves the exact content. Reading is fine at any time.
- Never touch an application database. If an AC needs a fact from data, write a data request for the user to run, and keep the AC under Open questions until the answer arrives.
- Keep the spec out of repositories and `.git`. It lives under `$CLAUDE_CONFIG_DIR/state/work/<slug>/`.
- Write the spec in full, clear sentences. It is read by PMs, QA and reviewers, not only by you.
