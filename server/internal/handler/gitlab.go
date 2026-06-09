package handler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ── Response shapes ─────────────────────────────────────────────────────────

// GitLabConnectionResponse is the JSON shape returned by the connection config
// endpoint. WebhookSecretToken is admin-only: it is the credential an operator
// pastes into each GitLab project's webhook settings, so non-admin members
// receive responses with the field omitted. The Personal Access Token is never
// returned in any form — only a boolean presence flag (HasAccessToken).
type GitLabConnectionResponse struct {
	WorkspaceID        string  `json:"workspace_id"`
	BaseURL            string  `json:"base_url"`
	WebhookSecretToken *string `json:"webhook_secret_token,omitempty"`
	HasAccessToken     bool    `json:"has_access_token"`
	CreatedBy          *string `json:"created_by"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
}

// GitLabMergeRequestResponse is the JSON shape returned by the issue
// merge-request list endpoint and broadcast on MR webhook events.
type GitLabMergeRequestResponse struct {
	ID              string  `json:"id"`
	WorkspaceID     string  `json:"workspace_id"`
	ProjectID       int64   `json:"project_id"`
	ProjectPath     string  `json:"project_path"`
	Iid             int32   `json:"iid"`
	Title           string  `json:"title"`
	State           string  `json:"state"`
	WebURL          string  `json:"web_url"`
	SourceBranch    *string `json:"source_branch"`
	AuthorUsername  *string `json:"author_username"`
	AuthorAvatarURL *string `json:"author_avatar_url"`
	MergedAt        *string `json:"merged_at"`
	ClosedAt        *string `json:"closed_at"`
	MRCreatedAt     string  `json:"mr_created_at"`
	MRUpdatedAt     string  `json:"mr_updated_at"`
}

func gitlabConnectionToResponse(c db.GitlabConnection, canManage bool) GitLabConnectionResponse {
	resp := GitLabConnectionResponse{
		WorkspaceID:    uuidToString(c.WorkspaceID),
		BaseURL:        c.BaseUrl,
		HasAccessToken: len(c.AccessTokenEncrypted) > 0,
		CreatedBy:      uuidToPtr(c.CreatedBy),
		CreatedAt:      timestampToString(c.CreatedAt),
		UpdatedAt:      timestampToString(c.UpdatedAt),
	}
	if canManage {
		tok := c.WebhookSecretToken
		resp.WebhookSecretToken = &tok
	}
	return resp
}

func gitlabMergeRequestToResponse(m db.GitlabMergeRequest) GitLabMergeRequestResponse {
	return GitLabMergeRequestResponse{
		ID:              uuidToString(m.ID),
		WorkspaceID:     uuidToString(m.WorkspaceID),
		ProjectID:       m.ProjectID,
		ProjectPath:     m.ProjectPath,
		Iid:             m.MrIid,
		Title:           m.Title,
		State:           m.State,
		WebURL:          m.WebUrl,
		SourceBranch:    textToPtr(m.SourceBranch),
		AuthorUsername:  textToPtr(m.AuthorUsername),
		AuthorAvatarURL: textToPtr(m.AuthorAvatarUrl),
		MergedAt:        timestampToPtr(m.MergedAt),
		ClosedAt:        timestampToPtr(m.ClosedAt),
		MRCreatedAt:     timestampToString(m.MrCreatedAt),
		MRUpdatedAt:     timestampToString(m.MrUpdatedAt),
	}
}

// ── Connection config ───────────────────────────────────────────────────────

// GetGitLabConnection (GET /api/workspaces/{id}/gitlab/connection) returns the
// workspace's GitLab connection to any member. The webhook secret token is
// admin-only (it is the credential); non-admins still see base_url and whether
// a PAT is configured so the Integrations tab renders for everyone.
func (h *Handler) GetGitLabConnection(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	member, _ := middleware.MemberFromContext(r.Context())
	canManage := roleAllowed(member.Role, "owner", "admin")

	conn, err := h.Queries.GetGitLabConnection(r.Context(), wsUUID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{
			"connection": nil,
			"configured": false,
			"can_manage": canManage,
		})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load gitlab connection")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connection": gitlabConnectionToResponse(conn, canManage),
		"configured": true,
		"can_manage": canManage,
	})
}

// PutGitLabConnectionRequest is the body for PUT /gitlab/connection.
//
// Tri-state semantics differ per field, so the handler decodes a raw map to
// distinguish "field omitted" from "field present with empty value":
//   - base_url: required, must be a valid http(s) URL.
//   - webhook_secret_token: optional. Provided non-empty → use it; empty or
//     omitted → preserve the existing token, or generate a fresh random one
//     when creating.
//   - access_token: optional, tri-state. Omitted → preserve existing; ""
//     (explicit) → clear; non-empty → encrypt + store.
type PutGitLabConnectionRequest struct {
	BaseURL            string  `json:"base_url"`
	WebhookSecretToken *string `json:"webhook_secret_token"`
	AccessToken        *string `json:"access_token"`
}

// PutGitLabConnection upserts the workspace's GitLab connection (admin-only).
func (h *Handler) PutGitLabConnection(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var req PutGitLabConnectionRequest
	if rawURL, ok := raw["base_url"]; ok {
		if err := json.Unmarshal(rawURL, &req.BaseURL); err != nil {
			writeError(w, http.StatusBadRequest, "base_url must be a string")
			return
		}
	}
	if rawTok, ok := raw["webhook_secret_token"]; ok {
		if err := json.Unmarshal(rawTok, &req.WebhookSecretToken); err != nil {
			writeError(w, http.StatusBadRequest, "webhook_secret_token must be a string or null")
			return
		}
	}
	if rawAT, ok := raw["access_token"]; ok {
		if err := json.Unmarshal(rawAT, &req.AccessToken); err != nil {
			writeError(w, http.StatusBadRequest, "access_token must be a string or null")
			return
		}
	}

	req.BaseURL = strings.TrimSpace(req.BaseURL)
	if req.BaseURL == "" {
		writeError(w, http.StatusBadRequest, "base_url is required")
		return
	}
	if !isValidGitLabBaseURL(req.BaseURL) {
		writeError(w, http.StatusBadRequest, "base_url must be a valid http(s) URL")
		return
	}

	existing, existingErr := h.Queries.GetGitLabConnection(r.Context(), wsUUID)
	hasExisting := existingErr == nil
	if existingErr != nil && !errors.Is(existingErr, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to load gitlab connection")
		return
	}

	// Resolve the webhook secret token: explicit non-empty value wins; else
	// preserve the existing token; else mint a fresh random one.
	webhookToken := ""
	if req.WebhookSecretToken != nil && strings.TrimSpace(*req.WebhookSecretToken) != "" {
		webhookToken = strings.TrimSpace(*req.WebhookSecretToken)
	} else if hasExisting {
		webhookToken = existing.WebhookSecretToken
	} else {
		tok, err := generateGitLabWebhookToken()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate webhook token")
			return
		}
		webhookToken = tok
	}

	// Resolve the encrypted access token (tri-state).
	var encrypted []byte
	if hasExisting {
		encrypted = existing.AccessTokenEncrypted
	}
	if req.AccessToken != nil {
		if *req.AccessToken == "" {
			encrypted = nil // explicit clear
		} else {
			if h.GitLabBox == nil {
				writeError(w, http.StatusServiceUnavailable, "gitlab token encryption is not configured (set MULTICA_GITLAB_SECRET_KEY)")
				return
			}
			sealed, err := h.GitLabBox.Seal([]byte(*req.AccessToken))
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to encrypt access token")
				return
			}
			encrypted = sealed
		}
	}

	createdBy := pgtype.UUID{}
	if hasExisting {
		createdBy = existing.CreatedBy
	} else if u, perr := parseStrictUUID(userID); perr == nil {
		createdBy = u
	}

	conn, err := h.Queries.UpsertGitLabConnection(r.Context(), db.UpsertGitLabConnectionParams{
		WorkspaceID:          wsUUID,
		BaseUrl:              req.BaseURL,
		WebhookSecretToken:   webhookToken,
		AccessTokenEncrypted: encrypted,
		CreatedBy:            createdBy,
	})
	if err != nil {
		if isUniqueViolation(err) {
			// webhook_secret_token collided with another workspace's token.
			writeError(w, http.StatusConflict, "webhook_secret_token is already in use; choose another")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to save gitlab connection")
		return
	}

	h.publish(protocol.EventGitLabConnectionUpdated, uuidToString(wsUUID), "member", userID, map[string]any{
		// The webhook token is a management secret; the broadcast omits it
		// (canManage=false) and admins re-query the endpoint to recover it.
		"connection": gitlabConnectionToResponse(conn, false),
	})
	// The caller is an admin, so return the token so they can copy it into
	// GitLab's webhook settings without a second round-trip.
	writeJSON(w, http.StatusOK, gitlabConnectionToResponse(conn, true))
}

// DeleteGitLabConnection removes the workspace's GitLab connection (admin-only).
func (h *Handler) DeleteGitLabConnection(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return
	}
	userID, _ := requireUserIDLoose(r)
	if err := h.Queries.DeleteGitLabConnection(r.Context(), wsUUID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete gitlab connection")
		return
	}
	h.publish(protocol.EventGitLabConnectionDeleted, uuidToString(wsUUID), "member", userID, map[string]any{
		"workspace_id": uuidToString(wsUUID),
	})
	w.WriteHeader(http.StatusNoContent)
}

// ── List MRs for an issue ───────────────────────────────────────────────────

func (h *Handler) ListMergeRequestsForIssue(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListMergeRequestsByIssue(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list merge requests")
		return
	}
	out := make([]GitLabMergeRequestResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, gitlabMergeRequestToResponse(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"merge_requests": out})
}

// ── Webhook ─────────────────────────────────────────────────────────────────

// identifierRe extracts identifiers like "MUL-1510" from text. Case-insensitive
// because branch names are conventionally lowercase but issue prefixes are
// uppercase. Word boundary on the left prevents matching inside email-style
// strings (e.g. "abc@MUL-1") and the digit anchor on the right rules out
// version numbers like "v1.2-3".
var identifierRe = regexp.MustCompile(`(?i)\b([a-z][a-z0-9]{1,9})-(\d+)\b`)

// closingIdentifierRe extracts identifiers that appear immediately after a
// closing keyword ("close[sd]?", "fix(e[sd])?", "resolve[sd]?"), optionally
// separated by a colon and whitespace. Matching is intentionally strict on
// adjacency — "Fix MUL-1" closes MUL-1, but "Fix login MUL-1" does not. This
// mirrors the closing-keyword grammar and gates whether a merged MR
// auto-advances an issue to `done`.
var closingIdentifierRe = regexp.MustCompile(
	`(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[:\s]+([a-z][a-z0-9]{1,9})-(\d+)\b`,
)

// HandleGitLabWebhook (POST /api/webhooks/gitlab) is the destination for GitLab
// project webhook deliveries. Requests are authenticated solely by the
// X-Gitlab-Token header: it must equal the webhook_secret_token of exactly one
// workspace's connection (which is also how we attribute the event to a
// workspace, since a self-hosted GitLab webhook carries no Multica identity).
// We route on X-Gitlab-Event / object_kind, upsert the MR, auto-link to issues
// by identifier, and advance linked issues to `done` on merge.
func (h *Handler) HandleGitLabWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20)) // 10 MiB cap
	if err != nil {
		writeError(w, http.StatusBadRequest, "read body failed")
		return
	}
	token := strings.TrimSpace(r.Header.Get("X-Gitlab-Token"))
	if token == "" {
		writeError(w, http.StatusUnauthorized, "missing X-Gitlab-Token")
		return
	}
	conn, err := h.Queries.GetGitLabConnectionByWebhookToken(r.Context(), token)
	if err != nil {
		// No connection matches this token — unknown/forged caller.
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("gitlab: webhook token lookup failed", "err", err)
		}
		writeError(w, http.StatusUnauthorized, "invalid X-Gitlab-Token")
		return
	}

	// Only merge-request hooks are modelled today; acknowledge everything
	// else so GitLab doesn't flag the endpoint as failing.
	event := r.Header.Get("X-Gitlab-Event")
	if event != "" && event != "Merge Request Hook" {
		w.WriteHeader(http.StatusOK)
		return
	}

	var probe struct {
		ObjectKind string `json:"object_kind"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		writeError(w, http.StatusBadRequest, "invalid payload")
		return
	}
	if probe.ObjectKind != "merge_request" {
		w.WriteHeader(http.StatusOK)
		return
	}

	h.handleMergeRequestEvent(r.Context(), conn, body)
	w.WriteHeader(http.StatusAccepted)
}

type glMergeRequestPayload struct {
	ObjectKind string `json:"object_kind"`
	Project    struct {
		ID                int64  `json:"id"`
		PathWithNamespace string `json:"path_with_namespace"`
		WebURL            string `json:"web_url"`
	} `json:"project"`
	ObjectAttributes struct {
		IID          int32  `json:"iid"`
		Title        string `json:"title"`
		Description  string `json:"description"`
		State        string `json:"state"`
		Action       string `json:"action"`
		SourceBranch string `json:"source_branch"`
		URL          string `json:"url"`
		CreatedAt    string `json:"created_at"`
		UpdatedAt    string `json:"updated_at"`
	} `json:"object_attributes"`
	User struct {
		Username  string `json:"username"`
		AvatarURL string `json:"avatar_url"`
	} `json:"user"`
}

func (h *Handler) handleMergeRequestEvent(ctx context.Context, conn db.GitlabConnection, body []byte) {
	var p glMergeRequestPayload
	if err := json.Unmarshal(body, &p); err != nil {
		slog.Warn("gitlab: bad merge_request payload", "err", err)
		return
	}

	state := normalizeMRState(p.ObjectAttributes.State)
	createdAt := parseGitLabTimeRequired(p.ObjectAttributes.CreatedAt)
	updatedAt := parseGitLabTimeRequired(p.ObjectAttributes.UpdatedAt)
	// GitLab's MR object_attributes do not reliably carry merged_at/closed_at,
	// so derive them from the terminal state at the event's update time.
	var mergedAt, closedAt pgtype.Timestamptz
	switch state {
	case "merged":
		mergedAt = updatedAt
	case "closed":
		closedAt = updatedAt
	}

	mr, err := h.Queries.UpsertGitLabMergeRequest(ctx, db.UpsertGitLabMergeRequestParams{
		WorkspaceID:     conn.WorkspaceID,
		ProjectID:       p.Project.ID,
		ProjectPath:     p.Project.PathWithNamespace,
		MrIid:           p.ObjectAttributes.IID,
		Title:           p.ObjectAttributes.Title,
		State:           state,
		WebUrl:          coalesce(p.ObjectAttributes.URL, p.Project.WebURL),
		SourceBranch:    ptrToText(strPtrOrNil(p.ObjectAttributes.SourceBranch)),
		AuthorUsername:  ptrToText(strPtrOrNil(p.User.Username)),
		AuthorAvatarUrl: ptrToText(strPtrOrNil(p.User.AvatarURL)),
		MergedAt:        mergedAt,
		ClosedAt:        closedAt,
		MrCreatedAt:     createdAt,
		MrUpdatedAt:     updatedAt,
	})
	if err != nil {
		slog.Warn("gitlab: upsert merge request failed", "err", err)
		return
	}

	workspaceID := uuidToString(conn.WorkspaceID)
	resp := gitlabMergeRequestToResponse(mr)

	// Auto-link: scan title/description/source_branch for issue identifiers,
	// look them up in this workspace, attach link rows. Idempotent.
	linkedIssueIDs := make([]string, 0)
	if h.workspaceAutoLinkMRsEnabled(ctx, conn.WorkspaceID) {
		idents := extractIdentifiers(p.ObjectAttributes.Title, p.ObjectAttributes.Description, p.ObjectAttributes.SourceBranch)
		closingIdents := map[string]struct{}{}
		for _, c := range extractClosingIdentifiers(p.ObjectAttributes.Title, p.ObjectAttributes.Description) {
			closingIdents[c] = struct{}{}
		}
		// Once a terminal event (merge/close) has been delivered, later
		// non-terminal updates must not rewrite the merge-time close decision.
		isTerminalEvent := p.ObjectAttributes.Action == "merge" || p.ObjectAttributes.Action == "close"
		preserveCloseIntent := !isTerminalEvent && (state == "merged" || state == "closed")
		prefix := h.getIssuePrefix(ctx, conn.WorkspaceID)
		reevalIssues := make([]db.Issue, 0, len(idents))
		for _, id := range idents {
			issue, ok := h.lookupIssueByIdentifier(ctx, conn.WorkspaceID, prefix, id)
			if !ok {
				continue
			}
			_, declared := closingIdents[id]
			closeIntent := declared && !preserveCloseIntent
			if err := h.Queries.LinkIssueToMergeRequest(ctx, db.LinkIssueToMergeRequestParams{
				IssueID:             issue.ID,
				MergeRequestID:      mr.ID,
				CloseIntent:         closeIntent,
				PreserveCloseIntent: preserveCloseIntent,
				LinkedByType:        strToText("system"),
				LinkedByID:          pgtype.UUID{},
			}); err != nil {
				slog.Warn("gitlab: link failed", "err", err)
				continue
			}
			linkedIssueIDs = append(linkedIssueIDs, uuidToString(issue.ID))
			reevalIssues = append(reevalIssues, issue)
		}

		// A terminal MR event may be the moment the last in-flight sibling
		// resolves. Re-evaluate every linked issue against the persisted
		// aggregate so a link-only sibling closing after a closing-keyword MR
		// has merged still advances the issue. Advance when:
		//   1. the issue isn't already terminal (`done` / `cancelled`);
		//   2. no linked MR is still `opened` / `locked`;
		//   3. at least one merged linked MR declared close_intent.
		if state == "merged" || state == "closed" {
			for _, issue := range reevalIssues {
				if issue.Status == "done" || issue.Status == "cancelled" {
					continue
				}
				counts, err := h.Queries.GetIssueMergeRequestCloseAggregate(ctx, issue.ID)
				if err != nil {
					slog.Warn("gitlab: count linked mr states failed", "err", err, "issue_id", uuidToString(issue.ID))
					continue
				}
				if counts.OpenCount == 0 && counts.MergedWithCloseIntentCount > 0 {
					h.advanceIssueToDoneFromMR(ctx, issue, workspaceID)
				}
			}
		}
	}

	h.publish(protocol.EventMergeRequestUpdated, workspaceID, "system", "", map[string]any{
		"merge_request":    resp,
		"linked_issue_ids": linkedIssueIDs,
	})
}

// workspaceAutoLinkMRsEnabled reports whether the workspace allows the GitLab
// webhook to create issue ↔ MR link rows. Defaults to true and short-circuits
// to false only when the master `gitlab_enabled` switch is explicitly off.
func (h *Handler) workspaceAutoLinkMRsEnabled(ctx context.Context, workspaceID pgtype.UUID) bool {
	ws, err := h.Queries.GetWorkspace(ctx, workspaceID)
	if err != nil || len(ws.Settings) == 0 {
		return true
	}
	var s struct {
		GitLabEnabled            *bool `json:"gitlab_enabled"`
		GitLabAutoLinkMRsEnabled *bool `json:"gitlab_auto_link_mrs_enabled"`
	}
	if err := json.Unmarshal(ws.Settings, &s); err != nil {
		return true
	}
	if s.GitLabEnabled != nil && !*s.GitLabEnabled {
		return false
	}
	if s.GitLabAutoLinkMRsEnabled == nil {
		return true
	}
	return *s.GitLabAutoLinkMRsEnabled
}

// advanceIssueToDoneFromMR flips a linked issue to `done` on MR merge, firing
// the same parent-notification path the HTTP update flows use.
func (h *Handler) advanceIssueToDoneFromMR(ctx context.Context, issue db.Issue, workspaceID string) {
	updated, err := h.Queries.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{
		ID:          issue.ID,
		Status:      "done",
		WorkspaceID: issue.WorkspaceID,
	})
	if err != nil {
		slog.Warn("gitlab: advance issue to done failed", "err", err)
		return
	}
	h.notifyParentOfChildDone(ctx, issue, updated, "system", "")
	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	resp := issueToResponse(updated, prefix)
	h.publish(protocol.EventIssueUpdated, workspaceID, "system", "", map[string]any{
		"issue":          resp,
		"status_changed": true,
		"prev_status":    issue.Status,
		"creator_type":   issue.CreatorType,
		"creator_id":     uuidToString(issue.CreatorID),
		"source":         "gitlab_mr_merged",
	})
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// normalizeMRState maps GitLab's merge-request state to the column's CHECK
// domain, defaulting unknown values to `opened` so a future GitLab state can't
// violate the constraint (enum drift downgrades, not crashes).
func normalizeMRState(s string) string {
	switch s {
	case "opened", "closed", "merged", "locked":
		return s
	default:
		return "opened"
	}
}

// isValidGitLabBaseURL accepts an http(s) URL with a host. The connection
// base_url points at a self-hosted GitLab instance, so we guard against pasted
// garbage but stay lax on path/port.
func isValidGitLabBaseURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

// generateGitLabWebhookToken mints a 32-byte random hex token used as the
// X-Gitlab-Token shared secret.
func generateGitLabWebhookToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// parseGitLabTime parses the timestamp formats GitLab webhooks emit. GitLab has
// historically sent "2006-01-02 15:04:05 UTC" / "... -0700" as well as ISO8601,
// so we try the common layouts in order.
func parseGitLabTime(s string) pgtype.Timestamptz {
	s = strings.TrimSpace(s)
	if s == "" {
		return pgtype.Timestamptz{}
	}
	layouts := []string{
		time.RFC3339,
		"2006-01-02 15:04:05 -0700",
		"2006-01-02 15:04:05 MST",
		"2006-01-02 15:04:05.999999 -0700",
		"2006-01-02 15:04:05 -0700 MST",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return pgtype.Timestamptz{Time: t, Valid: true}
		}
	}
	return pgtype.Timestamptz{}
}

func parseGitLabTimeRequired(s string) pgtype.Timestamptz {
	t := parseGitLabTime(s)
	if !t.Valid {
		return pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	}
	return t
}

// extractIdentifiers pulls every "PREFIX-NUMBER" match across the supplied
// fields, deduplicating in input order.
func extractIdentifiers(parts ...string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, src := range parts {
		for _, m := range identifierRe.FindAllStringSubmatch(src, -1) {
			ident := strings.ToUpper(m[1]) + "-" + m[2]
			if _, dup := seen[ident]; dup {
				continue
			}
			seen[ident] = struct{}{}
			out = append(out, ident)
		}
	}
	return out
}

// extractClosingIdentifiers pulls every "PREFIX-NUMBER" identifier that appears
// immediately after a closing keyword in the supplied fields, deduplicating in
// input order. Callers should pass only title and description — branch names
// are not natural-language fields and must not be treated as close
// declarations.
func extractClosingIdentifiers(parts ...string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, src := range parts {
		for _, m := range closingIdentifierRe.FindAllStringSubmatch(src, -1) {
			ident := strings.ToUpper(m[1]) + "-" + m[2]
			if _, dup := seen[ident]; dup {
				continue
			}
			seen[ident] = struct{}{}
			out = append(out, ident)
		}
	}
	return out
}

// lookupIssueByIdentifier looks up an issue in the given workspace by its
// "PREFIX-NUMBER" identifier. Returns the row + true when the prefix matches
// the workspace's configured prefix and the number resolves to a real issue.
func (h *Handler) lookupIssueByIdentifier(ctx context.Context, workspaceID pgtype.UUID, prefix, identifier string) (db.Issue, bool) {
	idx := strings.LastIndex(identifier, "-")
	if idx < 0 {
		return db.Issue{}, false
	}
	gotPrefix, numStr := identifier[:idx], identifier[idx+1:]
	if !strings.EqualFold(gotPrefix, prefix) {
		return db.Issue{}, false
	}
	n, err := strconv.Atoi(numStr)
	if err != nil {
		return db.Issue{}, false
	}
	issue, err := h.Queries.GetIssueByNumber(ctx, db.GetIssueByNumberParams{
		WorkspaceID: workspaceID,
		Number:      int32(n),
	})
	if err != nil {
		return db.Issue{}, false
	}
	return issue, true
}

func parseStrictUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return pgtype.UUID{}, err
	}
	return u, nil
}

func coalesce(a, fallback string) string {
	if strings.TrimSpace(a) == "" {
		return fallback
	}
	return a
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

// requireUserIDLoose returns the request's user id without writing an error
// response — used by handlers (like delete) where the actor is only needed to
// attribute the broadcast and a missing id is tolerable.
func requireUserIDLoose(r *http.Request) (string, bool) {
	id := requestUserID(r)
	return id, id != ""
}
