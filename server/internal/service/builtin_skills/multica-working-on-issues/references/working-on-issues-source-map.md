# working-on-issues source map

Evidence layer for `SKILL.md`. Every contract the skill states is traced to a
current `file:line` here. The integration is internal GitLab (HAP-29): the old
GitHub PR handler/queries/routes were replaced by a GitLab merge-request
equivalent, so all citations below point at `gitlab.go` / the `/merge-requests`
route. Re-confirm with the verification command at the bottom before relying on
an exact line.

## `multica issue merge-requests` — read MR links from Multica

| Behavior | File:line |
|---|---|
| CLI command `merge-requests <id>` (alias `mrs`) | `server/cmd/multica/cmd_issue.go:105` |
| `runIssueMergeRequests` handler | `server/cmd/multica/cmd_issue.go:507` |
| Calls `GET /api/issues/<id>/merge-requests` | `server/cmd/multica/cmd_issue.go:522` |
| API route registration | `server/cmd/server/router.go:734` |
| Handler `ListMergeRequestsForIssue` → `Queries.ListMergeRequestsByIssue` | `server/internal/handler/gitlab.go:295` |
| Row → response mapper `gitlabMergeRequestToResponse` | `server/internal/handler/gitlab.go:80` |

The CLI resolves the issue ref, GETs the endpoint, and (for `--output json`)
prints the raw `{"merge_requests": [...]}` body. Only `--output` is accepted; the
default `table` shows `IID STATE TITLE URL`.

## MR response shape

`GitLabMergeRequestResponse` struct: `server/internal/handler/gitlab.go:46`. JSON
fields the agent can read off each element of `merge_requests`:

- `iid` (`json:"iid"`, line 51)
- `web_url` (`json:"web_url"`, line 54)
- `title` (`json:"title"`, line 52)
- `project_path` (`json:"project_path"`, line 50)
- `state` (`json:"state"`, line 53) — the lifecycle enum (see below)
- `merged_at` (`json:"merged_at"`, line 58), `closed_at` (line 59)
- `source_branch` (line 55), `author_username` (line 56)

CI/pipeline status is not surfaced in this phase (GitLab Pipeline Hook is a
follow-up). The MR lifecycle is the single `state` string, normalized by
`normalizeMRState` (`server/internal/handler/gitlab.go:572`) to one of
`opened` / `closed` / `merged` / `locked`; any unknown server value downgrades to
`opened` rather than violating the column CHECK. `state` is written when the
webhook upserts the row (`UpsertGitLabMergeRequest`, call site
`server/internal/handler/gitlab.go:427`). "Is it merged?" = `state == "merged"`
(or `merged_at != null`); "is it closed?" = `state == "closed"`.

## Two distinct webhook paths: link vs close-intent

Both run inside `handleMergeRequestEvent` (`server/internal/handler/gitlab.go:411`),
gated by the workspace auto-link flag (`workspaceAutoLinkMRsEnabled`,
`gitlab.go:521`).

### Path 1 — link (title OR description OR source branch)

- `extractIdentifiers` regex helper: `server/internal/handler/gitlab.go:635`
- driving regex `identifierRe` (`\b([a-z][a-z0-9]{1,9})-(\d+)\b`, case-insensitive):
  `server/internal/handler/gitlab.go:319`
- call site: `server/internal/handler/gitlab.go:455` —
  `extractIdentifiers(p.ObjectAttributes.Title, p.ObjectAttributes.Description, p.ObjectAttributes.SourceBranch)`

Every `PREFIX-NUMBER` mention in **title, description, or source branch** resolves
to an issue in the workspace and writes a link row (`LinkIssueToMergeRequest`,
`gitlab.go:473`). This is what `multica issue merge-requests` later reads back.

### Path 2 — close intent (title OR description only, keyword-adjacent)

- `extractClosingIdentifiers` regex helper: `server/internal/handler/gitlab.go:656`
- driving regex `closingIdentifierRe`
  (`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[:\s]+([a-z][a-z0-9]{1,9})-(\d+)\b`):
  `server/internal/handler/gitlab.go:327`
- call site: `server/internal/handler/gitlab.go:457` —
  `extractClosingIdentifiers(p.ObjectAttributes.Title, p.ObjectAttributes.Description)` (no branch arg)

Only a `PREFIX-NUMBER` immediately after a closing keyword
(`Closes`/`Fixes`/`Resolves`, optional `:` then whitespace) sets the link row's
`close_intent` flag — the gate that auto-advances the issue to `done` on merge
(`advanceIssueToDoneFromMR`, `gitlab.go:544`). `Fix MUL-1` closes; `Fix login
MUL-1` does not (adjacency). Branch names are deliberately excluded: a branch like
`mul-1/fix-login` links but must never declare close intent.

Net: a bare title prefix (`MUL-2759: ...`) or a branch ref links only;
`Closes MUL-2759` links **and** records close intent.

## Status side effects (enqueue contracts)

| Behavior | File:line |
|---|---|
| Create-time: agent-assigned, non-backlog issue enqueues immediately | `server/internal/handler/issue.go:2263-2264` |
| `shouldEnqueueAgentTask` returns false for `backlog` (parking lot) | `server/internal/handler/issue.go:2644-2648` |
| Backlog → non-backlog (not done/cancelled) enqueues on update | `server/internal/handler/issue.go:2537-2540` |
| Same contract in batch update | `server/internal/handler/issue.go:3021-3024` |
| Child → `done` posts a system comment on the parent | `server/internal/handler/issue_child_done.go:51` (`notifyParentOfChildDone`) |

Creation with `--status todo` (or any non-backlog status) on an agent-assigned
issue fires the agent immediately; `--status backlog` parks it with the assignee
set but no trigger. Promoting `backlog → todo` later fires it then (update path,
line 2537). The MR-merge auto-advance reuses `notifyParentOfChildDone` via
`advanceIssueToDoneFromMR`.

## Metadata CLI

| Behavior | File:line |
|---|---|
| `multica issue metadata set <issue-id> --key --value [--type]` | `server/cmd/multica/cmd_issue_metadata.go:80,109-111` |
| `multica issue metadata delete <issue-id> --key` | `server/cmd/multica/cmd_issue_metadata.go:93,113` |
| API routes (PUT/DELETE `/metadata/{key}`) | `server/cmd/server/router.go:732-733` |

`--value` is JSON-parsed by default (bool/number sniff); `--type` forces
`string`/`number`/`bool`.

## Verification command

Re-derive any line above before depending on it:

```bash
cd server
grep -n 'merge-requests <id>'                cmd/multica/cmd_issue.go
grep -n 'ListMergeRequestsForIssue'          cmd/server/router.go internal/handler/gitlab.go
grep -n 'func gitlabMergeRequestToResponse\|type GitLabMergeRequestResponse struct\|func normalizeMRState\|func extractIdentifiers\|func extractClosingIdentifiers\|closingIdentifierRe' internal/handler/gitlab.go
grep -n 'extractIdentifiers(\|extractClosingIdentifiers(\|advanceIssueToDoneFromMR(' internal/handler/gitlab.go
grep -n 'prevIssue.Status == "backlog"\|func (h \*Handler) shouldEnqueueAgentTask' internal/handler/issue.go
grep -n 'func notifyParentOfChildDone'       internal/handler/issue_child_done.go
```
