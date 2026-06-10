"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  KeyRound,
  Link2,
  PanelRight,
  RefreshCw,
} from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Switch } from "@multica/ui/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentWorkspace } from "@multica/core/paths";
import { memberListOptions, workspaceKeys } from "@multica/core/workspace/queries";
import {
  deriveGitLabSettings,
  gitlabConnectionOptions,
  gitlabKeys,
} from "@multica/core/gitlab";
import { api } from "@multica/core/api";
import type { GitLabConnectionResponse, Workspace } from "@multica/core/types";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { GitLabMark } from "./gitlab-mark";

type SettingsKey =
  | "gitlab_enabled"
  | "gitlab_mr_sidebar_enabled"
  | "co_authored_by_enabled"
  | "gitlab_auto_link_mrs_enabled";

// Generate a fresh webhook secret token client-side. The PUT contract treats a
// non-empty `webhook_secret_token` as "set this value", so rotation means
// sending a new random token; the backend only auto-generates on first create
// when the field is omitted.
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function GitLabTab() {
  const { t } = useT("settings");
  const workspace = useCurrentWorkspace();
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const navigation = useNavigation();
  const user = useAuthStore((s) => s.user);

  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  // Every workspace member may view the connection state; only owner/admin may
  // manage it. `canManage` is authoritative from the backend response so the
  // frontend never claims management rights the server would reject.
  const canView = !!currentMember;

  const { data: connectionData } = useQuery({
    ...gitlabConnectionOptions(wsId),
    enabled: !!wsId && canView,
  });
  const connection = connectionData?.connection ?? null;
  const configured = connectionData?.configured ?? false;
  const canManage = connectionData?.can_manage === true;

  const flags = deriveGitLabSettings(workspace);
  const [savingKey, setSavingKey] = useState<SettingsKey | null>(null);

  const [baseUrl, setBaseUrl] = useState(connection?.base_url ?? "");
  const [pat, setPat] = useState("");
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [copied, setCopied] = useState<"token" | "url" | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Mirror the server value into the input whenever it changes (initial load,
  // WS-driven refetch). Editing locally then diverges until the next save.
  useEffect(() => {
    setBaseUrl(connection?.base_url ?? "");
  }, [connection?.base_url]);

  const webhookUrl = `${api.getBaseUrl()}/api/webhooks/gitlab`;

  function applyConnectionResponse(resp: GitLabConnectionResponse) {
    qc.setQueryData(gitlabKeys.connection(wsId), resp);
  }

  async function persistSetting(key: SettingsKey, next: boolean) {
    if (!workspace || savingKey) return;
    setSavingKey(key);
    try {
      const merged = {
        ...((workspace.settings as Record<string, unknown>) ?? {}),
        [key]: next,
      };
      const updated = await api.updateWorkspace(workspace.id, { settings: merged });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((ws) => (ws.id === updated.id ? updated : ws)),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.gitlab.toast_save_failed));
    } finally {
      setSavingKey(null);
    }
  }

  async function handleSaveConnection() {
    const trimmed = baseUrl.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const resp = await api.updateGitLabConnection(wsId, {
        base_url: trimmed,
        // Non-empty PAT replaces the stored one; empty input leaves it
        // untouched (the field is omitted).
        ...(pat.trim() ? { access_token: pat.trim() } : {}),
      });
      applyConnectionResponse(resp);
      setPat("");
      toast.success(t(($) => $.gitlab.toast_saved));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.gitlab.toast_save_failed));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearPat() {
    if (!connection || saving) return;
    setSaving(true);
    try {
      const resp = await api.updateGitLabConnection(wsId, {
        base_url: connection.base_url,
        access_token: "",
      });
      applyConnectionResponse(resp);
      toast.success(t(($) => $.gitlab.toast_pat_cleared));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.gitlab.toast_save_failed));
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerateToken() {
    if (!connection || regenerating) return;
    setRegenerating(true);
    try {
      const resp = await api.updateGitLabConnection(wsId, {
        base_url: connection.base_url,
        webhook_secret_token: randomToken(),
      });
      applyConnectionResponse(resp);
      toast.success(t(($) => $.gitlab.toast_token_regenerated));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.gitlab.toast_save_failed));
    } finally {
      setRegenerating(false);
    }
  }

  async function handleCopy(kind: "token" | "url", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error(t(($) => $.gitlab.toast_copy_failed));
    }
  }

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await api.deleteGitLabConnection(wsId);
      await qc.invalidateQueries({ queryKey: gitlabKeys.all(wsId) });
      toast.success(t(($) => $.gitlab.toast_disconnected));
      setDisconnectOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.gitlab.toast_disconnect_failed));
    } finally {
      setDisconnecting(false);
    }
  }

  if (!workspace) return null;

  const repositoriesHref = `${navigation.pathname}?tab=repositories`;
  const baseUrlDirty = baseUrl.trim() !== (connection?.base_url ?? "");

  return (
    <div className="space-y-8">
      <section className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {t(($) => $.gitlab.page_description)}
        </p>
      </section>

      <section className="space-y-3">
        <Card>
          <CardContent>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="rounded-md border bg-muted/50 p-2 text-muted-foreground">
                  <GitLabMark className="h-4 w-4" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="gitlab-master" className="text-sm font-medium">
                    {t(($) => $.gitlab.section_master)}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {flags.enabled
                      ? t(($) => $.gitlab.master_description_on)
                      : t(($) => $.gitlab.master_description_off)}
                  </p>
                </div>
              </div>
              <Switch
                id="gitlab-master"
                checked={flags.enabled}
                onCheckedChange={(v) => persistSetting("gitlab_enabled", v)}
                disabled={!canManage || savingKey === "gitlab_enabled"}
              />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t(($) => $.gitlab.section_connection)}</h2>
        <Card>
          <CardContent className="space-y-5">
            {!canManage ? (
              <p className="text-sm text-muted-foreground">
                {configured
                  ? t(($) => $.gitlab.connected_to, { base_url: connection?.base_url ?? "" })
                  : t(($) => $.gitlab.contact_admin_to_connect)}
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="gitlab-base-url" className="text-sm font-medium">
                    {t(($) => $.gitlab.base_url_label)}
                  </Label>
                  <Input
                    id="gitlab-base-url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={t(($) => $.gitlab.base_url_placeholder)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(($) => $.gitlab.base_url_help)}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="gitlab-pat" className="flex items-center gap-1.5 text-sm font-medium">
                    <KeyRound className="h-3.5 w-3.5" />
                    {t(($) => $.gitlab.pat_label)}
                  </Label>
                  <Input
                    id="gitlab-pat"
                    type="password"
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    placeholder={
                      connection?.has_access_token === true
                        ? t(($) => $.gitlab.pat_placeholder_set)
                        : t(($) => $.gitlab.pat_placeholder_empty)
                    }
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {t(($) => $.gitlab.pat_help)}
                    </p>
                    {connection?.has_access_token === true && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground"
                        onClick={handleClearPat}
                        disabled={saving}
                      >
                        {t(($) => $.gitlab.pat_clear)}
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  {configured ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDisconnectOpen(true)}
                    >
                      {t(($) => $.gitlab.disconnect)}
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button
                    size="sm"
                    onClick={handleSaveConnection}
                    disabled={saving || !baseUrl.trim() || (configured && !baseUrlDirty && !pat.trim())}
                  >
                    {saving
                      ? t(($) => $.gitlab.saving)
                      : configured
                        ? t(($) => $.gitlab.save)
                        : t(($) => $.gitlab.connect)}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {canManage && configured && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t(($) => $.gitlab.section_webhook)}</h2>
          <Card>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t(($) => $.gitlab.webhook_intro)}
              </p>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t(($) => $.gitlab.webhook_url_label)}
                </Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">
                    {webhookUrl}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={t(($) => $.gitlab.copy)}
                    onClick={() => handleCopy("url", webhookUrl)}
                  >
                    {copied === "url" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t(($) => $.gitlab.webhook_token_label)}
                </Label>
                {connection?.webhook_secret_token ? (
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">
                      {connection.webhook_secret_token}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      aria-label={t(($) => $.gitlab.copy)}
                      onClick={() => handleCopy("token", connection.webhook_secret_token!)}
                    >
                      {copied === "token" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      aria-label={t(($) => $.gitlab.regenerate)}
                      onClick={handleRegenerateToken}
                      disabled={regenerating}
                    >
                      <RefreshCw className={regenerating ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t(($) => $.gitlab.webhook_token_hidden)}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.gitlab.webhook_token_help)}
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t(($) => $.gitlab.section_features)}</h2>
        <Card>
          <CardContent className="space-y-4">
            <FeatureRow
              id="gitlab-mr-sidebar"
              icon={<PanelRight className="h-4 w-4" />}
              label={t(($) => $.gitlab.feature_mr_sidebar_label)}
              description={
                <p className="text-sm text-muted-foreground">
                  {t(($) => $.gitlab.feature_mr_sidebar_description)}
                </p>
              }
              checked={flags.mrSidebar}
              disabled={!canManage || !flags.enabled || savingKey === "gitlab_mr_sidebar_enabled"}
              onCheckedChange={(v) => persistSetting("gitlab_mr_sidebar_enabled", v)}
            />

            <FeatureRow
              id="gitlab-coauthor"
              icon={<GitCommitHorizontal className="h-4 w-4" />}
              label={t(($) => $.gitlab.feature_co_author_label)}
              description={
                <p className="text-sm text-muted-foreground">
                  {t(($) => $.gitlab.feature_co_author_description_prefix)}{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    {"Co-authored-by: multica-agent <agent@multica.ai>"}
                  </code>{" "}
                  {t(($) => $.gitlab.feature_co_author_description_suffix)}
                </p>
              }
              checked={flags.coAuthor}
              disabled={!canManage || !flags.enabled || savingKey === "co_authored_by_enabled"}
              onCheckedChange={(v) => persistSetting("co_authored_by_enabled", v)}
            />

            <FeatureRow
              id="gitlab-auto-link"
              icon={<Link2 className="h-4 w-4" />}
              label={t(($) => $.gitlab.feature_auto_link_label)}
              description={
                <p className="text-sm text-muted-foreground">
                  {t(($) => $.gitlab.feature_auto_link_description)}
                </p>
              }
              checked={flags.autoLinkMRs}
              disabled={!canManage || !flags.enabled || savingKey === "gitlab_auto_link_mrs_enabled"}
              onCheckedChange={(v) => persistSetting("gitlab_auto_link_mrs_enabled", v)}
            />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t(($) => $.gitlab.section_repositories)}</h2>
        <Card>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium">
                {t(($) => $.gitlab.repositories_shortcut_label)}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigation.push(repositoriesHref)}
              >
                <ExternalLink className="h-3 w-3" />
                {t(($) => $.gitlab.repositories_shortcut_link)}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <AlertDialog
        open={disconnectOpen}
        onOpenChange={(v) => {
          if (!v && !disconnecting) setDisconnectOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.gitlab.disconnect_confirm_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.gitlab.disconnect_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting}>
              {t(($) => $.gitlab.disconnect_confirm_cancel)}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting
                ? t(($) => $.gitlab.disconnecting)
                : t(($) => $.gitlab.disconnect_confirm_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FeatureRow({
  id,
  icon,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  description: React.ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="rounded-md border bg-muted/50 p-2 text-muted-foreground">{icon}</div>
        <div className="space-y-1">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          {description}
        </div>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
