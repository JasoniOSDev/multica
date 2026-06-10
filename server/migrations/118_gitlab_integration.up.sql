-- Replace the GitHub App integration with an internal-network GitLab
-- integration (HAP-29). This is a one-shot replacement: the fork is in-house
-- and keeps no GitHub data, so we drop the GitHub tables outright rather than
-- carry a dual-provider schema.
--
-- GitLab has no App-installation / OAuth model on a self-hosted instance, so a
-- connection is workspace-level: an admin records the instance base URL, a
-- webhook secret token (pasted into each GitLab project's webhook settings),
-- and an optional encrypted Personal Access Token. The webhook is then
-- attributed to a workspace purely by its X-Gitlab-Token.

-- 1. Drop GitHub tables (issue link table first — it FKs the PR table).
DROP TABLE IF EXISTS issue_pull_request;
DROP TABLE IF EXISTS github_pull_request_check_suite;
DROP TABLE IF EXISTS github_pull_request;
DROP TABLE IF EXISTS github_installation;

-- 2. Workspace-level GitLab connection. One row per workspace (PK on
--    workspace_id). webhook_secret_token is UNIQUE so the webhook handler can
--    resolve the owning workspace from the X-Gitlab-Token header alone — that
--    token IS the credential, like a bearer token. access_token_encrypted holds
--    a secretbox (AES-256-GCM) sealed Personal Access Token; it is never stored
--    or returned in plaintext.
CREATE TABLE gitlab_connection (
    workspace_id           UUID PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
    base_url               TEXT NOT NULL,
    webhook_secret_token   TEXT NOT NULL,
    access_token_encrypted BYTEA,
    created_by             UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (webhook_secret_token)
);

-- 3. Mirrored GitLab merge request state. project_id is GitLab's numeric
--    project id; mr_iid is the per-project internal id (the user-facing !N).
--    The (workspace_id, project_id, mr_iid) tuple is the real uniqueness key.
CREATE TABLE gitlab_merge_request (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_id        BIGINT NOT NULL,
    project_path      TEXT NOT NULL,
    mr_iid            INTEGER NOT NULL,
    title             TEXT NOT NULL,
    state             TEXT NOT NULL
        CHECK (state IN ('opened', 'closed', 'merged', 'locked')),
    web_url           TEXT NOT NULL,
    source_branch     TEXT,
    author_username   TEXT,
    author_avatar_url TEXT,
    merged_at         TIMESTAMPTZ,
    closed_at         TIMESTAMPTZ,
    mr_created_at     TIMESTAMPTZ NOT NULL,
    mr_updated_at     TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, project_id, mr_iid)
);

CREATE INDEX idx_gitlab_merge_request_workspace ON gitlab_merge_request(workspace_id);

-- 4. Issue <-> merge request link. close_intent records whether the link was
--    created with explicit closing intent (a "Closes/Fixes/Resolves PREFIX-N"
--    keyword), gating the merge-time auto-advance — same semantics as the old
--    issue_pull_request.close_intent.
CREATE TABLE issue_merge_request (
    issue_id         UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    merge_request_id UUID NOT NULL REFERENCES gitlab_merge_request(id) ON DELETE CASCADE,
    close_intent     BOOLEAN NOT NULL DEFAULT FALSE,
    linked_by_type   TEXT,
    linked_by_id     UUID,
    linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, merge_request_id)
);

CREATE INDEX idx_issue_merge_request_mr ON issue_merge_request(merge_request_id);
