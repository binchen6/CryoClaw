import type { AppViewState } from "./app-view-state.ts";
import type { FileChange } from "./chat/file-changes.ts";
import { buildChatItemsMemoized, computeSessionFileChangesMemoized } from "./components/oc-chat-history.ts";
import { fetchTurnFileStats, type TurnStatsLookup } from "./chat/turn-file-stats.ts";
import { workspaceViewState } from "./controllers/workspace.ts";

export function selectSessionChanges(state: AppViewState): FileChange[] {
  const items = buildChatItemsMemoized({
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    visibleHistoryCount: state.chatVisibleMessageCount,
  });
  const byPath = new Map<string, FileChange>();
  for (const files of computeSessionFileChangesMemoized(items).values()) {
    for (const file of files) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

export function resolveSessionChangeWorkspace(state: AppViewState, path: string): string {
  const absolute = /^([a-z]:\/|\/)/i.test(path.replace(/\\/g, "/"));
  if (!absolute) {
    const pinned = state.settings.pinnedWorkspaces.find((item) => item.id === state.settings.sessionWorkspaceMap[state.sessionKey]);
    return pinned?.path ?? state.gitRepoPath ?? workspaceViewState.root ?? "";
  }
  const normalized = normalizePath(path);
  const roots = [
    ...state.gitRepoOptions.map((repo) => repo.path),
    ...state.settings.pinnedWorkspaces.map((workspace) => workspace.path),
    ...(workspaceViewState.root ? [workspaceViewState.root] : []),
  ];
  return roots
    .filter((root, index) => roots.indexOf(root) === index)
    .sort((a, b) => b.length - a.length)
    .find((root) => {
      const prefix = normalizePath(root);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }) ?? "";
}

export async function fetchSessionChangeStats(
  state: AppViewState,
  files: readonly FileChange[],
): Promise<TurnStatsLookup> {
  const groups = new Map<string, string[]>();
  let complete = files.length > 0;
  for (const file of files) {
    const workspace = resolveSessionChangeWorkspace(state, file.path);
    if (!workspace) {
      complete = false;
      continue;
    }
    const paths = groups.get(workspace) ?? [];
    paths.push(file.path);
    groups.set(workspace, paths);
  }
  const byPath: TurnStatsLookup["byPath"] = {};
  await Promise.all([...groups].map(async ([workspace, paths]) => {
    const lookup = await fetchTurnFileStats(window.cryoclaw?.gitChangeStats, workspace, paths);
    if (!lookup.complete) complete = false;
    Object.assign(byPath, lookup.byPath);
  }));
  return { byPath, complete };
}
