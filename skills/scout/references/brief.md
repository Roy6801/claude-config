# Research brief template

Every finding cites a numbered source. Confidence follows the source tier: `official` (the project's docs or llms.txt), `source` (the project's code, issues, releases or changelog at a stated version or date), `secondary` (maintainer or vendor blog, conference talk), `community` (Stack Overflow, Hacker News, X, Reddit, personal blogs). A recommendation never rests on community sources alone.

```markdown
# Scout (<mode>): <question>
Generated <local date and time> · Feeds: <the decision this informs> · Repo: <path or none> · Installed: <package@version from where, or n/a>

## Answer
<at most 5 lines: the direct answer, then the one caveat that matters most>
Confidence: <high | medium | low>, because <tier of the strongest sources and whether they agree>

## Findings
1. <finding in a sentence or two> [1][3] · <official | source | secondary | community>
2. …

## Version context
<what differs between the installed version and the latest, with the release or changelog entry that changed it; "n/a" when versions do not matter>

## Options
<requirements and library modes: each option with fit, cost and risk, then a recommendation and what would change it; omit in other modes>

## Gaps and conflicts
- <what could not be confirmed, or where sources disagree, with both citations>

## Sources
[1] <title> · <url> · <tier> · <version, tag or commit, or the page's date> · accessed <YYYY-MM-DD>
```
