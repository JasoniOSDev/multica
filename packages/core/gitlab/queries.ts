import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const gitlabKeys = {
  all: (wsId: string) => ["gitlab", wsId] as const,
  connection: (wsId: string) => [...gitlabKeys.all(wsId), "connection"] as const,
  mergeRequests: (issueId: string) => ["gitlab", "merge-requests", issueId] as const,
};

export const gitlabConnectionOptions = (wsId: string) =>
  queryOptions({
    queryKey: gitlabKeys.connection(wsId),
    queryFn: () => api.getGitLabConnection(wsId),
    enabled: !!wsId,
  });

export const issueMergeRequestsOptions = (issueId: string) =>
  queryOptions({
    queryKey: gitlabKeys.mergeRequests(issueId),
    queryFn: () => api.listIssueMergeRequests(issueId),
    enabled: !!issueId,
  });
