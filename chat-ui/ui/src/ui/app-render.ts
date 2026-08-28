/**
 * CryoClaw custom app-render.ts
 * Replaces the upstream 13-tab dashboard with a minimal sidebar + chat layout.
 *
 * 阶段 16 瘦身：本文件只保留 renderApp 壳层（侧边栏 / 标题栏 / 内容区分发 / 全局弹窗）。
 * 各视图的渲染与逻辑已拆到 app-chat-props / app-skills / app-cron / app-tasks /
 * app-session-actions / app-view-switch / app-toast；
 * 视图清单与 fullpage/back 规则见 views/registry.ts（新增视图接线点共 3 处，见其文件头）。
 */
import { html, nothing } from "lit";
import type { AppViewState } from "./app-view-state.ts";
import { buildChatProps } from "./app-chat-props.ts";
import {
  createNewSession,
  createNewWorktreeSession,
  deleteSessionFromSidebar,
  ensureFileDropBridge,
  handleOpenWebUI,
  handleReconnect,
  handleSessionChange,
  isDeletingSession,
  patchSessionFromSidebar,
  resolveSessionOptions,
  updateFileDropState,
} from "./app-session-actions.ts";
import { openExtensionsView, renderExtensionsView } from "./app-extensions.ts";
import { openTasksView, renderTasksView } from "./app-tasks.ts";
import { getToastAction, getToastMessage, hideToast } from "./app-toast.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { loadSessions, patchSession } from "./controllers/sessions.ts";
import { isActiveTask } from "./controllers/tasks.ts";
import { t } from "./i18n.ts";
import { icons } from "./icons.ts";
import { resolveMainSessionKey } from "./session-visibility.ts";
// 侧边栏独立组件（R41 Task 12）：流式帧等根组件高频更新不再重求值侧边栏模板树，
// 原 renderSidebar 模板与菜单模块态整体迁入组件（接线见 renderApp 的 <cc-sidebar>）
import "./components/cc-sidebar.ts";
import { renderChat } from "./views/chat.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderReleaseNotesModal } from "./views/release-notes-modal.ts";
import { CRYOCLAW_VIEW_META, type CryoClawViewId } from "./views/registry.ts";
import { renderRestartGatewayDialog } from "./views/restart-gateway-dialog.ts";
import { renderConfirmDialog } from "./views/confirm-dialog.ts";
import { renderSettingsView } from "./views/settings/settings-view.ts";
import { renderSetupView } from "./views/setup/setup-view.ts";
import { renderSharePrompt } from "./views/share-prompt.ts";
import { openWorkspaceView, renderWorkspaceIntegratedView } from "./app-workspace.ts";
import { renderWebbridgePillModal } from "./views/webbridge-pill-modal.ts";

declare global {
  interface Window {
    cryoclaw?: {
      openSettings?: () => void;
      openWebUI?: () => void;
      openExternal?: (url: string) => unknown;
      getGatewayPort?: () => Promise<number>;
      skillStoreList?: (params?: Record<string, unknown>) => Promise<any>;
      skillStoreSearch?: (params?: Record<string, unknown>) => Promise<any>;
      skillStoreDetail?: (params?: Record<string, unknown>) => Promise<any>;
      skillStoreInstall?: (params?: Record<string, unknown>) => Promise<any>;
      skillStoreUninstall?: (params?: Record<string, unknown>) => Promise<any>;
      skillStoreListInstalled?: () => Promise<any>;
      pluginStoreList?: () => Promise<any>;
      pluginStoreSearch?: (params?: Record<string, unknown>) => Promise<any>;
      pluginStoreInstall?: (params?: Record<string, unknown>) => Promise<any>;
      pluginStoreUninstall?: (params?: Record<string, unknown>) => Promise<any>;
      workspaceSetRoot?: (root: string) => Promise<any>;
      workspaceOpenFile?: (filePath: string) => Promise<any>;
      workspaceOpenFolder?: (filePath: string) => Promise<any>;
      workspaceListDir?: (dirPath: string) => Promise<any>;
      workspaceReadFile?: (filePath: string) => Promise<any>;
      gitDetect?: () => Promise<any>;
      // git 面板（P4）：status/diff 返回主进程解析后的结构化数据
      gitStatus?: (cwd: string) => Promise<any>;
      gitDiff?: (cwd: string, opts?: { cached?: boolean; path?: string }) => Promise<any>;
      gitStage?: (cwd: string, paths: string[]) => Promise<any>;
      gitUnstage?: (cwd: string, paths: string[]) => Promise<any>;
      gitCommit?: (cwd: string, message: string) => Promise<any>;
      // Settings: Advanced / Gateway control
      settingsGetAdvanced?: () => Promise<any>;
      settingsSaveAdvanced?: (params: Record<string, unknown>) => Promise<any>;
      restartGateway?: () => void;
    };
  }
}

// 打开内嵌设置页时可携带目标 tab 提示，减少用户二次定位成本。
function openSettingsView(state: AppViewState, tabHint: string | null = null) {
  state.settingsTabHint = tabHint;
  setCryoClawView(state, "settings");
}

// R41 Task 12：sessionOptions 原本每次 renderApp 重建新数组，但数据源只有这五个；
// <cc-sidebar> 的 shouldUpdate 按引用比较 sessionOptions，不 memo 则流式帧每次根渲染
// 都是新引用，侧边栏隔离失效。状态层对这两个数组一律整体重赋值、从不原地改，按引用比较安全。
let sessionOptionsMemo: {
  sessionsResult: AppViewState["sessionsResult"];
  worktrees: AppViewState["worktrees"];
  sessionKey: string;
  sessionsIncludeArchived: boolean;
  sidebarSessionSearch: string;
  result: ReturnType<typeof resolveSessionOptions>;
} | null = null;

function resolveSessionOptionsMemo(state: AppViewState) {
  const sessionsIncludeArchived = state.sessionsIncludeArchived === true;
  const sidebarSessionSearch = state.sidebarSessionSearch ?? "";
  const prev = sessionOptionsMemo;
  if (
    prev &&
    prev.sessionsResult === state.sessionsResult &&
    prev.worktrees === state.worktrees &&
    prev.sessionKey === state.sessionKey &&
    prev.sessionsIncludeArchived === sessionsIncludeArchived &&
    prev.sidebarSessionSearch === sidebarSessionSearch
  ) {
    return prev.result;
  }
  const result = resolveSessionOptions(state);
  sessionOptionsMemo = {
    sessionsResult: state.sessionsResult,
    worktrees: state.worktrees,
    sessionKey: state.sessionKey,
    sessionsIncludeArchived,
    sidebarSessionSearch,
    result,
  };
  return result;
}

/** 内容区分发：按当前视图渲染对应视图（新增视图接线点之一，见 views/registry.ts） */
function renderActiveView(state: AppViewState, view: CryoClawViewId) {
  switch (view) {
    case "setup":
      return renderSetupView(state);
    case "settings":
      return renderSettingsView(state);
    case "extensions":
      return renderExtensionsView(state);
    case "workspace":
      return renderWorkspaceIntegratedView(state);
    case "tasks":
      return renderTasksView(state);
    default:
      return renderChat(buildChatProps(state));
  }
}

export function renderApp(state: AppViewState) {
  ensureFileDropBridge(state);
  updateFileDropState(state);
  const chatDisabledReason = state.connected ? null : t("error.disconnected");
  const chatFocus = state.onboarding;
  const sidebarCollapsed = !state.onboarding && state.settings.navCollapsed;
  const currentSessionKey = state.sessionKey;
  const sessionOptions = resolveSessionOptionsMemo(state);
  const cryoclawView = state.settings.cryoclawView ?? "chat";
  const meta = CRYOCLAW_VIEW_META[cryoclawView];

  return html`
    <div
      class="cryoclaw-shell ${navigator.platform?.includes("Mac") ? "is-mac" : ""} ${navigator.platform?.includes("Win") ? "is-win" : ""} ${chatFocus ? "cryoclaw-shell--focus" : ""} ${sidebarCollapsed ? "cryoclaw-shell--sidebar-collapsed" : ""} ${meta.fullpage ? "cryoclaw-shell--fullpage" : ""}"
    >
      ${chatFocus || sidebarCollapsed || meta.fullpage
        ? nothing
        : html`<cc-sidebar .props=${{
            connected: state.connected,
            currentSessionKey,
            mainSessionKey: resolveMainSessionKey(state.hello, state.sessionsResult),
            sessionOptions,
            sessionSearch: state.sidebarSessionSearch ?? "",
            showArchived: state.sessionsIncludeArchived === true,
            onSessionSearchChange: (value: string) => {
              state.sidebarSessionSearch = value;
              state.requestUpdate();
            },
            onToggleArchived: () => {
              state.sessionsIncludeArchived = !state.sessionsIncludeArchived;
              state.requestUpdate();
              // 内核 archived=true 仅返回已归档 → 需要重拉列表
              void loadSessions(state as unknown as Parameters<typeof loadSessions>[0]);
            },
            settingsActive: cryoclawView === "settings",
            extensionsActive: cryoclawView === "extensions",
            workspaceActive: cryoclawView === "workspace",
            tasksActive: cryoclawView === "tasks",
            tasksRunningCount: state.tasks.filter((task) => isActiveTask(task)).length,
            onOpenTasks: () => openTasksView(state),
            // git 不可用时「更多」菜单的 worktree 新建入口降级隐藏（false=已探测无 git）
            gitAvailable: state.gitAvailable,
            onNewWorktreeChat: () => void createNewWorktreeSession(state),
            webbridgeRepairVisible: state.webbridgeRepairVisible,
            webbridgeRepairBrowserName: state.webbridgeRepairBrowserName,
            webbridgeRepairChecking: state.webbridgeRepairChecking,
            onWebbridgeRepairClick: () => {
              void state.onWebbridgeRepairClick();
            },
            onSelectSession: (nextSessionKey: string) => handleSessionChange(state, nextSessionKey),
            onNewChat: () => createNewSession(state),
            onRenameSession: (key: string, newLabel: string) => {
              void patchSessionFromSidebar(state, key, newLabel);
            },
            onDeleteSession: (key: string) => {
              void deleteSessionFromSidebar(state, key);
            },
            onTogglePin: (key: string, pinned: boolean) => {
              void patchSession(state as unknown as Parameters<typeof patchSession>[0], key, { pinned });
            },
            onToggleUnread: (key: string, unread: boolean) => {
              void patchSession(state as unknown as Parameters<typeof patchSession>[0], key, { unread });
            },
            onSetArchived: (key: string, archived: boolean) => {
              void patchSession(state as unknown as Parameters<typeof patchSession>[0], key, { archived });
            },
            isDeletingSession: (key: string) => isDeletingSession(key),
            requestUpdate: () => state.requestUpdate(),
            onToggleSidebar: () => {
              state.applySettings({
                ...state.settings,
                navCollapsed: !state.settings.navCollapsed,
              });
            },
            settingsBadge: !localStorage.getItem("cryoclaw:weixin-badge-seen"),
            // App 更新角标：有待装/下载中更新时常驻，状态复位后消失
            settingsUpdateBadge: state.appUpdateBadge,
            onOpenSettings: () => {
              localStorage.setItem("cryoclaw:weixin-badge-seen", "1");
              openSettingsView(state, null);
            },
            onOpenExtensions: () => openExtensionsView(state),
            onOpenWorkspace: () => openWorkspaceView(state),
            onOpenWebUI: () => void handleOpenWebUI(state),
            errors: [chatDisabledReason, state.lastError].filter(Boolean) as string[],
            onReconnect: () => handleReconnect(state),
          }}></cc-sidebar>`}

      <div class="cryoclaw-main">
        <div class="cryoclaw-titlebar">
          ${
            !meta.fullpage
              ? sidebarCollapsed && !chatFocus
                ? html`
                    <div class="cryoclaw-floating-actions">
                      <button
                        class="cryoclaw-floating-btn"
                        type="button"
                        @click=${() => {
                          state.applySettings({
                            ...state.settings,
                            navCollapsed: false,
                          });
                        }}
                        data-tooltip=${t("sidebar.expand")}
                        data-tooltip-pos="bottom"
                        aria-label=${t("sidebar.expand")}
                      >
                        ${icons.panelLeft}
                      </button>
                      <button
                        class="cryoclaw-floating-btn"
                        type="button"
                        @click=${() => createNewSession(state)}
                        data-tooltip=${t("sidebar.newChat")}
                        data-tooltip-pos="bottom"
                        aria-label=${t("sidebar.newChat")}
                      >
                        ${icons.messagePlus}
                      </button>
                    </div>
                  `
                : nothing
              : meta.titlebarBack
                ? html`
                    <div class="cryoclaw-floating-actions">
                      <button
                        class="cryoclaw-floating-btn"
                        type="button"
                        @click=${() => setCryoClawView(state, "chat")}
                        data-tooltip=${t("sidebar.backToChat")}
                        data-tooltip-pos="bottom"
                        aria-label=${t("sidebar.backToChat")}
                      >
                        ${icons.arrowLeft}
                      </button>
                    </div>
                  `
                : nothing
          }
        </div>

        <main class="cryoclaw-content">
          ${renderActiveView(state, cryoclawView)}
        </main>
      </div>

      ${renderGatewayUrlConfirmation(state)}
      ${renderRestartGatewayDialog(state)}
      ${renderConfirmDialog(state)}
      ${renderSharePrompt(state)}
      ${renderReleaseNotesModal(state)}
      ${renderWebbridgePillModal(state)}
      ${getToastMessage()
        ? html`<div class="global-toast ${getToastAction() ? "global-toast--action" : ""}">
            <span>${getToastMessage()}</span>
            ${getToastAction()
              ? html`<button
                  class="global-toast__action"
                  type="button"
                  @click=${() => {
                    const action = getToastAction();
                    hideToast(state);
                    action?.onClick();
                  }}
                >
                  ${getToastAction()?.label}
                </button>`
              : nothing}
          </div>`
        : nothing}
    </div>
  `;
}
