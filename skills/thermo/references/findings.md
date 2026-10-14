# Structured findings

One schema for every machine-readable review in this setup: `thermo` in structured mode, the `reviewer` agent, and the `review` skill that consumes both. Keep it identical everywhere so findings from different passes can be merged and deduplicated.

## Shape

Return one JSON object and nothing around it when a caller asks for structured output:

```json
{
  "range": "origin/staging...cc31a01",
  "summary": "At most 100 words: the overall verdict, the one or two findings that matter most, and anything you could not check.",
  "findings": [
    {
      "file": "apps/hub/src/server/citations.ts",
      "line": 140,
      "severity": "major",
      "category": "atomicity",
      "claim": "Regeneration deletes the old citations before inserting the new ones, outside a transaction.",
      "evidence": "apps/hub/src/server/citations.ts:132-140 deletes then inserts; the sibling write in apps/hub/src/server/notes.ts:88 wraps both in db.transaction().",
      "suggestion": "Wrap both writes in db.transaction(), as notes.ts:88 does.",
      "confidence": "high"
    }
  ]
}
```

Field rules:

- `file` is the path from the repo root. `line` is a line number on the new side of the diff (the head), or on the old side only when the finding is about deleted code; say which in `evidence`.
- `claim` is one sentence a reader can check. No hedging adjectives.
- `evidence` cites at least one `path:line` (or `path:start-end`). A convention claim also cites the convention's source: a `CLAUDE.md` or `AGENTS.md` line, a conventions-bundle entry, or the call-site count of a canonical helper. A finding without `path:line` evidence is not a finding; drop it.
- `suggestion` is the smallest change that fixes it, in one or two sentences. When the fix is a design choice the author should make, name the options instead.
- Sort findings by severity, then by confidence.

## Severity

Severity answers "how bad is this if it is real". Confidence is a separate axis; never let one stand in for the other.

| Severity | Meaning | Examples |
|---|---|---|
| `blocker` | Must change before merge. | Irreversible data loss or exposure on a normal path; a missed acceptance criterion; any thermo presumptive blocker (a file pushed past 1000 lines, ad-hoc branching tangling an existing flow, feature checks scattered across shared code, a duplicated canonical helper or logic in the wrong layer, a plausible code-judo move left on the table). |
| `major` | Should change in this PR unless the author justifies it. | Wrong behaviour on a reachable path with a plausible trigger; a structural regression; an unexplained convention deviation; non-trivial logic with no test. |
| `minor` | Worth fixing, fine as a follow-up. | Recoverable or unusual-trigger misbehaviour; a consistency gap with no runtime consequence; a thin wrapper or a needless cast. |
| `nit` | Cosmetic or taste. | Naming, ordering, a comment. |

## Category

One of: `structure`, `simplification` (a code-judo move), `spaghetti` (ad-hoc branching), `boundary` (types, casts, optionality, contracts), `layering` (wrong module, leaked details, duplicated canonical helper), `file-size`, `atomicity` (non-atomic updates, needless sequencing), `legibility`, `convention` (departs from a repo convention), `correctness`, `security`, `tests`, `ac` (acceptance-criterion conformance), `hygiene` (debug leftovers, commented-out code, secrets).

## Confidence

- `high`: verified against the code at the cited lines and, for a convention claim, against the convention's source.
- `medium`: the cited code supports it, but a fact outside the diff could change it (a caller not read, a service outside the repo). Name that fact in `evidence`.
- `low`: plausible from the diff alone, not verified.

## Filters before returning

- Drop every `nit` with `low` confidence. Keep at most 5 nits in total.
- Drop anything that follows an established repo convention, or where the surrounding code does less than this change does (the change improved on its baseline). If it is worth saying, mention it in `summary` as pre-existing and repo-wide.
- Merge findings that share a root cause into one, citing every location in `evidence`.
- An empty `findings` array is a valid result. Say why in `summary`.
