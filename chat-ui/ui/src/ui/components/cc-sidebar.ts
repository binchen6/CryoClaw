import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement } from "lit/decorators.js";
import { t } from "../i18n.ts";
import { icons } from "../icons.ts";
import { groupSidebarSessions } from "../sidebar-grouping.ts";

// CryoClaw sidebar 独立组件（R41 Task 12；R42 第二期 T4 图标轨重组）。
// 取代上游 13-tab 导航的紧凑聊天侧边栏：品牌区 + 新会话/「更多」菜单 + 会话列表（分组/
// 搜索/归档/「⋯」管理菜单/内联重命名）+ 底部 5 图标轨（任务/工作区/扩展/完整版网页或重连/设置）。
//
// 为什么抽组件：此前侧边栏模板直接写在 renderApp 里，chatStream 流式帧等任何
// 根组件高频更新都会让整棵侧边栏模板树重求值。抽出后：只有数据字段真正变化
// （会话列表、视图切换、徽标、连接态等）才重求值，流式帧不再命中。
//
// 契约：
// - 全部业务状态仍归 OpenClawApp（app-*.ts 模块不动），本组件只接单属性
//   props（SidebarProps 整体传入，字段集不变）、无自有业务状态；
// - SidebarProps 40+ 字段，回调每帧新闭包（renderApp 字面量构造），不得进
//   shouldUpdate 比较清单，否则每次根渲染都重求值、隔离失效。事件触发经
//   this.props 拿最新对象，闭包自然新鲜；
// - 会话「⋯」菜单开关态（sessionMenuKey 等）为组件文件模块级状态：此前靠
//   根 requestUpdate 连带重求值驱动，组件化后改走组件自身更新（bump）。
//
// 第二期（R42 T4）：主导航 6 项收敛为底部 5 图标轨，「Worktree 新会话」移入「更多」菜单。
//
// 无 shadow DOM：全局样式（styles/sidebar.css）与会话菜单的 document 级
// querySelector 测量/外部关闭都依赖扁平 DOM。
@customElement("cc-sidebar")
export class CcSidebar extends LitElement {
  static properties = {
    props: { attribute: false },
  };

  props: SidebarProps | null = null;

  // 无 shadow DOM：复用全局样式与 document 级会话菜单测量/外部关闭（扁平 DOM）
  createRenderRoot() {
    return this;
  }

  // 组件级更新纪元：会话菜单开关不改 props 数据，此前靠根渲染连带重求值，
  // 组件化后由 bump() 递增纪元并触发本组件更新。若组件更新与根更新（流式帧）
  // 同批合流，shouldUpdate 只看到 changed 里的 props，必须靠纪元差兜底，
  // 否则菜单开/关会被数据比较吞掉。
  private internalEpoch = 0;
  private renderedEpoch = 0;
  // 上一轮渲染时的「正在删除的会话」签名：删除行 spinner 状态存在
  // app-session-actions 模块 Set 里、由 state.requestUpdate() 驱动，数据字段
  // 全都不变——不参与比较 spinner 永远出不来。
  private deletingSigCache = "";

  // 箭头函数保持 this；暴露给类外的模板辅助函数（菜单开/关）作为刷新触发器，故不用 private。
  bump = (): void => {
    this.internalEpoch++;
    this.requestUpdate();
  };

  shouldUpdate(changed: Map<PropertyKey, unknown>): boolean {
    // 组件级触发的更新（菜单开关等）优先放行
    if (this.internalEpoch !== this.renderedEpoch) return true;
    if (!changed.has("props")) return false;
    const prev = changed.get("props") as SidebarProps | null | undefined;
    const next = this.props;
    if (!prev || !next) return true;
    // 布尔/数字/字符串按值，数组按引用比较。例外两处（都是根渲染每次构造的
    // 新字面量，按引用比较会恒真、隔离失效）：
    // - sessionOptions：由装配层按数据源 memo（app-render.ts），引用稳定；
    // - errors：按内容比较（见 errorsEqual）。
    let changedFlag = false;
    for (const name of DATA_FIELDS) {
      if (name === "errors") continue;
      if (prev[name] !== next[name]) {
        changedFlag = true;
        break;
      }
    }
    if (!changedFlag) changedFlag = !errorsEqual(prev.errors, next.errors);
    // 删除中签名：会话集合引用不变时单独探测（数据字段此时必然相等，
    // 逐个查询开销与原渲染内调用 isDeletingSession 同量级）
    if (!changedFlag && prev.sessionOptions === next.sessionOptions) {
      changedFlag = this.deletingSignature(next) !== this.deletingSigCache;
    }
    return changedFlag;
  }

  updated() {
    // 渲染成功后同步纪元与删除签名，保证下一轮比较基线新鲜
    this.renderedEpoch = this.internalEpoch;
    if (this.props) this.deletingSigCache = this.deletingSignature(this.props);
  }

  private deletingSignature(props: SidebarProps): string {
    let sig = "";
    for (const o of props.sessionOptions) {
      if (props.isDeletingSession(o.key)) sig += `${o.key}|`;
    }
    return sig;
  }

  render() {
    const props = this.props;
    if (!props) return nothing;
    return renderSidebarInner(this, props);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    resetMenuState();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cc-sidebar": CcSidebar;
  }
}

export type SidebarSessionOption = {
  key: string;
  label: string;
  updatedAt?: number;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  // 会话持有的活跃 worktree 分支名（由 worktrees.list 的 ownerId 反推，见 app-session-actions）
  worktreeBranch?: string;
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
  extensionsActive: boolean;
  workspaceActive: boolean;
  // git 可用性：「更多」菜单整体按 gitAvailable === true 渲染（唯一菜单项是 Worktree 新会话，
  // 无 git 时按钮即空菜单，直接隐藏；false = 已探测无 git）
  gitAvailable: boolean | null;
  onNewWorktreeChat: () => void;
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
  onOpenExtensions: () => void;
  onOpenWorkspace: () => void;
  onOpenWebUI: () => void;
  errors: string[];
  onReconnect: () => void;
};

// shouldUpdate 数据字段比较清单：布尔/数字/字符串按值、数组按引用（见 shouldUpdate 注释）。
// 全部回调（on* / isDeletingSession / requestUpdate）一律排除——每帧新闭包，
// 引用比较恒变会让隔离彻底失效。
const DATA_FIELDS = [
  "connected",
  "currentSessionKey",
  "mainSessionKey",
  "sessionOptions",
  "sessionSearch",
  "showArchived",
  "settingsActive",
  "tasksActive",
  "tasksRunningCount",
  "extensionsActive",
  "workspaceActive",
  "gitAvailable",
  "webbridgeRepairVisible",
  "webbridgeRepairBrowserName",
  "webbridgeRepairChecking",
  "settingsBadge",
  "settingsUpdateBadge",
  "errors",
] as const;

// errors 由装配层每次根渲染 [chatDisabledReason, lastError].filter 新建，
// 引用必变——按元素内容比较（至多两条）。
function errorsEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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
    // 模板实例仍持有 span 引用，恢复 DOM 后触发根组件重渲染，避免后续更新写入已脱离节点
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

// 会话项「⋯」菜单的本地状态（非响应式，渲染由组件更新驱动）。
// 与 chat 加号菜单同一模式：document 级点击外部关闭，关闭即注销监听。
let sessionMenuKey: string | null = null;
let sessionMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

// 菜单开/关只改模块态、不改 props 数据 → 触发组件自身更新（见 CcSidebar.bump）
function closeSessionMenu(requestUpdate: () => void) {
  sessionMenuKey = null;
  if (sessionMenuOutsideCloser) {
    document.removeEventListener("click", sessionMenuOutsideCloser);
    sessionMenuOutsideCloser = null;
  }
  requestUpdate();
}

function openSessionMenu(key: string, requestUpdate: () => void) {
  // 对称互斥：打开会话菜单先关「更多」菜单（两菜单同时开会互相屏蔽 outsideCloser）
  closeMoreMenu(requestUpdate);
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

// ── 「更多」菜单本地状态（与会话菜单同一模式：rAF 延迟注册外部关闭防自触，bump 驱动更新） ──
let moreMenuOpen = false;
let moreMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

function closeMoreMenu(requestUpdate: () => void) {
  moreMenuOpen = false;
  if (moreMenuOutsideCloser) {
    document.removeEventListener("click", moreMenuOutsideCloser);
    moreMenuOutsideCloser = null;
  }
  requestUpdate();
}

function toggleMoreMenu(host: CcSidebar) {
  if (moreMenuOpen) {
    closeMoreMenu(host.bump);
    return;
  }
  // 双菜单互斥：打开「更多」菜单先关会话菜单（两个按钮的 stopPropagation 会互相屏蔽 outsideCloser）
  closeSessionMenu(host.bump);
  moreMenuOpen = true;
  requestAnimationFrame(() => {
    if (!moreMenuOpen || moreMenuOutsideCloser) return;
    moreMenuOutsideCloser = (ev: MouseEvent) => {
      const root = (ev.target as HTMLElement).closest?.(".cryoclaw-sidebar__more-wrap");
      if (!root) closeMoreMenu(host.bump);
    };
    document.addEventListener("click", moreMenuOutsideCloser);
  });
  host.bump();
}

// 组件卸载清掉菜单模块态与 document 级监听（R41 审查建议顺手项）
function resetMenuState() {
  sessionMenuKey = null;
  moreMenuOpen = false;
  if (sessionMenuOutsideCloser) {
    document.removeEventListener("click", sessionMenuOutsideCloser);
    sessionMenuOutsideCloser = null;
  }
  if (moreMenuOutsideCloser) {
    document.removeEventListener("click", moreMenuOutsideCloser);
    moreMenuOutsideCloser = null;
  }
}

// ── 会话列表分组：实现见 sidebar-grouping.ts（置顶 + 时间分组，纯函数可测） ──

// 单个会话项（正常/归档/搜索/分组渲染共用）：名称行 + 「⋯」管理菜单
function renderSessionItem(host: CcSidebar, props: SidebarProps, s: SidebarSessionOption) {
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
      >${s.unread ? html`<span class="cryoclaw-sidebar__unread-dot" aria-label=${t("sidebar.unread")}></span>` : nothing}${s.label}${s.pinned ? html`<span class="cryoclaw-sidebar__session-pin" aria-label=${t("sidebar.pinned")}>${icons.pin}</span>` : nothing}${s.worktreeBranch ? html`<span class="cryoclaw-sidebar__session-worktree" title=${s.worktreeBranch}>${icons.gitBranch}${s.worktreeBranch}</span>` : nothing}</span>
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
              closeSessionMenu(host.bump);
            } else {
              openSessionMenu(s.key, host.bump);
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
                    @click=${() => { closeSessionMenu(host.bump); props.onTogglePin(s.key, !s.pinned); }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${s.pinned ? icons.pinActive : icons.pin}</span>
                    <span>${s.pinned ? t("sidebar.unpinSession") : t("sidebar.pinSession")}</span>
                  </button>
                  <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onToggleUnread(s.key, !s.unread); }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${s.unread ? icons.eye : icons.eyeOff}</span>
                    <span>${s.unread ? t("sidebar.markRead") : t("sidebar.markUnread")}</span>
                  </button>
                  <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                    @click=${(e: Event) => {
                      closeSessionMenu(host.bump);
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
                        @click=${() => { closeSessionMenu(host.bump); props.onSetArchived(s.key, true); }}>
                        <span class="cryoclaw-sidebar__session-menu-icon">${icons.archive}</span>
                        <span>${t("sidebar.archiveSession")}</span>
                      </button>
                      <button class="cryoclaw-sidebar__session-menu-item cryoclaw-sidebar__session-menu-item--danger" type="button" role="menuitem"
                        @click=${() => { closeSessionMenu(host.bump); props.onDeleteSession(s.key); }}>
                        <span class="cryoclaw-sidebar__session-menu-icon">${icons.trash}</span>
                        <span>${t("sidebar.delete")}</span>
                      </button>
                    `
                    : nothing}
                `
                : html`
                  <button class="cryoclaw-sidebar__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onSetArchived(s.key, false); }}>
                    <span class="cryoclaw-sidebar__session-menu-icon">${icons.archiveRestore}</span>
                    <span>${t("sidebar.restoreSession")}</span>
                  </button>
                  <button class="cryoclaw-sidebar__session-menu-item cryoclaw-sidebar__session-menu-item--danger" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onDeleteSession(s.key); }}>
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

// 侧边栏模板主体：品牌区 + 新会话/「更多」菜单 + 会话列表（原样）+ 底部图标轨。
// 会话「⋯」与「更多」菜单开/关的刷新均由组件级 bump 驱动（见 CcSidebar.bump）。
function renderSidebarInner(host: CcSidebar, props: SidebarProps) {
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
        <div class="cryoclaw-sidebar__top-actions">
          <button
            class="cryoclaw-sidebar__new-chat-btn"
            @click=${props.onNewChat}
          >
            ${icons.messagePlus} ${t("sidebar.newChat")}
          </button>
          ${props.gitAvailable === true
            ? html`<div class="cryoclaw-sidebar__more-wrap">
              <button
                class="cryoclaw-sidebar__more-btn ${moreMenuOpen ? "is-open" : ""}"
                type="button"
                aria-haspopup="menu"
                aria-expanded=${moreMenuOpen ? "true" : "false"}
                aria-label=${t("sidebar.more")}
                data-tooltip=${t("sidebar.more")}
                data-tooltip-pos="bottom"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  toggleMoreMenu(host);
                }}
              >${icons.moreHorizontal}</button>
              ${moreMenuOpen
                ? html`<div class="cryoclaw-sidebar__more-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
                    <button class="cryoclaw-sidebar__more-item" type="button" role="menuitem"
                      data-tooltip=${t("sidebar.newWorktreeChatHint")}
                      @click=${() => { closeMoreMenu(host.bump); props.onNewWorktreeChat(); }}>
                      ${icons.gitBranch} ${t("sidebar.newWorktreeChat")}
                    </button>
                  </div>`
                : nothing}
            </div>`
            : nothing}
        </div>

        <!-- 会话列表标题行（管理已合并：归档视图切换 + 搜索） -->
        <div class="cryoclaw-sidebar__session-header">
          <span class="cryoclaw-sidebar__section-title">${props.showArchived ? t("sidebar.archivedSessions") : t("sidebar.agent")}</span>
          <button
            class="cryoclaw-sidebar__session-add ${props.showArchived ? "active" : ""}"
            type="button"
            @click=${() => {
              closeSessionMenu(host.bump);
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
              repeat(props.sessionOptions, (s) => s.key, (s) => renderSessionItem(host, props, s))
            : // 正常视图：置顶 + 时间分组
              groupSidebarSessions(props.sessionOptions).map(
                (group) => html`
                  <div class="cryoclaw-sidebar__group-label">${t(group.labelKey)}</div>
                  ${repeat(group.items, (s) => s.key, (s) => renderSessionItem(host, props, s))}
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
        <div class="cryoclaw-sidebar__rail">
          <button class="cryoclaw-sidebar__rail-item ${props.tasksActive ? "active" : ""}" type="button"
            @click=${props.onOpenTasks}
            aria-current=${props.tasksActive ? "page" : nothing}
            data-tooltip=${t("sidebar.tasks")} data-tooltip-pos="top" aria-label=${t("sidebar.tasks")}>
            ${icons.activity}
            ${props.tasksRunningCount > 0
              ? html`<span class="cryoclaw-sidebar__rail-badge">${props.tasksRunningCount}</span>`
              : nothing}
          </button>
          <button class="cryoclaw-sidebar__rail-item ${props.workspaceActive ? "active" : ""}" type="button"
            @click=${props.onOpenWorkspace}
            aria-current=${props.workspaceActive ? "page" : nothing}
            data-tooltip=${t("sidebar.workspace")} data-tooltip-pos="top" aria-label=${t("sidebar.workspace")}>
            ${icons.folder}
          </button>
          <button class="cryoclaw-sidebar__rail-item ${props.extensionsActive ? "active" : ""}" type="button"
            @click=${props.onOpenExtensions}
            aria-current=${props.extensionsActive ? "page" : nothing}
            data-tooltip=${t("sidebar.extensions")} data-tooltip-pos="top" aria-label=${t("sidebar.extensions")}>
            ${icons.puzzle}
          </button>
          <span class="cryoclaw-sidebar__rail-spacer"></span>
          <span class="cryoclaw-sidebar__rail-error">
            ${props.connected
              ? html`<button class="cryoclaw-sidebar__rail-item" type="button"
                  @click=${props.onOpenWebUI}
                  data-tooltip=${t("sidebar.fullUI")} data-tooltip-pos="top" aria-label=${t("sidebar.fullUI")}>
                  ${icons.externalLink}
                  ${errors.badge}
                </button>`
              : html`<button class="cryoclaw-sidebar__rail-item cryoclaw-sidebar__rail-item--disconnected" type="button"
                  @click=${props.onReconnect}
                  data-tooltip=${t("sidebar.reconnect")} data-tooltip-pos="top" aria-label=${t("sidebar.reconnect")}>
                  ${refreshIcon}
                  ${errors.badge}
                </button>`}
            ${errors.popup}
          </span>
          <button class="cryoclaw-sidebar__rail-item ${props.settingsActive ? "active" : ""}" type="button"
            @click=${props.onOpenSettings}
            aria-current=${props.settingsActive ? "page" : nothing}
            data-tooltip=${props.settingsUpdateBadge ? t("sidebar.updateBadgeTooltip") : props.settingsBadge ? t("sidebar.weixinBadgeTooltip") : t("sidebar.settings")}
            data-tooltip-pos="top"
            aria-label=${props.settingsUpdateBadge ? t("sidebar.updateBadgeTooltip") : props.settingsBadge ? t("sidebar.weixinBadgeTooltip") : t("sidebar.settings")}>
            ${icons.settings}
            ${props.settingsBadge || props.settingsUpdateBadge
              ? html`<span class="cryoclaw-sidebar__rail-dot"></span>`
              : nothing}
          </button>
        </div>
      </div>
    </aside>
  `;
}
