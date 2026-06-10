import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { GitLabMergeRequest } from "@multica/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

vi.mock("@multica/core/gitlab/queries", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/gitlab/queries")>(
    "@multica/core/gitlab/queries",
  );
  return {
    ...actual,
    issueMergeRequestsOptions: (issueId: string) => ({
      queryKey: ["gitlab", "merge-requests", issueId],
      queryFn: async () => ({ merge_requests: mockMRs }),
      enabled: !!issueId,
    }),
  };
});

import { MergeRequestList } from "./merge-request-list";

let mockMRs: GitLabMergeRequest[] = [];

function makeMR(overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
    id: "mr-1",
    workspace_id: "ws-1",
    project_id: 42,
    project_path: "group/widget",
    iid: 1,
    title: "Test MR",
    state: "opened",
    web_url: "https://gitlab.example.com/group/widget/-/merge_requests/1",
    source_branch: "feat/x",
    author_username: "alice",
    author_avatar_url: null,
    merged_at: null,
    closed_at: null,
    mr_created_at: "2026-01-01T00:00:00Z",
    mr_updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider resources={TEST_RESOURCES} locale="en">
        <MergeRequestList issueId="issue-1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function waitForRender() {
  return screen.findAllByRole("link");
}

describe("MergeRequestList sidebar rows", () => {
  it("uses the sidebar list-row surface instead of a card surface", async () => {
    mockMRs = [makeMR({ title: "Visual row" })];
    renderList();
    await waitForRender();
    const row = screen.getByTestId("merge-request-row");
    expect(row).toHaveClass("rounded-md", "-mx-2", "hover:bg-accent/50");
    expect(row).not.toHaveClass("rounded-lg", "border", "bg-card");
  });

  it("renders the project_path!iid reference, state label, and author", async () => {
    mockMRs = [makeMR({ project_path: "group/widget", iid: 7, author_username: "bob" })];
    renderList();
    await waitForRender();
    expect(screen.getByText(/group\/widget!7/)).toBeInTheDocument();
    expect(screen.getByText(/@bob/)).toBeInTheDocument();
  });

  it("links the row to the MR web_url", async () => {
    mockMRs = [makeMR({ web_url: "https://gitlab.example.com/group/widget/-/merge_requests/1" })];
    renderList();
    await waitForRender();
    expect(screen.getByTestId("merge-request-row")).toHaveAttribute(
      "href",
      "https://gitlab.example.com/group/widget/-/merge_requests/1",
    );
  });

  it("renders Merged label for merged MRs", async () => {
    mockMRs = [makeMR({ state: "merged" })];
    renderList();
    await waitForRender();
    expect(screen.getByText(/Merged/)).toBeInTheDocument();
  });

  it("downgrades an unknown state to the open label rather than crashing", async () => {
    mockMRs = [makeMR({ state: "some_future_state" as GitLabMergeRequest["state"] })];
    renderList();
    await waitForRender();
    expect(screen.getByText(/Open/)).toBeInTheDocument();
  });

  it("renders a bare !iid when project_path is empty (schema fallback)", async () => {
    mockMRs = [makeMR({ project_path: "", iid: 3 })];
    renderList();
    await waitForRender();
    expect(screen.getByText(/!3/)).toBeInTheDocument();
  });

  it("collapses extra MR rows past the visible limit behind Show more toggle", async () => {
    mockMRs = [
      makeMR({ id: "a", iid: 1, title: "MR-A" }),
      makeMR({ id: "b", iid: 2, title: "MR-B" }),
      makeMR({ id: "c", iid: 3, title: "MR-C" }),
      makeMR({ id: "d", iid: 4, title: "MR-D" }),
      makeMR({ id: "e", iid: 5, title: "MR-E" }),
    ];
    renderList();
    await waitForRender();
    expect(screen.getByText("MR-A")).toBeInTheDocument();
    expect(screen.getByText("MR-B")).toBeInTheDocument();
    expect(screen.getByText("MR-C")).toBeInTheDocument();
    expect(screen.queryByText("MR-D")).not.toBeInTheDocument();
    expect(screen.queryByText("MR-E")).not.toBeInTheDocument();
    expect(screen.getByText("Show 2 more")).toBeInTheDocument();
  });

  it("collapses to 3 rows + hidden tail when count == threshold", async () => {
    mockMRs = [
      makeMR({ id: "a", iid: 1, title: "MR-A" }),
      makeMR({ id: "b", iid: 2, title: "MR-B" }),
      makeMR({ id: "c", iid: 3, title: "MR-C" }),
      makeMR({ id: "d", iid: 4, title: "MR-D" }),
    ];
    renderList();
    await waitForRender();
    expect(screen.getByText("MR-A")).toBeInTheDocument();
    expect(screen.getByText("MR-B")).toBeInTheDocument();
    expect(screen.getByText("MR-C")).toBeInTheDocument();
    expect(screen.queryByText("MR-D")).not.toBeInTheDocument();
    expect(screen.getByText("Show 1 more")).toBeInTheDocument();
  });
});
