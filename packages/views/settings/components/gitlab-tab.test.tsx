import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockDeleteConnection = vi.hoisted(() => vi.fn());
const mockUpdateConnection = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());
const mockNavPush = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());

const workspaceRef = vi.hoisted(() => ({
  current: {
    id: "workspace-1",
    name: "Acme",
    slug: "acme",
    settings: {} as Record<string, unknown>,
    repos: [{ url: "https://gitlab.example.com/acme/api" }] as { url: string }[],
  },
}));
type MemberRole = "owner" | "admin" | "member" | "guest";
const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as MemberRole }],
}));
type ConnState = {
  connection: {
    workspace_id: string;
    base_url: string;
    webhook_secret_token?: string;
    has_access_token: boolean;
    created_at: string;
    updated_at: string;
  } | null;
  configured: boolean;
  can_manage: boolean;
};
const connectionRef = vi.hoisted(() => ({
  current: { connection: null, configured: false, can_manage: true } as ConnState,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (key.includes("members")) return { data: membersRef.current };
    if (key.includes("connection")) return { data: connectionRef.current };
    return { data: undefined };
  },
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidate,
  }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => workspaceRef.current,
}));

vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
  workspaceKeys: { list: () => ["workspaces"] },
}));

vi.mock("@multica/core/gitlab", async () => {
  const actual =
    await vi.importActual<typeof import("@multica/core/gitlab")>("@multica/core/gitlab");
  return {
    ...actual,
    gitlabConnectionOptions: () => ({
      queryKey: ["gitlab", "workspace-1", "connection"],
      queryFn: vi.fn(),
    }),
  };
});

vi.mock("@multica/core/api", () => ({
  api: {
    updateWorkspace: mockUpdateWorkspace,
    deleteGitLabConnection: mockDeleteConnection,
    updateGitLabConnection: mockUpdateConnection,
    getBaseUrl: () => "https://api.example",
  },
}));

vi.mock("@multica/core/auth", () => {
  const useAuthStore = Object.assign(
    (sel?: (s: { user: { id: string } }) => unknown) =>
      sel ? sel({ user: { id: "user-1" } }) : { user: { id: "user-1" } },
    { getState: () => ({ user: { id: "user-1" } }) },
  );
  return { useAuthStore };
});

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: mockNavPush,
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/settings",
    searchParams: new URLSearchParams("tab=gitlab"),
    getShareableUrl: (p: string) => `https://app.example${p}`,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { GitLabTab } from "./gitlab-tab";

const TEST_RESOURCES = {
  en: { common: enCommon, settings: enSettings },
};

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function resetFixtures() {
  vi.clearAllMocks();
  workspaceRef.current = {
    id: "workspace-1",
    name: "Acme",
    slug: "acme",
    settings: {},
    repos: [{ url: "https://gitlab.example.com/acme/api" }],
  };
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
  connectionRef.current = { connection: null, configured: false, can_manage: true };
}

const CONFIGURED: ConnState = {
  configured: true,
  can_manage: true,
  connection: {
    workspace_id: "workspace-1",
    base_url: "https://gitlab.example.com",
    webhook_secret_token: "secrettoken123",
    has_access_token: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
};

describe("GitLabTab", () => {
  beforeEach(resetFixtures);

  it("folds the non-dev hint into the master switch description", () => {
    render(<GitLabTab />, { wrapper: I18nWrapper });
    expect(screen.getByText(/Not a development team\? Just turn it off here\./)).toBeTruthy();
  });

  it("does not show the hint once the master switch is off", () => {
    workspaceRef.current.settings = { gitlab_enabled: false };
    render(<GitLabTab />, { wrapper: I18nWrapper });
    expect(screen.queryByText(/Not a development team\?/)).toBeNull();
  });

  it("disables every feature switch when the master switch is off", () => {
    workspaceRef.current.settings = { gitlab_enabled: false };
    render(<GitLabTab />, { wrapper: I18nWrapper });

    const master = screen.getByRole("switch", { name: /enable gitlab features/i });
    expect(master.getAttribute("aria-checked")).toBe("false");

    const features = screen.getAllByRole("switch").slice(1);
    expect(features.length).toBeGreaterThan(0);
    for (const sw of features) {
      const ariaDisabled = sw.getAttribute("aria-disabled");
      const disabled = sw.hasAttribute("disabled");
      expect(ariaDisabled === "true" || disabled).toBe(true);
    }
  });

  it("flipping the master switch off persists gitlab_enabled=false and merges existing settings", async () => {
    const user = userEvent.setup();
    workspaceRef.current.settings = { co_authored_by_enabled: true };
    mockUpdateWorkspace.mockResolvedValue({
      ...workspaceRef.current,
      settings: { co_authored_by_enabled: true, gitlab_enabled: false },
    });

    render(<GitLabTab />, { wrapper: I18nWrapper });
    await user.click(screen.getByRole("switch", { name: /enable gitlab features/i }));

    await waitFor(() => {
      expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", {
        settings: { co_authored_by_enabled: true, gitlab_enabled: false },
      });
    });
  });

  it("saves the base URL via updateGitLabConnection when unconfigured", async () => {
    const user = userEvent.setup();
    mockUpdateConnection.mockResolvedValue(CONFIGURED);

    render(<GitLabTab />, { wrapper: I18nWrapper });
    await user.type(
      screen.getByLabelText(/GitLab base URL/i),
      "https://gitlab.example.com",
    );
    await user.click(screen.getByRole("button", { name: /^Connect$/ }));

    await waitFor(() => {
      expect(mockUpdateConnection).toHaveBeenCalledWith("workspace-1", {
        base_url: "https://gitlab.example.com",
      });
    });
  });

  it("shows the webhook URL and secret token to managers once configured", () => {
    connectionRef.current = CONFIGURED;
    render(<GitLabTab />, { wrapper: I18nWrapper });
    expect(screen.getByText("https://api.example/api/webhooks/gitlab")).toBeTruthy();
    expect(screen.getByText("secrettoken123")).toBeTruthy();
  });

  it("clicking Disconnect opens the confirmation and only fires on confirm", async () => {
    const user = userEvent.setup();
    connectionRef.current = CONFIGURED;
    mockDeleteConnection.mockResolvedValue(undefined);

    render(<GitLabTab />, { wrapper: I18nWrapper });

    await user.click(screen.getByRole("button", { name: /^Disconnect$/ }));
    expect(screen.getByText(/Multica will stop receiving webhooks/i)).toBeTruthy();
    expect(mockDeleteConnection).not.toHaveBeenCalled();

    const dialogConfirm = screen
      .getAllByRole("button", { name: /^Disconnect$/ })
      .find((b) => b.getAttribute("data-slot")?.includes("alert-dialog"));
    await user.click(dialogConfirm ?? screen.getAllByRole("button", { name: /^Disconnect$/ })[1]!);

    await waitFor(() => {
      expect(mockDeleteConnection).toHaveBeenCalledWith("workspace-1");
    });
  });

  it("non-admin sees the connection summary but no editing controls", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    connectionRef.current = {
      configured: true,
      can_manage: false,
      connection: {
        workspace_id: "workspace-1",
        base_url: "https://gitlab.example.com",
        has_access_token: false,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    };
    render(<GitLabTab />, { wrapper: I18nWrapper });

    expect(screen.getByText(/Connected to https:\/\/gitlab\.example\.com/i)).toBeTruthy();
    expect(screen.queryByLabelText(/GitLab base URL/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Disconnect$/ })).toBeNull();
  });

  it("non-admin with no connection sees the contact-admin hint", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    connectionRef.current = { connection: null, configured: false, can_manage: false };
    render(<GitLabTab />, { wrapper: I18nWrapper });

    expect(screen.getByText(/Ask an admin or owner/i)).toBeTruthy();
    expect(screen.queryByLabelText(/GitLab base URL/i)).toBeNull();
  });

  it("repositories shortcut navigates to the repositories tab", async () => {
    const user = userEvent.setup();
    render(<GitLabTab />, { wrapper: I18nWrapper });
    await user.click(screen.getByRole("button", { name: /Manage repositories/ }));
    expect(mockNavPush).toHaveBeenCalledWith("/acme/settings?tab=repositories");
  });
});
