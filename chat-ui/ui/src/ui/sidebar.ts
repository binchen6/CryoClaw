/**
 * CryoClaw sidebar component.
 * Replaces the upstream 13-tab navigation with a compact chat sidebar.
 */
import { html } from "lit";
import { nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "./i18n.ts";
import { icons } from "./icons.ts";
import { groupSidebarSessions } from "./sidebar-grouping.ts";

export type SidebarSessionOption = {
  key: string;
  label: string;
  updatedAt?: number;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
};

export type SidebarProps = {
  connected: boolean;
  currentSessionKey: string;
  mainSessionKey: string | null;
  sessionOptions: SidebarSessionOption[];
  // 会话管理已合并进会话列表：搜索词（客户端过滤）+ 归档视图开关
  sessionSearch: string;
  showArchived: boolean;
  onSessionSearchChange: (value: string) => void;
  onToggleArchived: () => void;
  settingsActive: boolean;
  tasksActive: boolean;
  tasksRunningCount: number;
  onOpenTasks: () => void;
  skillsActive: boolean;
  workspaceActive: boolean;
  cronActive: boolean;
  cronJobCount: number;
  onOpenCron: () => void;
  // 当前 webbridge 模式但浏览器扩展未启用 → 显示「连接你的常用浏览器」pill
  // 用户在浏览器外部启用扩展 CryoClaw 拿不到事件，所以 pill 改成可点击：
  // 点一次重跑 needs-repair；扩展已启用就 pill 消失，否则保持显示
  // checking=true 时图标换成转圈 loader
  webbridgeRepairVisible: boolean;
  webbridgeRepairBrowserName: string | null;
  webbridgeRepairChecking: boolean;
  onWebbridgeRepairClick: () => void;
  onToggleSidebar: () => void;
  onSelectSession: (sessionKey: string) => void;
  onNewChat: () => void;
  onRenameSession: (key: string, newLabel: string) => void;
  onDeleteSession: (key: string) => void;
  // 会话项管理操作（原会话管理页能力）
  onTogglePin: (key: string, pinned: boolean) => void;
  onToggleUnread: (key: string, unread: boolean) => void;
  onSetArchived: (key: string, archived: boolean) => void;
  isDeletingSession: (key: string) => boolean;
  requestUpdate: () => void;
  settingsBadge: boolean;
  // App 更新待装/下载中角标（与 settingsBadge 微信徽标并列，互不影响）
  settingsUpdateBadge: boolean;
  onOpenSettings: () => void;
  onOpenSkillStore: () => void;
  onOpenWorkspace: () => void;
  onOpenWebUI: () => void;
  errors: string[];
  onReconnect: () => void;
};

// 双击会话名触发内联重命名：创建 input 替换 span，Enter 保存，Escape 取消。
// 注意：input 是手工 DOM、脱离 Lit 模板实例，结束后必须 requestUpdate 让模板重新接管渲染。
function startInlineRename(
  span: HTMLSpanElement,
  sessionKey: string,
  currentLabel: string,
  onRename: (key: string, newLabel: string) => void,
  requestUpdate: () => void,
) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cryoclaw-sidebar__session-edit";
  input.value = currentLabel;
  let saved = false;
  const finish = () => {
    input.replaceWith(span);
    // 模板实例仍持有 span 引用，恢复 DOM 后触发重渲染，避免后续更新写入已脱离节点
    requestUpdate();
  };
  const save = () => {
    if (saved) return;
    saved = true;
    const val = input.value.trim();
    if (val && val !== currentLabel) {
      onRename(sessionKey, val);
    }
    finish();
  };
  // 阻止点击冒泡到 session-item 的 @click，否则点输入框会触发切换会话
  input.addEventListener("click", (ev: MouseEvent) => ev.stopPropagation());
  input.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      save();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      saved = true;
      finish();
    }
  });
  input.addEventListener("blur", save);
  span.replaceWith(input);
  input.focus();
  input.select();
}

// 会话项「⋯」菜单的本地状态（非响应式，渲染由 requestUpdate 驱动）。
// 与 chat 加号菜单同一模式：document 级点击外部关闭，关闭即注销监听。
let sessionMenuKey: string | null = null;
let sessionMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

function closeSessionMenu(requestUpdate: () => void) {
  sessionMenuKey = null;
  if (sessionMenuOutsideCloser) {
    document.removeEventListener("click", sessionMenuOutsideCloser);
    sessionMenuOutsideCloser = null;
  }
  requestUpdate();
}

function openSessionMenu(key: string, requestUpdate: () => void) {
  sessionMenuKey = key;
  // 延迟一帧注册，避免触发本次打开的 click 立刻把菜单关掉。
  requestAnimationFrame(() => {
    if (sessionMenuKey !== key || sessionMenuOutsideCloser) return;
    sessionMenuOutsideCloser = (ev: MouseEvent) => {
      const root = (ev.target as HTMLElement).closest?.(".cryoclaw-sidebar__session-menu-wrap");
      if (!root) {
        closeSessionMenu(requestUpdate);
      }
    };
    document.addEventListener("click", sessionMenuOutsideCloser);
  });
  requestUpdate();
  // 渲染后测量：菜单距窗口底部不足时向上翻转展开（菜单只向下弹会在列表底部被裁）。
  // lit 更新在微任务完成，下一帧 DOM 已就位；取不到元素则跳过（保持默认向下）。
  requestAnimationFrame(() => {
    if (sessionMenuKey !== key) return;
    const menu = document.querySelector(".cryoclaw-sidebar__session-menu");
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      menu.classList.add("cryoclaw-sidebar__session-menu--up");
    }
  });
}

// ── 会话列表分组：实现见 sidebar-grouping.ts（置顶 + 时间分组，纯函数可测） ──

// 单个会话项（正常/归档/搜索/分组渲染共用）：名称行 + 「⋯」管理菜单
function renderSessionItem(props: SidebarProps, s: SidebarSessionOption) {
  const isActive = s.key === props.currentSessionKey;
  const isMain = props.mainSessionKey != null && s.key === props.mainSessionKey;
  const menuOpen = sessionMenuKey === s.key;
  const deleting = props.isDeletingSession(s.key);
  return html`
    <div
      class="cryoclaw-sidebar__session-item ${isActive ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${s.archived ? "is-archived" : ""}"
      @click=${() => props.onSelectSession(s.key)}
    >
      <span
        class="cryoclaw-sidebar__session-name"
        title=${s.label}
      >${s.unread ? html`<span class="cryoclaw-sidebar__unread-dot" aria-label=${t("sidebar.unread")}></span>` : nothing}${s.label}${s.pinned ? html`<span class="cryoclaw-sidebar__session-pin" aria-label=${t("sidebar.pinned")}>${icons.pin}</span>` : nothing}</span>
      <span class="cryoclaw-sidebar__session-menu-wrap">
        <button
          class="cryoclaw-sidebar__session-action ${menuOpen ? "is-open" : ""} ${deleting ? "is-loading" : ""}"
          type="button"
          aria-disabled=${deleting ? "true" : "false"}
          aria-busy=${deleting ? "true" : "false"}
          aria-haspopup="menu"
          aria-expanded=${menuOpen ? "true" : "false"}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (deleting) return;
            if (menuOpen) {
              closeSessionMenu(props.requestUpdate);
            } else {
              openSessionMenu(s.key, props.requestUpdate);
            }
          }}
          data-tooltip=${t("sidebar.sessionActions")}
          aria-label=${t("sidebar.sessionActions")}
        >
          ${deleting ? icons.loader : icons.moreHorizontal}
        </button>
        ${menuOpen
          ? html`
            <div class="cryoclaw-sidebar__session-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
              ${!s.archived
                ? html`
                  <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(props.requestUpdate); props.onTogglePin(s.key, !s.pinned); }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${s.pinned ? icons.pinActive : icons.pin}</span>
                    <span>${s.pinned ? t("sidebar.unpinSession") : t("sidebar.pinSession")}</span>
                  </button>
                  <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(props.requestUpdate); props.onToggleUnread(s.key, !s.unread); }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${s.unread ? icons.eye : icons.eyeOff}</span>
                    <span>${s.unread ? t("sidebar.markRead") : t("sidebar.markUnread")}</span>
                  </button>
                  <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                    @click=${(e: Event) => {
                      closeSessionMenu(props.requestUpdate);
                      const item = (e.currentTarget as HTMLElement).closest(".cryoclaw-sidebar__session-item")!;
                      const span = item.querySelector(".cryoclaw-sidebar__session-name") as HTMLSpanElement;
                      startInlineRename(span, s.key, s.label, props.onRenameSession, props.requestUpdate);
                    }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${icons.edit}</span>
                    <span>${t("sidebar.rename")}</span>
                  </button>
                  ${!isMain
                    ? html`
                      <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                        @click=${() => { closeSessionMenu(props.requestUpdate); props.onSetArchived(s.key, true); }}>
                        <span class="cryoclaw-sidebar__session-menu-icon">${icons.archive}</span>
                        <span>${t("sidebar.archiveSession")}</span>
                      </button>
                      <button class="cryoclaw-sidebar__session-menu-item cryoclaw-sidebar__session-menu-item--danger" type="button" role="menuitem"
                        @click=${() => { closeSessionMenu(props.requestUpdate); props.onDeleteSession(s.key); }}>
                        <span class="cryoclaw-sidebar__session-menu-icon">${icons.trash}</span>
                        <span>${t("sidebar.delete")}</span>
                      </button>
                    `
                    : nothing}
                `
                : html`
                  <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(props.requestUpdate); props.onSetArchived(s.key, false); }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${icons.archiveRestore}</span>
                    <span>${t("sidebar.restoreSession")}</span>
                  </button>
                  <button class="cryoclaw-sidebar__session-menu-item cryoclaw-sidebar__session-menu-item--danger" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(props.requestUpdate); props.onDeleteSession(s.key); }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${icons.trash}</span>
                    <span>${t("sidebar.delete")}</span>
                  </button>
                `}
            </div>
          `
          : nothing}
      </span>
    </div>
  `;
}

// 错误徽标（按钮内）+ 悬浮错误列表（按钮旁）：connected / disconnected 两分支共用
function renderErrors(props: SidebarProps) {
  if (props.errors.length === 0) {
    return { badge: nothing, popup: nothing };
  }
  return {
    badge: html`<span class="cryoclaw-sidebar__error-badge" title=${props.errors.join("\n")}>${props.errors.length}</span>`,
    popup: html`
      <div class="cryoclaw-sidebar__error-popup">
        ${props.errors.map((msg) => html`<div class="cryoclaw-sidebar__error-item">${msg}</div>`)}
      </div>`,
  };
}

export function renderSidebar(props: SidebarProps) {
  // 错误徽标 + 悬浮列表：两分支各引用一次，提前算好避免重复构建 TemplateResult
  const errors = renderErrors(props);
  // 刷新图标，断开连接时复用为重连按钮图标
  const refreshIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;

  return html`
    <aside class="cryoclaw-sidebar">
      <div class="cryoclaw-sidebar__brand">
        <div class="cryoclaw-sidebar__brand-main">
          <span class="cryoclaw-sidebar__title">${t("sidebar.brand")}</span>
          <span class="cryoclaw-sidebar__brand-sub">pure harness</span>
        </div>
        <button
          class="cryoclaw-sidebar__collapse"
          type="button"
          @click=${props.onToggleSidebar}
          data-tooltip=${t("sidebar.collapse")}
          data-tooltip-pos="bottom"
          aria-label=${t("sidebar.collapse")}
        >
          ${icons.panelLeft}
        </button>
      </div>

      <nav class="cryoclaw-sidebar__nav">
        <!-- Prominent New Chat Button -->
        <div style="padding: 12px 14px 16px;">
          <button
            class="cryoclaw-sidebar__new-chat-btn"
            @click=${props.onNewChat}
          >
            ${icons.messagePlus} ${t("sidebar.newChat")}
          </button>
        </div>

        <!-- 主导航：任务 / 定时 / 技能 / 工作区（徽标实时反映运行态） -->
        <div class="cryoclaw-sidebar__main-nav">
          <button
            class="cryoclaw-sidebar__item ${props.tasksActive ? "active" : ""}"
            type="button"
            @click=${props.onOpenTasks}
          >
            <span class="cryoclaw-sidebar__icon">${icons.activity}</span>
            <span class="cryoclaw-sidebar__label">${t("sidebar.tasks")}</span>
            ${props.tasksRunningCount > 0
              ? html`<span class="cryoclaw-sidebar__badge cryoclaw-sidebar__badge--running">${props.tasksRunningCount}</span>`
              : nothing}
          </button>
          <button
            class="cryoclaw-sidebar__item ${props.cronActive ? "active" : ""}"
            type="button"
            @click=${props.onOpenCron}
          >
            <span class="cryoclaw-sidebar__icon">${icons.clock}</span>
            <span class="cryoclaw-sidebar__label">${t("sidebar.cron")}</span>
            ${props.cronJobCount > 0
              ? html`<span class="cryoclaw-sidebar__badge">${props.cronJobCount}</span>`
              : nothing}
          </button>
          <button
            class="cryoclaw-sidebar__item ${props.skillsActive ? "active" : ""}"
            type="button"
            @click=${props.onOpenSkillStore}
          >
            <span class="cryoclaw-sidebar__icon">${icons.puzzle}</span>
            <span class="cryoclaw-sidebar__label">${t("sidebar.skillStore")}</span>
          </button>
          <button
            class="cryoclaw-sidebar__item ${props.workspaceActive ? "active" : ""}"
            type="button"
            @click=${props.onOpenWorkspace}
          >
            <span class="cryoclaw-sidebar__icon">${icons.folder}</span>
            <span class="cryoclaw-sidebar__label">${t("sidebar.workspace")}</span>
          </button>
        </div>

        <!-- 会话列表标题行（管理已合并：归档视图切换 + 搜索） -->
        <div class="cryoclaw-sidebar__session-header">
          <span class="cryoclaw-sidebar__section-title">${props.showArchived ? t("sidebar.archivedSessions") : t("sidebar.agent")}</span>
          <button
            class="cryoclaw-sidebar__session-add ${props.showArchived ? "active" : ""}"
            type="button"
            @click=${() => {
              closeSessionMenu(props.requestUpdate);
              props.onToggleArchived();
            }}
            data-tooltip=${props.showArchived ? t("sidebar.backToSessions") : t("sidebar.showArchived")}
            aria-label=${props.showArchived ? t("sidebar.backToSessions") : t("sidebar.showArchived")}
          >
            ${icons.archive}
          </button>
        </div>

        <!-- 会话搜索（客户端过滤，正常/归档视图通用） -->
        <div class="cryoclaw-sidebar__session-search">
          <input
            class="cryoclaw-sidebar__session-search-input"
            type="search"
            .value=${props.sessionSearch}
            placeholder=${t("sidebar.searchSessions")}
            aria-label=${t("sidebar.searchSessions")}
            @input=${(e: Event) => props.onSessionSearchChange((e.target as HTMLInputElement).value)}
          />
        </div>

        <!-- 会话列表 -->
        <div class="cryoclaw-sidebar__session-list">
          ${props.sessionOptions.length === 0
            ? html`<div class="cryoclaw-sidebar__session-empty">${props.showArchived ? t("sidebar.noArchivedSessions") : t("sidebar.noSessions")}</div>`
            : nothing}
          ${props.showArchived || props.sessionSearch.trim()
            ? // 归档视图 / 搜索态：平铺列表，便于扫读
              repeat(props.sessionOptions, (s) => s.key, (s) => renderSessionItem(props, s))
            : // 正常视图：置顶 + 时间分组
              groupSidebarSessions(props.sessionOptions).map(
                (group) => html`
                  <div class="cryoclaw-sidebar__group-label">${t(group.labelKey)}</div>
                  ${repeat(group.items, (s) => s.key, (s) => renderSessionItem(props, s))}
                `,
              )}
        </div>
      </nav>

      <div class="cryoclaw-sidebar__footer">
        ${props.webbridgeRepairVisible
          ? (() => {
              // 不挂 tooltip——点击 pill 弹 modal 已经承担提示职责，避免 hover + click 双重提示
              const checking = props.webbridgeRepairChecking;
              return html`
                <button
                  class="cryoclaw-sidebar__item cryoclaw-sidebar__item--webbridge-repair ${checking ? "is-checking" : ""}"
                  type="button"
                  @click=${props.onWebbridgeRepairClick}
                >
                  <span class="cryoclaw-sidebar__icon">
                    ${checking ? icons.loader : icons.wrench}
                  </span>
                  <span class="cryoclaw-sidebar__label">${t("sidebar.webbridgeRepairNeeded")}</span>
                </button>
              `;
            })()
          : nothing}
        <div class="cryoclaw-sidebar__group-label">${t("sidebar.groupCommon")}</div>
        <button
          class="cryoclaw-sidebar__item cryoclaw-sidebar__item--settings ${props.settingsActive
            ? "active"
            : ""}"
          type="button"
          @click=${props.onOpenSettings}
        >
          <span class="cryoclaw-sidebar__icon">${icons.settings}</span>
          <span class="cryoclaw-sidebar__label">${t("sidebar.settings")}</span>
          ${props.settingsBadge
            ? html`<span class="cryoclaw-sidebar__badge cryoclaw-sidebar__badge--new">${t("sidebar.weixinBadge")}</span>`
            : nothing}
          ${props.settingsUpdateBadge
            ? html`<span class="cryoclaw-sidebar__badge cryoclaw-sidebar__badge--new">${t("sidebar.updateBadge")}</span>`
            : nothing}
        </button>

        ${props.connected
          ? html`
            <div class="cryoclaw-sidebar__reconnect-wrap">
              <button
                class="cryoclaw-sidebar__item"
                type="button"
                @click=${props.onOpenWebUI}
              >
                <span class="cryoclaw-sidebar__icon">${icons.externalLink}</span>
                <span class="cryoclaw-sidebar__label">${t("sidebar.fullUI")}</span>
                ${errors.badge}
              </button>
              ${errors.popup}
            </div>`
          : html`
            <div class="cryoclaw-sidebar__reconnect-wrap">
              <button
                class="cryoclaw-sidebar__item cryoclaw-sidebar__item--disconnected"
                type="button"
                @click=${props.onReconnect}
              >
                <span class="cryoclaw-sidebar__icon">${refreshIcon}</span>
                <span class="cryoclaw-sidebar__label">${t("sidebar.reconnect")}</span>
                ${errors.badge}
              </button>
              ${errors.popup}
            </div>`
        }
      </div>
    </aside>
  `;
}
