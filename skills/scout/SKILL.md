---
name: scout
description: |
  Outside-the-repo research with citations. Dispatches the `scout` agent to write a research brief in one of four modes: `requirements` (prior art, how other products and libraries solve it), `debug` (a library's source at the installed version, matching open and closed issues, release notes and changelog), `best-practices` (official guidance first), and `library <name>` (fit, maintenance, versions, alternatives). Sources in priority order: official docs and llms.txt through context7, GitHub source, issues and releases through read-only `gh`, changelogs and blogs, then community posts flagged as lower confidence. The brief is saved to the initiative directory and the caller gets 150 words plus the path.

  Use when: `debug` needs a library's real behaviour, `spec` or `pair` needs prior art or a library decision, asked "how do others do X", "what's the best practice for X", "is library X a good fit", "is this a known bug in X", "what changed in X between versions", or `/scout <mode> <question>`.
user-invocable: true
metadata:
  origin: local
---

# Scout

Answer one outside-the-repo question with a cited brief, so decisions rest on sources rather than memory. The `scout` agent (`$CLAUDE_CONFIG_DIR/agents/scout.md`) does the research; this skill frames the question, picks where the brief goes, and relays the result. Scout is read-only: it never posts, comments, stars, opens issues, or changes the repo.

## Modes

| Mode | Argument | The brief answers |
|---|---|---|
| `requirements` | the feature or problem | How other products and libraries solve it, the common patterns and their trade-offs, and pitfalls others hit |
| `debug` | library plus symptom | What the library's source at the installed version actually does, which issues match (open and closed, with their fixes or workarounds), and which release changed the behaviour |
| `best-practices` | the topic | What the official docs recommend, where community practice differs, and what applies to this repo's versions |
| `library <name>` | the need it would fill | Fit for the need, maintenance health (release cadence, open issues, bus factor), the versions involved, licence, and alternatives |

## Flow

1. **Frame.** Turn the request into one question with the mode, what decision it feeds, and the repo path when versions matter. If the question is really several independent questions, split them and dispatch one agent per question in parallel.
2. **Pick the output path.** Run `bun $CLAUDE_CONFIG_DIR/bin/work.ts current --json`. With an active initiative, the brief goes to `<dir>/scout-<topic-slug>.md`; otherwise to `$CLAUDE_CONFIG_DIR/state/context/<YYYY-MM-DD>-scout-<topic-slug>.md`. The slug is kebab-case, at most 40 characters. A rerun on the same topic overwrites the brief.
3. **Dispatch** the `scout` agent with: mode, question, the decision it feeds, the repo path (or "none"), the output path, and any links the user already gave. When the `scout` agent type is not available in the session, dispatch a general-purpose agent on `sonnet` whose prompt tells it to read `$CLAUDE_CONFIG_DIR/agents/scout.md` and follow it exactly.
4. **Relay.** Give the caller the agent's summary (at most 150 words: the answer, its confidence, the strongest source) and the brief's path. Do not paste the brief. When the user will act on it directly, run the self-grill checklist (`$CLAUDE_CONFIG_DIR/skills/brainstorm/references/self-grill.md`) on the answer first and show the Grilled block.
5. **Offer** a private artifact page of the brief when the user wants to read or share it; publish only on a yes.

## Rules

- Installed versions come from the repo (lockfile, `package.json`, or the package's own `package.json` under `node_modules`), never from memory or "latest".
- Every finding in the brief carries a citation; community sources are labelled lower confidence and never stand alone behind a recommendation.
- Read-only everywhere: `gh` reads only, no writes to GitHub or any other connected service, no database access, no `.env` files.
- A gap is a finding: when sources disagree or nothing authoritative exists, the brief says so.
