# Debug outputs: data request, write-up

## Data request

The user runs every database access; this skill only writes the request. Show it in chat and record it in `debug.md`.

```markdown
**Data request** (<date>, for <debug.md path>)
Question: <the fact needed, in one sentence>
Why: <which hypothesis it confirms or rules out, and what each answer would mean>
Where: <environment, and the table or collection if known>
Suggested query (for you to review and run; I have not run it): <SQL or query text, read-only, scoped by id or time window, with a LIMIT>
What to send back: <the rows or counts needed, with anything sensitive redacted>
```

## Write-up for others (SOAP)

For the ticket, a GitHub issue comment or the PR body, once the fix has landed. Plain language first; links carry the detail.

```markdown
**<Bug title>** · <issue> · Fixed in <PR or commit link>

**Subjective** (what was reported): <who saw what, where, since when, how many were affected>
**Objective** (what the evidence showed): <the reproduction, the key log, trace or Sentry event, each with a link>
**Assessment** (root cause): <the cause in two or three sentences, and why it produced this symptom; the hypotheses ruled out, in one line>
**Plan** (what changed and what follows): <the fix, the regression test, how to verify it, any follow-up issue, and what would have prevented it>
```
