# HLD

## Code work (feature, fix, refactor)

- Altitude: components, APIs, interfaces, data and decisions. File paths, function bodies and code belong to the PR plans.
- Vocabulary: `codebase-design` (module, interface, seam, depth); the project's glossary and ADRs through `domain-modeling`.
- Each part follows the skills for its kind: UI through `frontend-design` for direction, `impeccable` (shape) for states, the Figma skills when a design exists, and the stack's skills (Next.js, React, shadcn, Expo); APIs through `api-design-principles`; tables through `postgresql-table-design`; AI and LLM work through repo skills such as `braintrust-tracing`; any other repo skill that fits.
- Sections, each in bullets:
  - **Goal:** the outcome in one or two sentences, tied to the problem.
  - **Components:** each component that changes and what it is responsible for afterwards; the components that stay untouched.
  - **APIs and interfaces:** every contract other code depends on: signatures, types, payloads, schema changes, events. Written exactly, since PRs build against them.
  - **Data flow:** how data moves through the changed components, as ordered bullets from trigger to result.
  - **Decisions:** each real choice with the alternatives rejected and why.
  - **Risks:** security, performance, migrations, other repos and teams affected, each with its mitigation.
  - **Testing and evidence:** per component, what proves it works: tests at which seam, browser checks, screenshots, video, numbers, evals.

## Other work

- Write the design that fits the kind of work: what gets produced, how it is structured, what it takes in and puts out.
- Every variant ends with **Decisions**, **Risks** and **Verification** (how the result is shown to be right).
- Shapes by kind:
  - **Investigation:** questions to answer, hypotheses, evidence sources, method, deliverable.
  - **Data or pipeline:** stages, inputs and outputs, schedule, failure and retry handling, backfill.
  - **Infra or config:** resources and environments touched, the change, rollout and rollback.
  - **Docs:** audience, outline, sources, where it lives.
  - **QA or testing:** scope, cases, environments, tooling, pass criteria.
