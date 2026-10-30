# Thermo rubric

The review standard behind `thermo`. Findings use the schema in `findings.md`. Ask every question of every meaningful change.

## Standards

Each standard: the smell, the question, the remedy.

0. **Structural simplification.**
   - Smell: a complicated implementation, or a refactor that moves code around without cutting the concepts a reader must hold.
   - Question: is there a code-judo move, a reorganization that uses the existing architecture so whole branches, helpers, modes or layers disappear? Would fewer concepts do the job?
   - Remedy: delete a layer of indirection; reframe the state model so conditionals disappear instead of being centralized; change the ownership boundary so the feature extends an existing abstraction; turn special cases into a simpler default flow. Rename-level feedback is not enough when the issue is structural.

1. **File size.**
   - Smell: a change pushes a file from under 1000 lines to over 1000.
   - Question: should the code be decomposed first? Waive only for a compelling structural reason with the file still clearly organized.
   - Remedy: extract helpers, subcomponents or modules; split into focused files.

2. **Spaghetti growth.**
   - Smell: ad-hoc conditionals, one-off booleans, nullable modes, flags, scattered special cases, edge-case handling mid-function, or "temporary" branching in unrelated flows. These are design problems, not nits.
   - Question: did the diff add branching where an abstraction should exist? Did a cohesive module become more coupled, more stateful or harder to scan? Do repeated conditionals signal a missing model or helper?
   - Remedy: move the logic behind a dedicated abstraction, state machine, policy object or module; replace condition chains with a typed model or explicit dispatcher; collapse duplicate branches.

3. **Design over "it works".**
   - Smell: a working implementation that leaves the codebase messier, or tests that pass on less modular code.
   - Question: can behavior stay the same while the structure gets meaningfully cleaner?
   - Remedy: prefer simplifications that remove moving pieces over refactors that spread the same complexity around.

4. **Direct, boring code.**
   - Smell: brittle, ad-hoc or magic behavior; generic mechanisms hiding simple data shapes; thin wrappers, identity wrappers and pass-through helpers; copy-pasted logic.
   - Question: is the abstraction earning its keep, or is it a wrapper? Is the flow legible, or does it lean on special cases and incidental control flow?
   - Remedy: delete wrappers that do not clarify the API; extract a helper or pure function for copies.

5. **Types and boundaries.**
   - Smell: needless optionality, `unknown`, `any`, casts, loosely shaped ad-hoc objects, silent fallbacks over an unclear invariant.
   - Question: could a clearer type boundary exist, so the real invariant shows?
   - Remedy: explicit typed models or shared contracts; make the boundary explicit so control flow simplifies.

6. **Canonical layer.**
   - Smell: feature logic in shared paths, implementation details leaking through APIs, bespoke helpers where a canonical one exists, logic in the wrong package.
   - Question: does this logic live in the right file and layer?
   - Remedy: reuse the canonical helper; move the logic to the module that owns the concept.

7. **Orchestration and atomicity.**
   - Smell: independent async work serialized for no reason; related updates that can leave state half-applied.
   - Question: is this more sequential or less atomic than it needs to be? Skip micro-optimizations; flag only when the cleaner structure is obvious.
   - Remedy: parallelize independent work when that also simplifies the flow; restructure related updates into an atomic one; separate orchestration from business logic.

## Tone

Direct, serious, demanding, never rude. Name a structural problem as one; do not soften it. Say so when a dramatic simplification was missed. Sample phrases:

- `this pushes the file past 1k lines. can we decompose this first?`
- `this adds another special-case branch into an already busy flow. can we move this behind its own abstraction?`
- `this works, but it makes the surrounding code more spaghetti. let's keep the behavior and restructure the implementation.`
- `why does this need a cast / optional here? can we make the boundary more explicit instead?`
- `i think there's a code-judo move here that makes this much simpler. can we reframe this so these branches disappear?`
- `this refactor moves complexity around, but doesn't really delete it. is there a way to make the model itself simpler?`

## Output priority

1. Structural regressions
2. Missed code-judo simplifications
3. Spaghetti and branching growth
4. Boundary, abstraction and type-contract problems
5. File size and decomposition
6. Modularity and abstraction issues
7. Legibility

Prefer a few high-conviction findings over a flood of nits.

## Approval bar

Behavior that seems correct is not enough to approve. Approve only when none of these presumptive blockers applies, unless the author justifies it clearly:

- incidental complexity preserved where a plausible code-judo move would delete it
- a file pushed from below 1000 lines to above
- ad-hoc branching that tangles an existing flow
- feature checks scattered across shared code
- an unnecessary abstraction, wrapper or cast-heavy contract that adds indirection
- a duplicated existing helper, or logic in the wrong layer with a clear canonical home

When none applies, leave explicit, actionable feedback and push for a cleaner decomposition.
