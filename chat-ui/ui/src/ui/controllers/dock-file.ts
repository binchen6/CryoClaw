import type { AppViewState } from "../app-view-state.ts";
import { fileChangeBaseName } from "../chat/file-changes.ts";
import { initWorkspace, loadWorkspaceFile, setWorkspaceRoot, workspaceViewState } from "./workspace.ts";
import { openDockTab } from "./dock.ts";

/** Join only. The main process retains authority over containment and symlinks. */
export function resolveDockFilePath(path: string, root: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(path)) return path;
  if (!root) return null;
  const separator = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + separator + path.replace(/[\\/]/g, separator);
}

export async function openDockFile(state: AppViewState, path: string, sessionRoot?: string): Promise<boolean> {
  if (workspaceViewState.fileSaving) return false;
  const root = sessionRoot || state.gitRepoPath || workspaceViewState.root;
  // Use the normal root transition so unsaved drafts can veto navigation.
  if (root && root !== workspaceViewState.root) {
    if (!await setWorkspaceRoot(state, root, true)) return false;
  } else if (!workspaceViewState.root) await initWorkspace(state);
  const absolute = resolveDockFilePath(path, root || workspaceViewState.root);
  if (!absolute || !workspaceViewState.root) return false;
  openDockTab(state, "files");
  await loadWorkspaceFile(state, absolute, fileChangeBaseName(absolute));
  if (workspaceViewState.selectedFile !== absolute || workspaceViewState.fileError) return false;
  // Retire the legacy tool-output close callback only after file navigation succeeds.
  const sidebar = state as unknown as { sidebarCloseTimer?: number | null };
  if (sidebar.sidebarCloseTimer != null) {
    window.clearTimeout(sidebar.sidebarCloseTimer);
    sidebar.sidebarCloseTimer = null;
  }
  state.sidebarLeaving = false;
  state.sidebarOpen = false;
  state.sidebarContent = null;
  state.sidebarError = null;
  state.requestUpdate();
  return true;
}
