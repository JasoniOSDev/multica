-- Reverse 118: drop the GitLab tables and recreate the GitHub schema as it
-- stood after migrations 079 + 091 + 109 (installation, pull_request with CI +
-- mergeable_state, check_suite, and the issue link with close_intent).

DROP TABLE IF EXISTS issue_merge_request;
DROP TABLE IF EXISTS gitlab_merge_request;
DROP TABLE IF EXISTS gitlab_connection;

CREATE TABLE github_installation (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    installation_id BIGINT NOT NULL,
    account_login   TEXT NOT NULL,
    account_type    TEXT NOT NULL DEFAULT 'User'
        CHECK (account_type IN ('User', 'Organization')),
    account_avatar_url TEXT,
    connected_by_id UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (installation_id)
);

CREATE INDEX idx_github_installation_workspace ON github_installation(workspace_id);

CREATE TABLE github_pull_request (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    installation_id BIGINT NOT NULL,
    repo_owner      TEXT NOT NULL,
    repo_name       TEXT NOT NULL,
    pr_number       INTEGER NOT NULL,
    title           TEXT NOT NULL,
    state           TEXT NOT NULL
        CHECK (state IN ('open', 'closed', 'merged', 'draft')),
    html_url        TEXT NOT NULL,
    branch          TEXT,
    author_login    TEXT,
    author_avatar_url TEXT,
    merged_at       TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,
    pr_created_at   TIMESTAMPTZ NOT NULL,
    pr_updated_at   TIMESTAMPTZ NOT NULL,
    head_sha        TEXT NOT NULL DEFAULT '',
    mergeable_state TEXT,
    additions       INTEGER NOT NULL DEFAULT 0,
    deletions       INTEGER NOT NULL DEFAULT 0,
    changed_files   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, repo_owner, repo_name, pr_number)
);

CREATE INDEX idx_github_pull_request_workspace ON github_pull_request(workspace_id);

CREATE TABLE github_pull_request_check_suite (
    pr_id        UUID NOT NULL REFERENCES github_pull_request(id) ON DELETE CASCADE,
    suite_id     BIGINT NOT NULL,
    head_sha     TEXT NOT NULL,
    app_id       BIGINT NOT NULL,
    conclusion   TEXT,
    status       TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (pr_id, suite_id)
);

CREATE INDEX idx_github_pr_check_suite_aggregate
    ON github_pull_request_check_suite (pr_id, head_sha, app_id, updated_at DESC);

CREATE TABLE issue_pull_request (
    issue_id        UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    pull_request_id UUID NOT NULL REFERENCES github_pull_request(id) ON DELETE CASCADE,
    linked_by_type  TEXT,
    linked_by_id    UUID,
    linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    close_intent    BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (issue_id, pull_request_id)
);

CREATE INDEX idx_issue_pull_request_pr ON issue_pull_request(pull_request_id);
