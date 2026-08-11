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
import { renderCronView } from "./app-cron.ts";
import {
  createNewSession,
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
import { openSkillsView, renderSkillsView } from "./app-skills.ts";
import { openTasksView, renderTasksView } from "./app-tasks.ts";
import { getToastMessage } from "./app-toast.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { loadSessions, patchSession } from "./controllers/sessions.ts";
import { isActiveTask } from "./controllers/tasks.ts";
import { t } from "./i18n.ts";
import { icons } from "./icons.ts";
import { isExpiredOneShot } from "./presenter.ts";
import { resolveMainSessionKey } from "./session-visibility.ts";
import { renderSidebar } from "./sidebar.ts";
import { renderChat } from "./views/chat.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderReleaseNotesModal } from "./views/release-notes-modal.ts";
import { CRYOCLAW_VIEW_META, type CryoClawViewId } from "./views/registry.ts";
import { renderRestartGatewayDialog } from "./views/restart-gateway-dialog.ts";
import { renderConfirmDialog } from "./views/confirm-dialog.ts";
import { renderSettingsView } from "./views/settings/settings-view.ts";
import { renderSetupView } from "./views/setup/setup-view.ts";
import { renderSharePrompt } from "./views/share-prompt.ts";
import { initWorkspace, renderWorkspaceView } from "./views/workspace.ts";
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
      workspaceSetRoot?: (root: string) => Promise<any>;
      workspaceOpenFile?: (filePath: string) => Promise<any>;
      workspaceOpenFolder?: (filePath: string) => Promise<any>;
      workspaceListDir?: (dirPath: string) => Promise<any>;
      workspaceReadFile?: (filePath: string) => Promise<any>;
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

// 打开工作区文件浏览视图
function openWorkspaceView(state: AppViewState) {
  setCryoClawView(state, "workspace");
  void initWorkspace(state);
}

/** 内容区分发：按当前视图渲染对应视图（新增视图接线点之一，见 views/registry.ts） */
function renderActiveView(state: AppViewState, view: CryoClawViewId) {
  switch (view) {
    case "setup":
      return renderSetupView(state);
    case "settings":
      return renderSettingsView(state);
    case "skills":
      return renderSkillsView(state);
    case "workspace":
      return renderWorkspaceView(state, () => setCryoClawView(state, "chat"));
    case "cron":
      return renderCronView(state);
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
  const sessionOptions = resolveSessionOptions(state);
  const cryoclawView = state.settings.cryoclawView ?? "chat";
  const meta = CRYOCLAW_VIEW_META[cryoclawView];

  return html`
    <div
      class="cryoclaw-shell ${navigator.platform?.includes("Mac") ? "is-mac" : ""} ${navigator.platform?.includes("Win") ? "is-win" : ""} ${chatFocus ? "cryoclaw-shell--focus" : ""} ${sidebarCollapsed ? "cryoclaw-shell--sidebar-collapsed" : ""} ${meta.fullpage ? "cryoclaw-shell--fullpage" : ""}"
    >
      ${chatFocus || sidebarCollapsed || meta.fullpage
        ? nothing
        : renderSidebar({
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
            skillsActive: cryoclawView === "skills",
            workspaceActive: cryoclawView === "workspace",
            cronActive: cryoclawView === "cron",
            cronJobCount: state.cronJobs.filter((j) => !isExpiredOneShot(j)).length,
            onOpenCron: () => setCryoClawView(state, "cron"),
            tasksActive: cryoclawView === "tasks",
            tasksRunningCount: state.tasks.filter((task) => isActiveTask(task)).length,
            onOpenTasks: () => openTasksView(state),
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
            onOpenSettings: () => {
              localStorage.setItem("cryoclaw:weixin-badge-seen", "1");
              openSettingsView(state, null);
            },
            onOpenSkillStore: () => openSkillsView(state),
            onOpenWorkspace: () => openWorkspaceView(state),
            onOpenWebUI: () => void handleOpenWebUI(state),
            errors: [chatDisabledReason, state.lastError].filter(Boolean) as string[],
            onReconnect: () => handleReconnect(state),
          })}

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
        ? html`<div class="global-toast">${getToastMessage()}</div>`
        : nothing}
    </div>
  `;
}
