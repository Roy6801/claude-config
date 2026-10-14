# `debug.md` template

The running record of one investigation. Update it after every probe, so a compaction or a new session loses nothing. Pointers and short excerpts only; never paste long logs, secrets or `.env` content.

```markdown
# Debug: <symptom in a few words>
Status: investigating | loop-built | root-caused | fix-planned | fixed | parked
Updated: <local date and time> · Ticket: <key or —> · Source: <qa report, Sentry id, user report>

## Symptom
Expected: <…>
Actual: <exact error, wrong output or timing>
Where and when: <surface, environment, since when, how often>

## Feedback loop
Command: `<one command>`
Last run: <red | green> · <date> · <the key output line>
Minimised to: <the smallest scenario that still goes red>

## Evidence
- <finding> · <link, command + output line, or file:line>

## Hypotheses
| # | Hypothesis | Prediction (if X, then changing Y makes it disappear) | Status |
|---|---|---|---|
| 1 | <…> | <…> | open / confirmed / ruled out |

## Ruled out
- H<n>: <why, with the evidence that falsified it>

## Next check
<the single next probe and which hypothesis it splits>

## Data requests
- <date> · <question> · <answer, or "waiting on user">

## Root cause
<one paragraph, filled once confirmed: the cause, why it produced this symptom, and why it was not caught>

## Fix
Plan: <pair slice / commit> · Regression test: <file and name, or "no correct seam: why"> · Commit: <sha>
Cleanup: <[DEBUG- tags removed: yes/no> · Original loop green: <yes/no>
```
