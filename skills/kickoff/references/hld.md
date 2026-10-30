# HLD

- Depth: an outline of the agreed approach, a page or two. Each PR's plan in `/pickup` adds the detail for that PR; more depth here only when the user asks to dig in.
- Grounded in truth: every component, function, type, table, route or event it names exists in the code, checked by reading the code, or is marked new.

## Code work (feature, fix, refactor)

- Altitude: components, contracts, data and decisions. File paths, function bodies and code belong to the PR plans.
- Vocabulary: `codebase-design` (module, interface, seam, depth); the project's glossary and ADRs through `domain-modeling`.
- Each part follows the skills for its kind: UI through `frontend-design` for direction, `impeccable` (shape) for states, the Figma skills when a design exists, and the stack's skills (Next.js, React, shadcn, Expo); APIs through `api-design-principles`; tables through `postgresql-table-design`; AI and LLM work through repo skills such as `braintrust-tracing`; any other repo skill that fits.
- Sections, each in a few bullets:
  - **Approach:** the components that change and what each is responsible for afterwards, tied to the problem.
  - **Contracts between PRs:** each signature, type, payload, schema change or event one PR provides and a later PR builds on, with the PR that provides it and the PRs that consume it. Shown as its shape; the PR plan writes it out exactly.
  - **Data flow:** how data moves through the changed components, as ordered bullets from trigger to result.
  - **Decisions:** each settled decision with the alternative rejected and why, linking its wiki page.
  - **Risks:** only real ones (security, performance, migrations, other repos or teams affected), each with its mitigation; omit when there are none.

## Other work

- The shape that fits the kind of work, in outline: what gets produced, how it is structured, what it takes in and puts out.
- Every variant ends with **Decisions** and **Verification** (how the result is shown to be right).
- Shapes by kind:
  - **Investigation:** questions to answer, hypotheses, evidence sources, method, deliverable.
  - **Data or pipeline:** stages, inputs and outputs, schedule, failure and retry handling, backfill.
  - **Infra or config:** resources and environments touched, the change, rollout and rollback.
  - **Docs:** audience, outline, sources, where it lives.
  - **QA or testing:** scope, cases, environments, tooling, pass criteria.
