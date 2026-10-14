# Self-grill

Run this checklist on your own output (a plan, a recommendation, a spec, a root cause, a review, a context summary) before you show it to the user. The user sees what turned up, so the checklist is not a private ritual: it ends in a visible "Grilled" block next to the work.

## Checklist

Ask each question of the output, answer it honestly, and fix the output when an answer exposes a problem. Fixing comes before showing.

1. **Weakest assumption.** Which assumption, if wrong, would sink this? Is it verified, or only plausible?
2. **Reviewer rejection.** What would a staff engineer or the code owner reject on first read?
3. **What breaks first.** Under real use (load, bad input, a concurrent edit, a missing permission, an empty state), what fails first?
4. **Evidence.** Is every claim backed by a file:line, a command output, a link, or a quote? Remove or mark anything that is not.
5. **XY check.** Does this solve what the user actually needs, or only the thing they literally asked for?
6. **Simpler path.** Is there a smaller change, an existing helper, or a convention that already does this?
7. **What would change my mind.** What single fact, if found, would flip the recommendation? Can it be checked now?

Skip a question only when it cannot apply (for example, "what breaks first" on a pure summary).

## Output

Show at most 6 bullets, each a question and its answer, chosen for what actually turned up. A bullet that only says "fine" is noise; leave it out unless the question was a real risk that checked out.

```markdown
**Grilled**
- Weakest assumption → <assumption>; <verified how, or "unverified: <how to check>">
- Reviewer would reject → <issue>; <fixed / kept because …>
- Breaks first → <failure>; <handled / open>
- Simpler path → <option>; <why not, or switched to it>
- Would change my mind → <fact>; <checked: result, or not checked>
```

When the grill changed the output, say what changed in one line under the block.

## Grilling the user (Matt's grill skills)

`grill-me` and `grill-with-docs` are user-invoked only (`disable-model-invocation`), so our skills do not call them; they follow the instructions directly:

- `grill-me` is the `grilling` skill. Read `$CLAUDE_CONFIG_DIR/skills/grilling/SKILL.md` and follow it: rounds over the design-tree frontier, numbered questions each with a recommended answer, facts looked up by sub-agents instead of asked.
- `grill-with-docs` is `grilling` plus `domain-modeling`. Read `$CLAUDE_CONFIG_DIR/skills/grilling/SKILL.md` and `$CLAUDE_CONFIG_DIR/skills/domain-modeling/SKILL.md` and follow both, so settled terms and decisions land in the glossary and ADRs as you go.

Use self-grill on your own output, and the grill skills on the user's plan or ask. They complement each other: grill the ask first, then grill your answer.
