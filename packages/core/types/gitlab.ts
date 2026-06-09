// Self-hosted GitLab integration is configured per workspace (no GitHub App
// installation model, no OAuth). A workspace points at one internal GitLab
// instance via `base_url`, a `webhook_secret_token` the admin pastes into the
// GitLab project webhook config, and an optional PAT for API enrichment.

/** GitLab Merge Request states as mirrored from the webhook payload. Unknown
 * server-side values are downgraded to `opened` by the backend, but the UI
 * still default-cases on this string to stay drift-safe (see CLAUDE.md
 * "Enum drift downgrades, not crashes"). */
export type GitLabMergeRequestState = "opened" | "closed" | "merged" | "locked";

export interface GitLabConnection {
  workspace_id: string;
  /** Internal GitLab base URL, e.g. `https://gitlab.example.com`. */
  base_url: string;
  /** Token the admin pastes into the GitLab project webhook "Secret token"
   * field; GitLab echoes it back in `X-Gitlab-Token` on every delivery.
   * Only returned to owner/admin callers — the field is omitted for
   * non-managers, so treat it as possibly absent. */
  webhook_secret_token?: string;
  /** Whether a PAT is stored. The plaintext token is never returned. */
  has_access_token: boolean;
  /** UUID of the member who configured the connection. Older rows / minimal
   * deployments may omit it. */
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitLabConnectionResponse {
  /** `null` until a connection is configured for the workspace. */
  connection: GitLabConnection | null;
  /** Whether a connection row exists (mirrors `connection !== null`). */
  configured: boolean;
  /** Whether the caller may create / edit / delete the connection
   * (owner/admin). Non-managers get `false`. Older backends may omit it;
   * treat absence as `false` for read-only safety. */
  can_manage?: boolean;
}

/**
 * Three-state PUT body. See the backend contract:
 *   - `webhook_secret_token` omitted/empty → keep existing or auto-generate
 *     on first create; non-empty → set.
 *   - `access_token` omitted → keep; `""` → clear; non-empty → encrypt+store.
 */
export interface UpdateGitLabConnectionRequest {
  base_url: string;
  webhook_secret_token?: string;
  access_token?: string;
}

export interface GitLabMergeRequest {
  id: string;
  workspace_id: string;
  /** GitLab numeric project id. */
  project_id: number;
  /** `group/repo` path of the GitLab project. */
  project_path: string;
  /** Project-scoped MR number (rendered as `!{iid}`). */
  iid: number;
  title: string;
  state: GitLabMergeRequestState;
  web_url: string;
  source_branch: string | null;
  author_username: string | null;
  author_avatar_url: string | null;
  merged_at: string | null;
  closed_at: string | null;
  mr_created_at: string;
  mr_updated_at: string;
}

export interface ListIssueMergeRequestsResponse {
  merge_requests: GitLabMergeRequest[];
}
