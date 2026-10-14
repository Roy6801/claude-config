# GitHub calls

All writes run only after the user approved the exact batch. `{owner}/{repo}` and `{n}` come from `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json` (`repo`, `number`, `headSha`).

## Who am I

```bash
gh auth status            # the active account must be the one the user reviews as in this repo
gh api user --jq .login
```

## Existing threads (dedupe input and verification)

`gh-activity pr <n> --json` returns `threads.items[]` with `isResolved`, `isOutdated`, `path`, `line`, `resolvedBy`, and `comments[{author, body, createdAt, url}]`. A comment's numeric id is the number after `#discussion_r` in its `url`. Top-level comments and review bodies: `gh pr view <n> --json comments,reviews`.

## New review: inline comments plus an optional summary

Post once, as a single review, never one call per comment:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/{n}/reviews --input review.json
```

```json
{
  "commit_id": "<full head sha>",
  "event": "COMMENT",
  "body": "<summary, or omit the field>",
  "comments": [
    { "path": "path/to/file.ts", "start_line": 81, "line": 120, "side": "RIGHT", "start_side": "RIGHT", "body": "..." }
  ]
}
```

Single-line comments omit `start_line` and `start_side`. Build the JSON with `jq -n --rawfile` per body so backticks and quotes in the markdown survive, and write it to the scratchpad, not the repo.

- `event` is `COMMENT`. `APPROVE` or `REQUEST_CHANGES` only when the user explicitly asks.
- The API rejects the whole review if one anchor is not in the diff, so check anchors first.

## Replies in existing threads

```bash
gh api -X POST repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies -F body=@reply.md
```

`{comment_id}` is the id of any comment in the thread (use the first). There is no batch call for replies: post the approved batch one reply at a time, stop at the first failure, and report what landed and what did not.

## Top-level summary comment (replies mode, when the user wants one)

```bash
gh pr comment <n> --body-file summary.md
```

## Resolving a thread (own PR only, per-thread approval)

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url}}}}}}}' -F o=<owner> -F r=<repo> -F n=<n>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread node id>
```

Match the thread by its first comment's `url`.

## Editing a posted comment

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/comments/{comment_id} -F body=@body.md
```

The anchor cannot move on an edit, so a suggestion block added later can only replace the lines the comment is already anchored to; anything wider goes in as a `diff` block.

## Verify

Re-run `gh-activity pr <n> --json` and confirm every posted comment or reply appears with the user's login, at the intended path and line, with the approved body. Report the comment URLs.
