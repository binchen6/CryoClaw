import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement } from "lit/decorators.js";
import { t } from "../i18n.ts";
import { icons } from "../icons.ts";
import { groupSidebarSessions } from "../sidebar-grouping.ts";

// CryoClaw 会话面板组件（2026.9 提案 A 重写，前身 cc-sidebar）。
// 旧 280px 侧边栏（品牌区+会话列表+底部图标轨）拆分：导航与状态入口迁往
// cc-rail 图标轨，本组件只保留 chat 视图内的会话面板——
// 面板头（新会话/「更多」菜单）、会话列表标题行（归档切换）、搜索、
// 会话列表（置顶+时间分组/「⋯」管理菜单/内联重命名）。
//
// 为什么抽组件：根组件高频更新（流式帧）不应重求值整棵面板模板树。
//
// 契约：
// - 全部业务状态仍归 OpenClawApp（app-*.ts 模块不动），本组件只接单属性
//   props（SessionPanelProps 整体传入）、无自有业务状态；
// - 回调每帧新闭包（renderApp 字面量构造），不得进 shouldUpdate 比较清单；
// - 会话「⋯」菜单与「更多」菜单开关态为模块级状态，由 bump() 驱动组件更新；
// - 无 shadow DOM：全局样式（styles/session-panel.css）与 document 级菜单
//   测量/外部关闭依赖扁平 DOM。
@customElement("cc-session-panel")
export class CcSessionPanel extends LitElement {
  static properties = {
    props: { attribute: false },
  };

  props: SessionPanelProps | null = null;

  createRenderRoot() {
    return this;
  }

  // 组件级更新纪元：菜单开关不改 props 数据，由 bump() 递增纪元触发更新。
  private internalEpoch = 0;
  private renderedEpoch = 0;
  // 上一轮渲染时的「正在删除的会话」签名：spinner 状态存在 app-session-actions
  // 模块 Set 里，数据字段全都不变——不参与比较 spinner 永远出不来。
  private deletingSigCache = "";

  bump = (): void => {
    this.internalEpoch++;
    this.requestUpdate();
  };

  shouldUpdate(changed: Map<PropertyKey, unknown>): boolean {
    if (this.internalEpoch !== this.renderedEpoch) return true;
    if (!changed.has("props")) return false;
    const prev = changed.get("props") as SessionPanelProps | null | undefined;
    const next = this.props;
    if (!prev || !next) return true;
    // 布尔/数字/字符串按值，数组按引用比较。例外：sessionOptions 由装配层
    // memo（app-render.ts），引用稳定。
    let changedFlag = false;
    for (const name of DATA_FIELDS) {
      if (prev[name] !== next[name]) {
        changedFlag = true;
        break;
      }
    }
    if (!changedFlag && prev.sessionOptions === next.sessionOptions) {
      changedFlag = this.deletingSignature(next) !== this.deletingSigCache;
    }
    return changedFlag;
  }

  updated() {
    this.renderedEpoch = this.internalEpoch;
    if (this.props) this.deletingSigCache = this.deletingSignature(this.props);
  }

  private deletingSignature(props: SessionPanelProps): string {
    let sig = "";
    for (const o of props.sessionOptions) {
      if (props.isDeletingSession(o.key)) sig += `${o.key}|`;
    }
    return sig;
  }

  render() {
    const props = this.props;
    if (!props) return nothing;
    return renderPanelInner(this, props);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    resetMenuState();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cc-session-panel": CcSessionPanel;
  }
}

export type SessionPanelSessionOption = {
  key: string;
  label: string;
  updatedAt?: number;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  // 会话持有的活跃 worktree 分支名（由 worktrees.list 的 ownerId 反推，见 app-session-actions）
  worktreeBranch?: string;
};

export type SessionPanelProps = {
  currentSessionKey: string;
  mainSessionKey: string | null;
  sessionOptions: SessionPanelSessionOption[];
  // 会话管理已合并进会话列表：搜索词（客户端过滤）+ 归档视图开关
  sessionSearch: string;
  showArchived: boolean;
  onSessionSearchChange: (value: string) => void;
  onToggleArchived: () => void;
  // git 可用性：「更多」菜单整体按 gitAvailable === true 渲染（唯一菜单项是
  // Worktree 新会话，无 git 时按钮即空菜单，直接隐藏；false = 已探测无 git）
  gitAvailable: boolean | null;
  onNewWorktreeChat: () => void;
  onSelectSession: (sessionKey: string) => void;
  onNewChat: () => void;
  onRenameSession: (key: string, newLabel: string) => void;
  onDeleteSession: (key: string) => void;
  onTogglePin: (key: string, pinned: boolean) => void;
  onToggleUnread: (key: string, unread: boolean) => void;
  onSetArchived: (key: string, archived: boolean) => void;
  isDeletingSession: (key: string) => boolean;
  requestUpdate: () => void;
};

// shouldUpdate 数据字段比较清单：布尔/数字/字符串按值、数组按引用。
// 全部回调一律排除（每帧新闭包，引用比较恒变会让隔离失效）。
const DATA_FIELDS = [
  "currentSessionKey",
  "mainSessionKey",
  "sessionOptions",
  "sessionSearch",
  "showArchived",
  "gitAvailable",
] as const;

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
  input.className = "cc-panel__session-edit";
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
// document 级点击外部关闭，关闭即注销监听。
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
  // 对称互斥：打开会话菜单先关「更多」菜单（两菜单同时开会互相屏蔽 outsideCloser）
  closeMoreMenu(requestUpdate);
  sessionMenuKey = key;
  // 延迟一帧注册，避免触发本次打开的 click 立刻把菜单关掉。
  requestAnimationFrame(() => {
    if (sessionMenuKey !== key || sessionMenuOutsideCloser) return;
    sessionMenuOutsideCloser = (ev: MouseEvent) => {
      const root = (ev.target as HTMLElement).closest?.(".cc-panel__session-menu-wrap");
      if (!root) {
        closeSessionMenu(requestUpdate);
      }
    };
    document.addEventListener("click", sessionMenuOutsideCloser);
  });
  requestUpdate();
  // 渲染后测量：菜单距窗口底部不足时向上翻转展开（菜单只向下弹会在列表底部被裁）。
  requestAnimationFrame(() => {
    if (sessionMenuKey !== key) return;
    const menu = document.querySelector(".cc-panel__session-menu");
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      menu.classList.add("cc-panel__session-menu--up");
    }
  });
}

// ── 「更多」菜单本地状态（与会话菜单同一模式） ──
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

function toggleMoreMenu(host: CcSessionPanel) {
  if (moreMenuOpen) {
    closeMoreMenu(host.bump);
    return;
  }
  // 双菜单互斥：打开「更多」菜单先关会话菜单
  closeSessionMenu(host.bump);
  moreMenuOpen = true;
  requestAnimationFrame(() => {
    if (!moreMenuOpen || moreMenuOutsideCloser) return;
    moreMenuOutsideCloser = (ev: MouseEvent) => {
      const root = (ev.target as HTMLElement).closest?.(".cc-panel__more-wrap");
      if (!root) closeMoreMenu(host.bump);
    };
    document.addEventListener("click", moreMenuOutsideCloser);
  });
  host.bump();
}

// 组件卸载清掉菜单模块态与 document 级监听
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
function renderSessionItem(
  host: CcSessionPanel,
  props: SessionPanelProps,
  s: SessionPanelSessionOption,
) {
  const isActive = s.key === props.currentSessionKey;
  const isMain = props.mainSessionKey != null && s.key === props.mainSessionKey;
  const menuOpen = sessionMenuKey === s.key;
  const deleting = props.isDeletingSession(s.key);
  return html`
    <div
      class="cc-panel__session-item ${isActive ? "active" : ""} ${menuOpen ? "menu-open" : ""} ${s.archived ? "is-archived" : ""}"
      @click=${() => props.onSelectSession(s.key)}
    >
      <span
        class="cc-panel__session-name"
        title=${s.label}
      >${s.unread ? html`<span class="cc-panel__unread-dot" aria-label=${t("sidebar.unread")}></span>` : nothing}${s.label}${s.pinned ? html`<span class="cc-panel__session-pin" aria-label=${t("sidebar.pinned")}>${icons.pin}</span>` : nothing}${s.worktreeBranch ? html`<span class="cc-panel__session-worktree" title=${s.worktreeBranch}>${icons.gitBranch}${s.worktreeBranch}</span>` : nothing}</span>
      <span class="cc-panel__session-menu-wrap">
        <button
          class="cc-panel__session-action ${menuOpen ? "is-open" : ""} ${deleting ? "is-loading" : ""}"
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
            <div class="cc-panel__session-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
              ${!s.archived
                ? html`
                  <button class="cc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onTogglePin(s.key, !s.pinned); }}>
                    <span class="cc-panel__session-menu-icon">${s.pinned ? icons.pinActive : icons.pin}</span>
                    <span>${s.pinned ? t("sidebar.unpinSession") : t("sidebar.pinSession")}</span>
                  </button>
                  <button class="cc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onToggleUnread(s.key, !s.unread); }}>
                    <span class="cc-panel__session-menu-icon">${s.unread ? icons.eye : icons.eyeOff}</span>
                    <span>${s.unread ? t("sidebar.markRead") : t("sidebar.markUnread")}</span>
                  </button>
                  <button class="cc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${(e: Event) => {
                      closeSessionMenu(host.bump);
                      const item = (e.currentTarget as HTMLElement).closest(".cc-panel__session-item")!;
                      const span = item.querySelector(".cc-panel__session-name") as HTMLSpanElement;
                      startInlineRename(span, s.key, s.label, props.onRenameSession, props.requestUpdate);
                    }}>
                    <span class="cc-panel__session-menu-icon">${icons.edit}</span>
                    <span>${t("sidebar.rename")}</span>
                  </button>
                  ${!isMain
                    ? html`
                      <button class="cc-panel__session-menu-item" type="button" role="menuitem"
                        @click=${() => { closeSessionMenu(host.bump); props.onSetArchived(s.key, true); }}>
                        <span class="cc-panel__session-menu-icon">${icons.archive}</span>
                        <span>${t("sidebar.archiveSession")}</span>
                      </button>
                      <button class="cc-panel__session-menu-item cc-panel__session-menu-item--danger" type="button" role="menuitem"
                        @click=${() => { closeSessionMenu(host.bump); props.onDeleteSession(s.key); }}>
                        <span class="cc-panel__session-menu-icon">${icons.trash}</span>
                        <span>${t("sidebar.delete")}</span>
                      </button>
                    `
                    : nothing}
                `
                : html`
                  <button class="cc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onSetArchived(s.key, false); }}>
                    <span class="cc-panel__session-menu-icon">${icons.archiveRestore}</span>
                    <span>${t("sidebar.restoreSession")}</span>
                  </button>
                  <button class="cc-panel__session-menu-item cc-panel__session-menu-item--danger" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onDeleteSession(s.key); }}>
                    <span class="cc-panel__session-menu-icon">${icons.trash}</span>
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

// 会话面板模板主体：面板头（标题 + 新会话/「更多」菜单）+ 归档切换 + 搜索 + 会话列表。
function renderPanelInner(host: CcSessionPanel, props: SessionPanelProps) {
  return html`
    <aside class="cc-panel" aria-label=${t("sidebar.agent")}>
      <div class="cc-panel__header">
        <span class="cc-panel__title">${props.showArchived ? t("sidebar.archivedSessions") : t("sidebar.agent")}</span>
        <div class="cc-panel__actions">
          <button
            class="cc-panel__icon-btn"
            type="button"
            @click=${props.onNewChat}
            data-tooltip=${t("sidebar.newChat")}
            data-tooltip-pos="bottom"
            aria-label=${t("sidebar.newChat")}
          >
            ${icons.messagePlus}
          </button>
          ${props.gitAvailable === true
            ? html`<div class="cc-panel__more-wrap">
              <button
                class="cc-panel__icon-btn ${moreMenuOpen ? "is-open" : ""}"
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
                ? html`<div class="cc-panel__more-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
                    <button class="cc-panel__more-item" type="button" role="menuitem"
                      data-tooltip=${t("sidebar.newWorktreeChatHint")}
                      @click=${() => { closeMoreMenu(host.bump); props.onNewWorktreeChat(); }}>
                      ${icons.gitBranch} ${t("sidebar.newWorktreeChat")}
                    </button>
                  </div>`
                : nothing}
            </div>`
            : nothing}
          <button
            class="cc-panel__icon-btn ${props.showArchived ? "active" : ""}"
            type="button"
            @click=${() => {
              closeSessionMenu(host.bump);
              props.onToggleArchived();
            }}
            data-tooltip=${props.showArchived ? t("sidebar.backToSessions") : t("sidebar.showArchived")}
            data-tooltip-pos="bottom"
            aria-label=${props.showArchived ? t("sidebar.backToSessions") : t("sidebar.showArchived")}
          >
            ${icons.archive}
          </button>
        </div>
      </div>

      <!-- 会话搜索（客户端过滤，正常/归档视图通用） -->
      <div class="cc-panel__search">
        <input
          class="cc-panel__search-input"
          type="search"
          .value=${props.sessionSearch}
          placeholder=${t("sidebar.searchSessions")}
          aria-label=${t("sidebar.searchSessions")}
          @input=${(e: Event) => props.onSessionSearchChange((e.target as HTMLInputElement).value)}
        />
      </div>

      <!-- 会话列表 -->
      <div class="cc-panel__list">
        ${props.sessionOptions.length === 0
          ? html`<div class="cc-panel__empty">${props.showArchived ? t("sidebar.noArchivedSessions") : t("sidebar.noSessions")}</div>`
          : nothing}
        ${props.showArchived || props.sessionSearch.trim()
          ? // 归档视图 / 搜索态：平铺列表，便于扫读
            repeat(props.sessionOptions, (s) => s.key, (s) => renderSessionItem(host, props, s))
          : // 正常视图：置顶 + 时间分组
            groupSidebarSessions(props.sessionOptions).map(
              (group) => html`
                <div class="cc-panel__group-label">${t(group.labelKey)}</div>
                ${repeat(group.items, (s) => s.key, (s) => renderSessionItem(host, props, s))}
              `,
            )}
      </div>
    </aside>
  `;
}
