import type { GitLabMergeRequestState } from "../types";

// The self-hosted GitLab MR mirror carries no CI/pipeline or diff-stat data
// this iteration (see HAP-29 contract), so the sidebar row reduces to the MR
// lifecycle state. This helper normalizes the server `state` string into the
// closed set the UI renders, downgrading any unknown value to `open` rather
// than crashing (CLAUDE.md "Enum drift downgrades, not crashes").
export type MergeRequestStatusKind = "open" | "merged" | "closed" | "locked";

export function deriveMergeRequestStatusKind(
  state: GitLabMergeRequestState | string | null | undefined,
): MergeRequestStatusKind {
  switch (state) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "locked":
      return "locked";
    case "opened":
    default:
      return "open";
  }
}
