package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ── Pure helpers (no DB) ─────────────────────────────────────────────────────

func TestExtractIdentifiers(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{name: "branch_name", in: []string{"", "", "mul-1510/fix-login"}, want: []string{"MUL-1510"}},
		{name: "title_and_body", in: []string{"Fix MUL-82", "Closes MUL-1510 and ABC-7", ""}, want: []string{"MUL-82", "MUL-1510", "ABC-7"}},
		{name: "dedupe_across_fields", in: []string{"MUL-1", "MUL-1 again", "mul-1/branch"}, want: []string{"MUL-1"}},
		{name: "no_match", in: []string{"plain text", "no idents", ""}, want: []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractIdentifiers(tc.in...)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("extractIdentifiers() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestExtractClosingIdentifiers(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{name: "single_closes", in: []string{"", "Closes MUL-1"}, want: []string{"MUL-1"}},
		{name: "case_insensitive_and_colon", in: []string{"CLOSES: MUL-1", "Fixes:MUL-2 resolves   MUL-3"}, want: []string{"MUL-1", "MUL-2", "MUL-3"}},
		{name: "bare_reference_does_not_close", in: []string{"ABC-1: Lorem Ipsum", "Closes ABC-1. Follow up work planned in ABC-2. Unblocks ABC-3."}, want: []string{"ABC-1"}},
		{name: "keyword_not_adjacent_does_not_close", in: []string{"Fix login MUL-1", ""}, want: []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractClosingIdentifiers(tc.in...)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("extractClosingIdentifiers() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestNormalizeMRState(t *testing.T) {
	cases := map[string]string{
		"opened": "opened",
		"closed": "closed",
		"merged": "merged",
		"locked": "locked",
		"":       "opened",
		"weird":  "opened",
	}
	for in, want := range cases {
		if got := normalizeMRState(in); got != want {
			t.Errorf("normalizeMRState(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseGitLabTime(t *testing.T) {
	// GitLab webhook timestamp form.
	if ts := parseGitLabTime("2026-04-29 00:00:00 UTC"); !ts.Valid {
		t.Error("expected GitLab space-separated timestamp to parse")
	}
	if ts := parseGitLabTime("2026-04-29T00:00:00Z"); !ts.Valid {
		t.Error("expected RFC3339 timestamp to parse")
	}
	if ts := parseGitLabTime(""); ts.Valid {
		t.Error("expected empty string to be invalid")
	}
}

func TestIsValidGitLabBaseURL(t *testing.T) {
	for _, ok := range []string{"http://gitlab.local", "https://gitlab.example.com:8443", "https://gitlab.example.com/path"} {
		if !isValidGitLabBaseURL(ok) {
			t.Errorf("expected %q to be valid", ok)
		}
	}
	for _, bad := range []string{"", "not-a-url", "ftp://x", "git@host:owner/repo.git"} {
		if isValidGitLabBaseURL(bad) {
			t.Errorf("expected %q to be invalid", bad)
		}
	}
}

// ── Webhook token security (no DB needed for the missing-token case) ─────────

func TestGitLabWebhook_MissingToken_401(t *testing.T) {
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/webhooks/gitlab", bytes.NewReader([]byte(`{"object_kind":"merge_request"}`)))
	req.Header.Set("X-Gitlab-Event", "Merge Request Hook")
	newGitLabTestHandler(t).HandleGitLabWebhook(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("missing token: expected 401, got %d (%s)", w.Code, w.Body.String())
	}
}

// newGitLabTestHandler returns the shared DB-backed handler, or a bare handler
// for the no-DB token-rejection path.
func newGitLabTestHandler(t *testing.T) *Handler {
	if testHandler != nil {
		return testHandler
	}
	t.Skip("handler test fixture not initialized (no DB?)")
	return nil
}

// ── DB-backed webhook tests ──────────────────────────────────────────────────

const gitlabTestWebhookToken = "gitlab-test-webhook-token-abc123"

func seedGitLabConnection(t *testing.T, ctx context.Context, token string) {
	t.Helper()
	if _, err := testHandler.Queries.UpsertGitLabConnection(ctx, db.UpsertGitLabConnectionParams{
		WorkspaceID:        parseUUID(testWorkspaceID),
		BaseUrl:            "https://gitlab.example.com",
		WebhookSecretToken: token,
	}); err != nil {
		t.Fatalf("UpsertGitLabConnection: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM gitlab_connection WHERE workspace_id = $1`, testWorkspaceID)
		testPool.Exec(ctx, `DELETE FROM gitlab_merge_request WHERE workspace_id = $1`, testWorkspaceID)
	})
}

func postGitLabWebhook(t *testing.T, token, event string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/webhooks/gitlab", bytes.NewReader(raw))
	if token != "" {
		req.Header.Set("X-Gitlab-Token", token)
	}
	if event != "" {
		req.Header.Set("X-Gitlab-Event", event)
	}
	testHandler.HandleGitLabWebhook(w, req)
	return w
}

func mrPayload(iid int, identifier, action, state string) map[string]any {
	return map[string]any{
		"object_kind": "merge_request",
		"project": map[string]any{
			"id":                  int64(424242),
			"path_with_namespace": "group/widget",
			"web_url":             "https://gitlab.example.com/group/widget",
		},
		"object_attributes": map[string]any{
			"iid":           iid,
			"title":         "Fix login " + identifier,
			"description":   "Closes " + identifier,
			"state":         state,
			"action":        action,
			"source_branch": "fix/login",
			"url":           "https://gitlab.example.com/group/widget/-/merge_requests/" + strconv.Itoa(iid),
			"created_at":    "2026-04-28 00:00:00 UTC",
			"updated_at":    "2026-04-29 00:00:00 UTC",
		},
		"user": map[string]any{"username": "octo", "avatar_url": ""},
	}
}

func TestGitLabWebhook_WrongToken_401(t *testing.T) {
	h := newGitLabTestHandler(t)
	ctx := context.Background()
	seedGitLabConnection(t, ctx, gitlabTestWebhookToken)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/webhooks/gitlab", bytes.NewReader([]byte(`{"object_kind":"merge_request"}`)))
	req.Header.Set("X-Gitlab-Token", "definitely-not-the-token")
	req.Header.Set("X-Gitlab-Event", "Merge Request Hook")
	h.HandleGitLabWebhook(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: expected 401, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestGitLabWebhook_ValidToken_NonMRHook_200(t *testing.T) {
	newGitLabTestHandler(t)
	ctx := context.Background()
	seedGitLabConnection(t, ctx, gitlabTestWebhookToken)

	w := postGitLabWebhook(t, gitlabTestWebhookToken, "Push Hook", map[string]any{"object_kind": "push"})
	if w.Code != http.StatusOK {
		t.Fatalf("non-MR hook: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestGitLabWebhook_MergedMR_AdvancesLinkedIssueToDone(t *testing.T) {
	newGitLabTestHandler(t)
	ctx := context.Background()
	seedGitLabConnection(t, ctx, gitlabTestWebhookToken)

	// Seed an issue we expect the webhook to close out.
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  "MR auto-merge test",
		"status": "in_progress",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: %d %s", w.Code, w.Body.String())
	}
	var created IssueResponse
	json.NewDecoder(w.Body).Decode(&created)
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM issue_merge_request WHERE issue_id = $1`, created.ID)
		testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, created.ID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, created.ID)
	})

	resp := postGitLabWebhook(t, gitlabTestWebhookToken, "Merge Request Hook",
		mrPayload(1, created.Identifier, "merge", "merged"))
	if resp.Code != http.StatusAccepted {
		t.Fatalf("merge webhook: expected 202, got %d (%s)", resp.Code, resp.Body.String())
	}

	mr, err := testHandler.Queries.GetGitLabMergeRequest(ctx, db.GetGitLabMergeRequestParams{
		WorkspaceID: parseUUID(testWorkspaceID),
		ProjectID:   424242,
		MrIid:       1,
	})
	if err != nil {
		t.Fatalf("GetGitLabMergeRequest: %v", err)
	}
	if mr.State != "merged" {
		t.Errorf("expected mr state merged, got %q", mr.State)
	}

	linked, err := testHandler.Queries.ListMergeRequestsByIssue(ctx, parseUUID(created.ID))
	if err != nil {
		t.Fatalf("ListMergeRequestsByIssue: %v", err)
	}
	if len(linked) != 1 {
		t.Fatalf("expected 1 linked MR, got %d", len(linked))
	}

	updated, err := testHandler.Queries.GetIssue(ctx, parseUUID(created.ID))
	if err != nil {
		t.Fatalf("GetIssue: %v", err)
	}
	if updated.Status != "done" {
		t.Errorf("expected issue status 'done', got %q", updated.Status)
	}
}

func TestGitLabWebhook_OpenedMR_LinksWithoutAdvancing(t *testing.T) {
	newGitLabTestHandler(t)
	ctx := context.Background()
	seedGitLabConnection(t, ctx, gitlabTestWebhookToken)

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  "MR open link test",
		"status": "in_progress",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: %d %s", w.Code, w.Body.String())
	}
	var created IssueResponse
	json.NewDecoder(w.Body).Decode(&created)
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM issue_merge_request WHERE issue_id = $1`, created.ID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, created.ID)
	})

	resp := postGitLabWebhook(t, gitlabTestWebhookToken, "Merge Request Hook",
		mrPayload(2, created.Identifier, "open", "opened"))
	if resp.Code != http.StatusAccepted {
		t.Fatalf("open webhook: expected 202, got %d (%s)", resp.Code, resp.Body.String())
	}

	linked, err := testHandler.Queries.ListMergeRequestsByIssue(ctx, parseUUID(created.ID))
	if err != nil {
		t.Fatalf("ListMergeRequestsByIssue: %v", err)
	}
	if len(linked) != 1 {
		t.Fatalf("expected 1 linked MR, got %d", len(linked))
	}

	updated, err := testHandler.Queries.GetIssue(ctx, parseUUID(created.ID))
	if err != nil {
		t.Fatalf("GetIssue: %v", err)
	}
	if updated.Status != "in_progress" {
		t.Errorf("expected issue to remain 'in_progress' (open MR), got %q", updated.Status)
	}
}

// TestGitLabWebhook_MergedMR_TitlePrefixDoesNotClose proves the link-vs-close
// split: a bare title prefix links but does not advance the issue, because no
// closing keyword set close_intent.
func TestGitLabWebhook_MergedMR_TitlePrefixDoesNotClose(t *testing.T) {
	newGitLabTestHandler(t)
	ctx := context.Background()
	seedGitLabConnection(t, ctx, gitlabTestWebhookToken)

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  "MR prefix-only test",
		"status": "in_progress",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: %d %s", w.Code, w.Body.String())
	}
	var created IssueResponse
	json.NewDecoder(w.Body).Decode(&created)
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM issue_merge_request WHERE issue_id = $1`, created.ID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, created.ID)
	})

	body := map[string]any{
		"object_kind": "merge_request",
		"project": map[string]any{
			"id":                  int64(424242),
			"path_with_namespace": "group/widget",
			"web_url":             "https://gitlab.example.com/group/widget",
		},
		"object_attributes": map[string]any{
			"iid":           3,
			"title":         created.Identifier + ": fix login", // prefix only, no keyword
			"description":   "no closing keyword here",
			"state":         "merged",
			"action":        "merge",
			"source_branch": "fix/login",
			"url":           "https://gitlab.example.com/group/widget/-/merge_requests/3",
			"created_at":    "2026-04-28 00:00:00 UTC",
			"updated_at":    "2026-04-29 00:00:00 UTC",
		},
		"user": map[string]any{"username": "octo"},
	}
	resp := postGitLabWebhook(t, gitlabTestWebhookToken, "Merge Request Hook", body)
	if resp.Code != http.StatusAccepted {
		t.Fatalf("merge webhook: expected 202, got %d (%s)", resp.Code, resp.Body.String())
	}

	linked, err := testHandler.Queries.ListMergeRequestsByIssue(ctx, parseUUID(created.ID))
	if err != nil {
		t.Fatalf("ListMergeRequestsByIssue: %v", err)
	}
	if len(linked) != 1 {
		t.Fatalf("expected 1 linked MR (title prefix links), got %d", len(linked))
	}
	updated, err := testHandler.Queries.GetIssue(ctx, parseUUID(created.ID))
	if err != nil {
		t.Fatalf("GetIssue: %v", err)
	}
	if updated.Status == "done" {
		t.Errorf("title prefix without closing keyword must not advance issue to done")
	}
}

func TestPutAndGetGitLabConnection(t *testing.T) {
	newGitLabTestHandler(t)
	ctx := context.Background()
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM gitlab_connection WHERE workspace_id = $1`, testWorkspaceID)
	})

	conn, err := testHandler.Queries.UpsertGitLabConnection(ctx, db.UpsertGitLabConnectionParams{
		WorkspaceID:        parseUUID(testWorkspaceID),
		BaseUrl:            "https://gitlab.example.com",
		WebhookSecretToken: "tok-" + time.Now().Format("150405.000000"),
	})
	if err != nil {
		t.Fatalf("UpsertGitLabConnection: %v", err)
	}
	got, err := testHandler.Queries.GetGitLabConnection(ctx, parseUUID(testWorkspaceID))
	if err != nil {
		t.Fatalf("GetGitLabConnection: %v", err)
	}
	if got.BaseUrl != conn.BaseUrl || got.WebhookSecretToken != conn.WebhookSecretToken {
		t.Errorf("round-trip mismatch: got %+v want %+v", got, conn)
	}
	// Member view hides the webhook token; admin view exposes it.
	if r := gitlabConnectionToResponse(got, false); r.WebhookSecretToken != nil {
		t.Error("non-admin response must omit webhook_secret_token")
	}
	if r := gitlabConnectionToResponse(got, true); r.WebhookSecretToken == nil {
		t.Error("admin response must include webhook_secret_token")
	}
}
