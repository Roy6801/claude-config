# QA report template

Write the report in full sentences where a sentence is needed; tables carry the rest. Every claim links to evidence (GIF path, console or network excerpt, `file:line`, issue).

```markdown
# QA: <feature or slice> (<initiative slug or issue>)
Run <local date and time> · URL: <app url> · Browser: <claude-in-chrome | agent-browser> · Commit: <short sha> on <branch>

## Verdict per AC
| AC | Title | Verdict | Evidence | Ticket |
|---|---|---|---|---|
| AC-1 | <title> | pass / fail (N/N) / uncertain / not covered | <gif or excerpt> | <key or —> |

Overall: <green | N failing | N uncertain>. <one sentence on what blocks merge, if anything>

## Cases
| # | Case | AC | Kind | Status | Evidence / note |
|---|---|---|---|---|---|
| 1 | <case> | AC-1 or "no AC" | happy / error / edge / loading / empty / auth | pass / fail / uncertain / spec-ambiguity / out-of-scope | <link or excerpt> |

## Failures
### <case #>: <broken behaviour>
- Precondition: …
- Steps: 1. … 2. …
- Expected (`file:line`): …
- Actual: …
- Evidence: <GIF, console, network>
- Reproduced: N/N
- Ticket: <key> · Handed to debug: <yes, date>

## Uncertain findings
### <case #>: <symptom>
- Attempts and why each did not pin it down: …
- Evidence so far: …
- Status: cannot determine exact reproduction conditions; handed to debug.

## Code gaps
- <behaviour the code does not handle at all, with `file:line`>

## Spec ambiguities
- <question for the user or PM, with the AC id>

## Lasting tests
- <added: test file and name → AC id> or <offered, declined> or <none possible: reason>

## Re-verification
- <case #>: <now pass | still fail> after <fix commit>
```
