-- =====================
-- GitLab Connection
-- =====================

-- name: GetGitLabConnection :one
SELECT * FROM gitlab_connection
WHERE workspace_id = $1;

-- name: GetGitLabConnectionByWebhookToken :one
-- Resolves the owning workspace from the X-Gitlab-Token header alone. The
-- token is UNIQUE, so a self-hosted GitLab webhook needs no other identifier.
SELECT * FROM gitlab_connection
WHERE webhook_secret_token = $1;

-- name: UpsertGitLabConnection :one
-- One connection per workspace. The handler is responsible for merging the
-- access_token (preserve / clear / replace), so this query always writes the
-- value it is given.
INSERT INTO gitlab_connection (
    workspace_id, base_url, webhook_secret_token, access_token_encrypted, created_by
) VALUES (
    $1, $2, $3, sqlc.narg('access_token_encrypted'), sqlc.narg('created_by')
)
ON CONFLICT (workspace_id) DO UPDATE SET
    base_url = EXCLUDED.base_url,
    webhook_secret_token = EXCLUDED.webhook_secret_token,
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    updated_at = now()
RETURNING *;

-- name: DeleteGitLabConnection :exec
DELETE FROM gitlab_connection WHERE workspace_id = $1;

-- =====================
-- GitLab Merge Request
-- =====================

-- name: UpsertGitLabMergeRequest :one
INSERT INTO gitlab_merge_request (
    workspace_id, project_id, project_path, mr_iid,
    title, state, web_url, source_branch, author_username, author_avatar_url,
    merged_at, closed_at, mr_created_at, mr_updated_at
) VALUES (
    $1, $2, $3, $4,
    $5, $6, $7, sqlc.narg('source_branch'), sqlc.narg('author_username'), sqlc.narg('author_avatar_url'),
    sqlc.narg('merged_at'), sqlc.narg('closed_at'), $8, $9
)
ON CONFLICT (workspace_id, project_id, mr_iid) DO UPDATE SET
    project_path = EXCLUDED.project_path,
    title = EXCLUDED.title,
    state = EXCLUDED.state,
    web_url = EXCLUDED.web_url,
    source_branch = EXCLUDED.source_branch,
    author_username = EXCLUDED.author_username,
    author_avatar_url = EXCLUDED.author_avatar_url,
    merged_at = EXCLUDED.merged_at,
    closed_at = EXCLUDED.closed_at,
    mr_updated_at = EXCLUDED.mr_updated_at,
    updated_at = now()
RETURNING *;

-- name: GetGitLabMergeRequest :one
SELECT * FROM gitlab_merge_request
WHERE workspace_id = $1 AND project_id = $2 AND mr_iid = $3;

-- name: ListMergeRequestsByIssue :many
SELECT mr.*
FROM gitlab_merge_request mr
JOIN issue_merge_request imr ON imr.merge_request_id = mr.id
WHERE imr.issue_id = $1
ORDER BY mr.mr_created_at DESC;

-- name: ListIssueIDsForMergeRequest :many
SELECT issue_id FROM issue_merge_request
WHERE merge_request_id = $1;

-- name: GetIssueMergeRequestCloseAggregate :one
-- Aggregates the issue's linked MRs into the two counts that gate
-- auto-advance: how many are still in flight (`opened` or `locked`) and how
-- many merged MRs declared explicit closing intent on the link row. The
-- webhook auto-advances the issue when open_count = 0 AND
-- merged_with_close_intent_count > 0. Mirrors the old PR aggregate so a
-- link-only sibling closing after a closing-keyword MR has merged still
-- resolves the issue.
SELECT
    COALESCE(SUM(CASE WHEN mr.state IN ('opened', 'locked') THEN 1 ELSE 0 END), 0)::bigint AS open_count,
    COALESCE(SUM(CASE WHEN mr.state = 'merged' AND imr.close_intent THEN 1 ELSE 0 END), 0)::bigint AS merged_with_close_intent_count
FROM gitlab_merge_request mr
JOIN issue_merge_request imr ON imr.merge_request_id = mr.id
WHERE imr.issue_id = $1;

-- =====================
-- Issue <-> Merge Request link
-- =====================

-- name: LinkIssueToMergeRequest :exec
-- close_intent reflects the MR's explicit close declaration at the moment the
-- webhook is allowed to update that intent. Open/update/merge webhooks use the
-- current title/description parse so authors can remove a closing keyword
-- before merge; post-terminal updates can preserve the stored value.
INSERT INTO issue_merge_request (
    issue_id, merge_request_id, linked_by_type, linked_by_id, close_intent
) VALUES (
    $1, $2, sqlc.narg('linked_by_type'), sqlc.narg('linked_by_id'), $3
)
ON CONFLICT (issue_id, merge_request_id) DO UPDATE SET
    close_intent = CASE
        WHEN sqlc.arg('preserve_close_intent') THEN issue_merge_request.close_intent
        ELSE EXCLUDED.close_intent
    END;

-- name: UnlinkIssueFromMergeRequest :exec
DELETE FROM issue_merge_request
WHERE issue_id = $1 AND merge_request_id = $2;
