# Suggested fixes

Every `assert` comment carries a fix the author can take. An `ask` comment carries one only when there is a leading option, framed as one option among others. When the fix is a design choice the author should make, name the options in its place.

## Pick the form by where the fix lives

- **GitHub suggestion block**, when the whole fix sits inside the anchored lines. The author applies it in one click.

  ````markdown
  ```suggestion
  <full replacement for the anchored lines>
  ```
  ````

  - The block replaces exactly `start_line` to `line`, so narrow the anchor to exactly the lines being replaced.
  - Write the full replacement for those lines. Copy the file's indentation byte for byte; tabs pasted as spaces show up as a whitespace diff.
  - One block per comment. Two blocks in one comment both target the same range.
  - It compiles on its own. A fix that needs a new import, a changed signature elsewhere, or an edit outside the anchor takes a `diff` block.
- **Fenced `diff` block**, when the fix spans files, needs imports, or touches lines outside the diff. Unified diff against the head SHA, paths from the repo root, trimmed to the hunks that matter. It is applied by hand, so it reads clearly as a patch.

For both:

- The smallest change that fixes the finding, touching only what the comment asks for.
- Follow the target repo's style: its naming, its existing helpers, its comment policy. A fix that breaks the repo's own conventions is a new finding against the reviewer.
- The prose carries the finding: the problem and its consequence first, then the fix, introduced plainly ("Something like:").

## Verify before showing

Show only fixes that apply cleanly at the head SHA and pass lint and typecheck.

```bash
wt new --detach <head sha> --name scratch-<short sha> --no-install   # worktree skill; prints the worktree path
git -C <path> apply --check fix.diff && git -C <path> apply fix.diff                # diffs; for a suggestion, write the replacement into the file
```

Then run the repo's formatter or linter on the touched files (the commands from the conventions bundle, through `nr`; installing dependencies in the scratch worktree needs the user's OK), and typecheck. Monorepos often need generated workspace types before typecheck can pass (an unresolved `@scope/pkg/types` is the tell): run the repo's codegen or build script for them in the scratch worktree first. When that is impractical, typecheck the clean head, then each fix, and report "no new errors against a failing baseline of N". Record what each fix was verified with and what was not checked. Remove the worktree afterwards: `wt rm scratch-<short sha> --force`.
