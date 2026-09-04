/**
 * CryoClaw custom app-render.ts
 * Replaces the upstream 13-tab dashboard with the CryoClaw shell.
 *
 * 2026.9 提案 A 重写：壳层 = cc-rail 图标轨（常驻）+ cc-session-panel 会话面板
 * （仅 chat 视图，可折叠/可拖宽）+ 上下文栏（.cryoclaw-titlebar 44px：面板开关 +
 * 视图/会话标题）+ 内容区。各视图的渲染与逻辑在 app-chat-props / app-skills /
 * app-cron / app-tasks / app-session-actions / app-view-switch / app-toast；
 * 视图清单见 views/registry.ts（新增视图接线点共 3 处，见其文件头）。
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
// 图标轨 / 会话面板独立组件：流式帧等根组件高频更新不再重求值这两棵模板树
// （props 数据字段比较 + 组件级 bump 纪元，见各自文件头契约）
import "./components/cc-rail.ts";
import "./components/cc-session-panel.ts";
import { renderChat } from "./views/chat.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderReleaseNotesModal } from "./views/release-notes-modal.ts";
import { renderUpdateAvailableDialog } from "./views/update-available-dialog.ts";
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

// 会话面板右缘拖拽调宽：mousemove 高频期直写 DOM 宽度，松手才持久化。
// buttons === 0 补偿：窗口外释放鼠标时 mouseup 不派发（同 resizable-divider 模式）。
const PANEL_WIDTH_MIN = 220;
const PANEL_WIDTH_MAX = 420;

function clampPanelWidth(w: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(w)));
}

// 持久宽度同步到 :root：fixed 定位元素用 var(--panel-width) 读宽，
// 宿主内联 style 不反映给它们。带守卫只写变更，流式帧不重复写。
// 0 哨兵（未自定义）：移除 :root 内联值（防御残留），让 CSS 默认值生效。
let syncedPanelWidth = -1;
function syncPanelWidthVar(w: number) {
  if (w === syncedPanelWidth) return;
  syncedPanelWidth = w;
  if (w > 0) {
    document.documentElement.style.setProperty("--panel-width", `${w}px`);
  } else {
    document.documentElement.style.removeProperty("--panel-width");
  }
}

function startPanelResize(e: MouseEvent, state: AppViewState) {
  e.preventDefault();
  const startX = e.clientX;
  // 起始宽度用实测值：未自定义（0 哨兵）时以 CSS 默认宽度为基准。
  const hostEl = document.querySelector("cc-session-panel") as HTMLElement | null;
  const startW =
    state.settings.sidebarWidth > 0
      ? state.settings.sidebarWidth
      : Math.round(hostEl?.getBoundingClientRect().width ?? 0) || PANEL_WIDTH_MIN;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  let moved = false;
  const onMove = (ev: MouseEvent) => {
    if (ev.buttons === 0) {
      onUp();
      return;
    }
    moved = true;
    const host = document.querySelector("cc-session-panel") as HTMLElement | null;
    if (host) host.style.width = `${clampPanelWidth(startW + (ev.clientX - startX))}px`;
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // 零位移按压不固化宽度：保住 0 哨兵
    if (!moved) return;
    const host = document.querySelector("cc-session-panel") as HTMLElement | null;
    const w = host
      ? clampPanelWidth(host.getBoundingClientRect().width)
      : clampPanelWidth(startW);
    state.applySettings({ ...state.settings, sidebarWidth: w });
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// sessionOptions 由装配层 memo：数据源（sessionsResult/worktrees/sessionKey 等）
// 不变时引用稳定，<cc-session-panel> 的 shouldUpdate 按引用比较才有效。
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

/** 上下文栏（标题栏 44px 区域）：chat 显示会话名，其余视图显示视图标题 */
function renderContextBar(
  state: AppViewState,
  view: CryoClawViewId,
  panelCollapsed: boolean,
  currentSessionLabel: string | null,
) {
  const isChat = view === "chat";
  return html`
    <div class="cc-contextbar">
      ${isChat
        ? html`
            <button
              class="cc-contextbar__toggle"
              type="button"
              @click=${() => {
                state.applySettings({
                  ...state.settings,
                  navCollapsed: !state.settings.navCollapsed,
                });
              }}
              data-tooltip=${panelCollapsed ? t("panel.expand") : t("panel.collapse")}
              data-tooltip-pos="bottom"
              aria-label=${panelCollapsed ? t("panel.expand") : t("panel.collapse")}
            >
              ${icons.panelLeft}
            </button>
          `
        : nothing}
      <span class="cc-contextbar__title">
        ${isChat ? (currentSessionLabel ?? t("sidebar.newChat")) : t(CRYOCLAW_VIEW_META[view].titleKey)}
      </span>
    </div>
  `;
}

export function renderApp(state: AppViewState) {
  ensureFileDropBridge(state);
  updateFileDropState(state);
  syncPanelWidthVar(state.settings.sidebarWidth);
  const chatDisabledReason = state.connected ? null : t("error.disconnected");
  const chatFocus = state.onboarding;
  const panelCollapsed = !state.onboarding && state.settings.navCollapsed;
  const currentSessionKey = state.sessionKey;
  const sessionOptions = resolveSessionOptionsMemo(state);
  const cryoclawView = state.settings.cryoclawView ?? "chat";
  const meta = CRYOCLAW_VIEW_META[cryoclawView];
  const currentSessionLabel =
    sessionOptions.find((o) => o.key === currentSessionKey)?.label ?? null;

  return html`
    <div
      class="cryoclaw-shell ${navigator.platform?.includes("Mac") ? "is-mac" : ""} ${navigator.platform?.includes("Win") ? "is-win" : ""} ${chatFocus ? "cryoclaw-shell--focus" : ""} ${panelCollapsed ? "cryoclaw-shell--panel-collapsed" : ""} ${meta.fullpage ? "cryoclaw-shell--fullpage" : ""}"
    >
      ${chatFocus || meta.fullpage
        ? nothing
        : html`<cc-rail
            .props=${{
              activeView: cryoclawView,
              tasksRunningCount: state.tasks.filter((task) => isActiveTask(task)).length,
              connected: state.connected,
              errors: [chatDisabledReason, state.lastError].filter(Boolean) as string[],
              webbridgeRepairVisible: state.webbridgeRepairVisible,
              webbridgeRepairChecking: state.webbridgeRepairChecking,
              onWebbridgeRepairClick: () => {
                void state.onWebbridgeRepairClick();
              },
              settingsBadge: !localStorage.getItem("cryoclaw:weixin-badge-seen"),
              // App 更新角标：有待装/下载中更新时常驻，状态复位后消失
              settingsUpdateBadge: state.appUpdateBadge,
              onOpenChat: () => setCryoClawView(state, "chat"),
              onOpenTasks: () => openTasksView(state),
              onOpenWorkspace: () => openWorkspaceView(state),
              onOpenExtensions: () => openExtensionsView(state),
              onOpenSettings: () => {
                localStorage.setItem("cryoclaw:weixin-badge-seen", "1");
                openSettingsView(state, null);
              },
              onOpenWebUI: () => void handleOpenWebUI(state),
              onReconnect: () => handleReconnect(state),
            }}></cc-rail>`}
      ${chatFocus || meta.fullpage || cryoclawView !== "chat" || panelCollapsed
        ? nothing
        : html`<cc-session-panel
            style=${state.settings.sidebarWidth > 0 ? `width: ${state.settings.sidebarWidth}px` : nothing}
            .props=${{
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
              // git 不可用时「更多」菜单的 worktree 新建入口降级隐藏
              gitAvailable: state.gitAvailable,
              onNewWorktreeChat: () => void createNewWorktreeSession(state),
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
            }}></cc-session-panel>
          <div
            class="cryoclaw-panel-resize"
            @mousedown=${(e: MouseEvent) => startPanelResize(e, state)}
            aria-hidden="true"
          ></div>`}

      <div class="cryoclaw-main">
        <div class="cryoclaw-titlebar">
          ${chatFocus || meta.fullpage
            ? nothing
            : renderContextBar(state, cryoclawView, panelCollapsed, currentSessionLabel)}
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
      ${renderUpdateAvailableDialog(state)}
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
