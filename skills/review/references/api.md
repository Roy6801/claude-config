# GitHub calls

Every write sends only a batch the user approved (`posting.md`). `{owner}/{repo}`, `{n}` and the head SHA come from `bun $CLAUDE_CONFIG_DIR/bin/gh-activity.ts pr <n> --json` (`repo`, `number`, `headSha`).

## Existing threads (dedupe input and verification)

`gh-activity pr <n> --json` returns `threads.items[]` with `isResolved`, `isOutdated`, `path`, `line`, `resolvedBy`, and `comments[{author, body, createdAt, url}]`. A comment's numeric id is the number after `#discussion_r` in its `url`. Top-level comments and review bodies: `gh pr view <n> --json comments,reviews`.

## New review: inline comments plus an optional summary

Post the batch as a single review in one call:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/{n}/reviews --input review.json
```

```json
{
  "commit_id": "<full head sha>",
  "event": "<the event stated at the checkpoint>",
  "body": "<summary, or omit the field>",
  "comments": [
    { "path": "path/to/file.ts", "start_line": 81, "line": 120, "side": "RIGHT", "start_side": "RIGHT", "body": "..." }
  ]
}
```

Single-line comments omit `start_line` and `start_side`. Build the JSON with `jq -n --rawfile` per body so backticks and quotes in the markdown survive, and write it to the scratchpad.

## Replies in existing threads

```bash
gh api -X POST repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies -F body=@reply.md
```

`{comment_id}` is the id of any comment in the thread (use the first). Replies post one call each: post the approved batch one reply at a time, stop at the first failure, and report what landed and what did not.

## Resolving a thread (own PR only, after the user's yes)

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url}}}}}}}' -F o=<owner> -F r=<repo> -F n=<n>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread node id>
```

Match the thread by its first comment's `url`.

## Editing a posted comment

The link's fragment names the kind and its id:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/comments/{id} -F body=@body.md        # #discussion_r<id>, an inline comment
gh api -X PUT repos/{owner}/{repo}/pulls/{n}/reviews/{id} -F body=@body.md       # #pullrequestreview-<id>, a review body
gh api -X PATCH repos/{owner}/{repo}/issues/comments/{id} -F body=@body.md       # #issuecomment-<id>, a top-level comment
```

Fetch the current body first with `gh api` on the same path (GET).

## Verify

Re-run `gh-activity pr <n> --json` (or the GET for an edit) and confirm every posted comment, reply or edit appears with the user's login, at the intended path and line, with the approved body. Report the URLs.
