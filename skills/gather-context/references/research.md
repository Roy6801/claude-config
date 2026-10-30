# Research mode

Answers one outside-the-repo question with a cited brief: how a library, framework or service behaves at the installed version, prior art, best practice, or a library choice. Follows `source-driven-development`: official docs first, then the project's source, issues and releases, then changelogs and blogs, then community posts labelled lower confidence. One `general-purpose · sonnet · high` agent per question follows this file; it writes only its brief.

## Input

- **Kind**, detected from the question by the caller: `requirements` when it asks how others solve something; `debug` when it describes a symptom or unexpected behaviour of a library; `library <name>` when it weighs adopting or replacing a library; `best-practices` otherwise. A question that spans kinds is split, one agent per kind.
- **Question** and the **decision** it feeds
- **Repo path** (or "none")
- **Output path** for the brief
- **Links** the user already gave (read these first)

## 1. Pin versions (when a repo path is given and versions matter)

Find what is actually installed, in this order: the package's own `node_modules/<pkg>/package.json` `version`; the lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`); the range in `package.json` (say it is a range). For a runtime or CLI (bun, node), run its `--version`. Record where each version came from. Never assume "latest".

Find the source repo from the package's `package.json` `repository` field, or from the registry metadata (`https://registry.npmjs.org/<pkg>/<version>`, fetched read-only). Never run `npm` or `npx`.

## 2. Gather, in source priority order

1. **Official docs and llms.txt**: context7 (`resolve-library-id`, then `query-docs` with a focused query; include the version when the library id has versions). Then the project's own `llms.txt` or docs pages.
2. **GitHub, read-only through `gh`**: source at the installed tag (`gh api repos/<o>/<r>/contents/<path>?ref=<tag>`, or the local copy under `node_modules`), issues (`gh search issues --repo <o>/<r> "<terms>" --state open`, then `--state closed`, then `gh issue view`), releases (`gh release list -R <o>/<r>`, `gh release view <tag> -R <o>/<r>`), and `CHANGELOG.md` at the relevant tags. Compare the installed tag with the latest when behaviour may have changed.
3. **Changelogs and blogs**: the project's or vendor's announcements and migration guides.
4. **Community**: Stack Overflow, Hacker News, X, Reddit, personal blogs, through WebSearch. Label every one `community` (lower confidence) and look for an official or source confirmation before relying on it.

Fetching pages: if a `firecrawl` command exists (`command -v firecrawl`), prefer `firecrawl scrape <url>` for JavaScript-heavy pages; otherwise use WebFetch.

Kind focus:
- `requirements`: how 3 to 5 credible products or libraries solve it, the shared pattern, the trade-offs, and known pitfalls.
- `debug`: the code path at the installed version that produces the symptom (cite file and line at the tag), matching issues with their status and workaround, and the release that introduced or fixed it.
- `best-practices`: the official recommendation for the installed versions, where community practice differs, and why.
- `library <name>`: fit for the need, maintenance health (last release, release cadence, open vs closed issue trend, maintainers), licence, bundle or runtime cost where relevant, and 1 to 3 alternatives.

Stop when the question is answered with official or source evidence, or when further searching only repeats what you have. Cap yourself at roughly 25 fetches.

## 3. Write the brief

Follow the template below exactly. Write only to the output path you were given. Every finding cites a numbered source with its URL, tier, version or date, and access date. When sources disagree or nothing authoritative exists, say so under Gaps and conflicts.

## 4. Return

At most 150 words: the answer, its confidence and why, the strongest source, any important gap, then the brief's absolute path.

## Rules

- `gh` is read-only: `gh api` GET requests only (never `-X POST`, `PATCH`, `PUT` or `DELETE`, and no `-f`/`-F` fields without `-X GET`), `gh search`, `gh issue view|list`, `gh release view|list`, `gh repo view`. Never comment, react, star, fork, or open anything.
- Bash is for reading, version checks, and small throwaway repros in a fresh `mktemp -d` directory outside any repo (cite them as `source`, delete them afterwards). The only lasting file you write is the brief.
- Never read `.env` files or touch a database.
- Never present memory as a source. If you cannot cite it, leave it out or list it under Gaps.

## Brief template

Every finding cites a numbered source. Confidence follows the source tier: `official` (the project's docs or llms.txt), `source` (the project's code, issues, releases or changelog at a stated version or date), `secondary` (maintainer or vendor blog, conference talk), `community` (Stack Overflow, Hacker News, X, Reddit, personal blogs). A recommendation never rests on community sources alone.

```markdown
# Research (<kind>): <question>
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
