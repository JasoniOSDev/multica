"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, Lock } from "lucide-react";
import {
  issueMergeRequestsOptions,
  deriveMergeRequestStatusKind,
  type MergeRequestStatusKind,
} from "@multica/core/gitlab";
import type { GitLabMergeRequest } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

type IssuesT = ReturnType<typeof useT<"issues">>["t"];

// Keep the existing sidebar density: show the first 3 MR rows inline, then
// collapse the rest once the section reaches 4 rows.
const MR_LIMIT_BEFORE_COLLAPSE = 4;

const STATUS_ICON: Record<
  MergeRequestStatusKind,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  open: { icon: GitPullRequestArrow, className: "text-emerald-600 dark:text-emerald-400" },
  merged: { icon: GitMerge, className: "text-violet-600 dark:text-violet-400" },
  closed: { icon: GitPullRequestClosed, className: "text-rose-600 dark:text-rose-400" },
  locked: { icon: Lock, className: "text-muted-foreground" },
};

export function MergeRequestList({ issueId }: { issueId: string }) {
  const { t } = useT("issues");
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useQuery(issueMergeRequestsOptions(issueId));
  const mrs = data?.merge_requests ?? [];

  if (isLoading) {
    return <p className="text-xs text-muted-foreground px-2">{t(($) => $.detail.merge_requests_loading)}</p>;
  }
  if (mrs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground px-2">
        {t(($) => $.detail.merge_requests_empty)}
      </p>
    );
  }

  // Render rule:
  //   - <  MR_LIMIT_BEFORE_COLLAPSE: every MR row is visible.
  //   - >= MR_LIMIT_BEFORE_COLLAPSE: first (LIMIT - 1) rows are visible and
  //     the remainder sits behind a toggle.
  const useCollapse = mrs.length >= MR_LIMIT_BEFORE_COLLAPSE;
  const expandedHead = useCollapse ? mrs.slice(0, MR_LIMIT_BEFORE_COLLAPSE - 1) : mrs;
  const collapsedTail = useCollapse ? mrs.slice(MR_LIMIT_BEFORE_COLLAPSE - 1) : [];

  return (
    <div className="space-y-1">
      {expandedHead.map((mr) => (
        <MergeRequestRow key={mr.id} mr={mr} />
      ))}
      {useCollapse ? (
        <div className="space-y-1">
          {expanded
            ? collapsedTail.map((mr) => <MergeRequestRow key={mr.id} mr={mr} />)
            : null}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="block w-[calc(100%+1rem)] -mx-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            {expanded
              ? t(($) => $.detail.merge_request_card_show_less)
              : t(($) => $.detail.merge_request_card_show_more, { count: collapsedTail.length })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MergeRequestRow({ mr }: { mr: GitLabMergeRequest }) {
  const { t } = useT("issues");
  const kind = deriveMergeRequestStatusKind(mr.state);
  const cfg = STATUS_ICON[kind];
  const StateIcon = cfg.icon;
  const stateLabel = getStateLabel(kind, t);
  // project_path may be empty if a malformed payload fell through the schema
  // fallback — guard so we never render a bare "#5".
  const ref = mr.project_path ? `${mr.project_path}!${mr.iid}` : `!${mr.iid}`;

  return (
    <a
      data-testid="merge-request-row"
      href={mr.web_url}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-start gap-2 rounded-md px-2 py-1.5 -mx-2 hover:bg-accent/50 transition-colors group"
    >
      <StateIcon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", cfg.className)} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-snug truncate group-hover:text-foreground">
          {mr.title}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          {ref} · {stateLabel}
          {mr.author_username ? ` · @${mr.author_username}` : null}
        </p>
      </div>
    </a>
  );
}

function getStateLabel(kind: MergeRequestStatusKind, t: IssuesT): string {
  switch (kind) {
    case "merged":
      return t(($) => $.detail.merge_request_state_merged);
    case "closed":
      return t(($) => $.detail.merge_request_state_closed);
    case "locked":
      return t(($) => $.detail.merge_request_state_locked);
    case "open":
      return t(($) => $.detail.merge_request_state_open);
  }
}
