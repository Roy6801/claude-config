# Evidence

- Every PR shows the change working as a before and an after: the same item, page or input, captured both ways.
- Rank of evidence, highest first:
  - **Screenshots** of the before and after, when the change is visual and the app can run.
  - **Video** of a flow, narrated with terra-local, when the change is an interaction rather than a still state.
  - **Execution output**: the exact test that fails before the change and passes after (named, with what it asserts), or console output of the behaviour.
  - **Numbers**: a before-and-after table for performance or data work, vetted with `benchmark-checklist`; an eval table for AI and LLM work.
- Pick the highest rank the change and environment allow; combine ranks when one alone leaves doubt.
- Each piece carries one line of context: environment, data, build (for example "staging data, before on the staging deploy, after on a local build of this branch").
