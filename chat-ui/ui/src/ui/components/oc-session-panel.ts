import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement } from "lit/decorators.js";
import { t } from "../i18n.ts";
import { activateOnKeydown } from "../a11y.ts";
import { icons } from "../icons.ts";
import { groupSidebarSessions } from "../sidebar-grouping.ts";
import { splitSessionsByWorkspace } from "../workspace-pinning.ts";
import type { PinnedWorkspace } from "../storage.ts";
import { runExitAnimation } from "../utils/exit-anim.ts";

// CryoClaw 会话面板组件（2026.9 提案 A 重写，前身 cc-sidebar）。
// 旧 280px 侧边栏（品牌区+会话列表+底部图标轨）拆分：导航与状态入口迁往
// oc-rail 图标轨，本组件只保留 chat 视图内的会话面板——
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
@customElement("oc-session-panel")
export class OcSessionPanel extends LitElement {
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

  // 会话搜索防抖（R72）：击键只更新本地草稿 + 本组件重绘，150ms 停顿后才提交全局
  // 状态——直接提交会让每次击键触发 resolveSessionOptions 重过滤 + 整列表重渲染。
  searchDraft: string | null = null;
  private searchCommitTimer: number | null = null;

  scheduleSearchCommit(value: string): void {
    this.searchDraft = value;
    if (this.searchCommitTimer != null) window.clearTimeout(this.searchCommitTimer);
    this.searchCommitTimer = window.setTimeout(() => this.commitSearchDraft(), 150);
    this.bump();
  }

  commitSearchDraft = (): void => {
    if (this.searchCommitTimer != null) {
      window.clearTimeout(this.searchCommitTimer);
      this.searchCommitTimer = null;
    }
    if (this.searchDraft == null || !this.props) return;
    const value = this.searchDraft;
    this.searchDraft = null;
    this.props.onSessionSearchChange(value);
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
    if (this.searchCommitTimer != null) {
      window.clearTimeout(this.searchCommitTimer);
      this.searchCommitTimer = null;
    }
    this.searchDraft = null;
    resetMenuState();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-session-panel": OcSessionPanel;
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
  // 2026.10.3 子会话谱系：spawnedBy = 父会话 key（sessions_spawn 派生）
  spawnedBy?: string;
  // 分组后嵌套深度（sidebar-grouping 投影：父会话同组时 depth=1 缩进渲染）
  depth?: number;
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
  /** R58：有 queued/running 任务的会话 key 集合（这些会话的删除项禁用） */
  activeTaskSessions: ReadonlySet<string>;
  onTogglePin: (key: string, pinned: boolean) => void;
  onToggleUnread: (key: string, unread: boolean) => void;
  onSetArchived: (key: string, archived: boolean) => void;
  isDeletingSession: (key: string) => boolean;
  requestUpdate: () => void;
  // 固定工作区：列表按工作区分组 + 会话「⋯」菜单「指定工作区」+ 快速新建
  pinnedWorkspaces: PinnedWorkspace[];
  sessionWorkspaceMap: Record<string, string>;
  onNewChatInWorkspace: (workspaceId: string) => void;
  onBindSessionWorkspace: (sessionKey: string, workspaceId: string | null) => void;
  onCreateWorkspace: (draft: { name: string; icon?: string; path: string }) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
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
  "activeTaskSessions",
  "pinnedWorkspaces",
  "sessionWorkspaceMap",
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
  input.className = "oc-panel__session-edit";
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
// 退场两段式（runExitAnimation）：先加 .cc-leaving 播退场帧，finalize 才清 key 移除节点；
// epoch 在开/关时递增，使在途 finalize 失效——退场 200ms 内重开不会被误关。
let sessionMenuKey: string | null = null;
let sessionMenuEpoch = 0;
let sessionMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;
// 菜单二级模式：root = 常规操作项；workspace = 「指定工作区」选择列表
let sessionMenuMode: "root" | "workspace" = "root";

function closeSessionMenu(requestUpdate: () => void) {
  const closingKey = sessionMenuKey;
  sessionMenuEpoch++;
  if (sessionMenuOutsideCloser) {
    document.removeEventListener("click", sessionMenuOutsideCloser);
    sessionMenuOutsideCloser = null;
  }
  if (closingKey == null) {
    sessionMenuMode = "root";
    requestUpdate();
    return;
  }
  const epoch = sessionMenuEpoch;
  runExitAnimation(document.querySelector(".oc-panel__session-menu"), () => {
    if (sessionMenuEpoch === epoch && sessionMenuKey === closingKey) {
      sessionMenuKey = null;
      // 模式复位推迟到退场结束：退场期间菜单节点仍在 DOM，提前翻回 root 会让
      // 「指定工作区」选择列表在淡出途中跳回常规菜单
      sessionMenuMode = "root";
    }
    requestUpdate();
  });
}

function openSessionMenu(key: string, requestUpdate: () => void) {
  // 对称互斥：打开会话菜单先关「更多」菜单（两菜单同时开会互相屏蔽 outsideCloser）
  closeMoreMenu(requestUpdate);
  sessionMenuEpoch++;
  // 退场途中重开同一会话菜单：节点被 Lit 复用且带 cc-leaving（forwards 终态不可见），
  // 剥掉退场类恢复可见；在途 finalize 已由 epoch 递增失效
  document
    .querySelectorAll(".oc-panel__session-menu.cc-leaving")
    .forEach((el) => el.classList.remove("cc-leaving"));
  if (sessionMenuKey !== key) sessionMenuMode = "root";
  sessionMenuKey = key;
  // 延迟一帧注册，避免触发本次打开的 click 立刻把菜单关掉。
  requestAnimationFrame(() => {
    if (sessionMenuKey !== key || sessionMenuOutsideCloser) return;
    sessionMenuOutsideCloser = (ev: MouseEvent) => {
      const root = (ev.target as HTMLElement).closest?.(".oc-panel__session-menu-wrap");
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
    const menu = document.querySelector(".oc-panel__session-menu");
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      menu.classList.add("oc-panel__session-menu--up");
    }
  });
}

// ── 「更多」菜单本地状态（与会话菜单同一模式 + 退场两段式） ──
let moreMenuOpen = false;
let moreMenuEpoch = 0;
let moreMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

function closeMoreMenu(requestUpdate: () => void) {
  const wasOpen = moreMenuOpen;
  moreMenuEpoch++;
  if (moreMenuOutsideCloser) {
    document.removeEventListener("click", moreMenuOutsideCloser);
    moreMenuOutsideCloser = null;
  }
  if (!wasOpen) {
    requestUpdate();
    return;
  }
  const epoch = moreMenuEpoch;
  runExitAnimation(document.querySelector(".oc-panel__more-menu"), () => {
    if (moreMenuEpoch === epoch && moreMenuOpen) {
      moreMenuOpen = false;
    }
    requestUpdate();
  });
}

function toggleMoreMenu(host: OcSessionPanel) {
  if (moreMenuOpen) {
    closeMoreMenu(host.bump);
    return;
  }
  // 双菜单互斥：打开「更多」菜单先关会话菜单
  closeSessionMenu(host.bump);
  moreMenuEpoch++;
  document
    .querySelectorAll(".oc-panel__more-menu.cc-leaving")
    .forEach((el) => el.classList.remove("cc-leaving"));
  moreMenuOpen = true;
  requestAnimationFrame(() => {
    if (!moreMenuOpen || moreMenuOutsideCloser) return;
    moreMenuOutsideCloser = (ev: MouseEvent) => {
      const root = (ev.target as HTMLElement).closest?.(".oc-panel__more-wrap");
      if (!root) closeMoreMenu(host.bump);
    };
    document.addEventListener("click", moreMenuOutsideCloser);
  });
  host.bump();
}

// 组件卸载清掉菜单模块态与 document 级监听
function resetMenuState() {
  sessionMenuKey = null;
  sessionMenuMode = "root";
  moreMenuOpen = false;
  closeWorkspaceDialogState();
  workspaceDialogReturnFocus = null;
  if (sessionMenuOutsideCloser) {
    document.removeEventListener("click", sessionMenuOutsideCloser);
    sessionMenuOutsideCloser = null;
  }
  if (moreMenuOutsideCloser) {
    document.removeEventListener("click", moreMenuOutsideCloser);
    moreMenuOutsideCloser = null;
  }
}

// ── 新建工作区对话框本地状态（草稿为纯 UI 态，提交才回调 props.onCreateWorkspace）──
let workspaceDialogOpen = false;
let workspaceDraftName = "";
let workspaceDraftIcon = "";
let workspaceDraftPath = "";
// 打开前的焦点：优先「更多」按钮（菜单项退场后会被移除，指针不可靠），
// 关闭对话框后归还焦点，键盘用户不会掉回 body。
let workspaceDialogReturnFocus: HTMLElement | null = null;

function openWorkspaceDialog(host: OcSessionPanel) {
  workspaceDialogOpen = true;
  workspaceDraftName = "";
  workspaceDraftIcon = "";
  workspaceDraftPath = "";
  workspaceDialogReturnFocus =
    document.querySelector<HTMLElement>(".oc-panel__more-wrap .icon-btn") ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  host.bump();
  // 「更多」菜单已关闭，对话框打开后把焦点送进名称输入框（role=dialog + aria-modal 的
  // 键盘入口；不做焦点陷阱——面板内浮层按 Esc/backdrop 关闭，结构保持扁平）
  requestAnimationFrame(() => {
    if (!workspaceDialogOpen) return;
    document.querySelector<HTMLInputElement>(".oc-panel__ws-dialog .oc-panel__ws-field input")?.focus();
  });
}

function closeWorkspaceDialogState() {
  workspaceDialogOpen = false;
}

function closeWorkspaceDialog(host: OcSessionPanel) {
  workspaceDialogOpen = false;
  host.bump();
  const target = workspaceDialogReturnFocus;
  workspaceDialogReturnFocus = null;
  requestAnimationFrame(() => target?.isConnected && target.focus());
}

// 目录选择走 Electron 主进程 dialog（preload 桥 selectDirectory）；非桌面环境无桥时静默忽略
async function pickWorkspaceDirectory(host: OcSessionPanel) {
  const w = window as unknown as Record<string, unknown>;
  const bridge = w.cryoclaw as { selectDirectory?: () => Promise<string | null> } | undefined;
  if (!bridge?.selectDirectory) {
    return;
  }
  try {
    const dir = await bridge.selectDirectory();
    if (dir) {
      workspaceDraftPath = dir;
      if (!workspaceDraftName.trim()) workspaceDraftName = dir.split(/[/\\]/).filter(Boolean).at(-1) || dir;
      host.bump();
    }
  } catch {
    // 用户取消/对话框失败：草稿保持原样
  }
}

// ── 会话列表分组：实现见 sidebar-grouping.ts（置顶 + 时间分组，纯函数可测） ──

// 单个会话项（正常/归档/搜索/分组渲染共用）：名称行 + 「⋯」管理菜单
function renderSessionItem(
  host: OcSessionPanel,
  props: SessionPanelProps,
  s: SessionPanelSessionOption,
) {
  const isActive = s.key === props.currentSessionKey;
  const isMain = props.mainSessionKey != null && s.key === props.mainSessionKey;
  const menuOpen = sessionMenuKey === s.key;
  const deleting = props.isDeletingSession(s.key);
  return html`
    <div
      class="oc-panel__session-item ${isActive ?"active" : ""} ${menuOpen ? "menu-open" : ""} ${s.archived ? "is-archived" : ""} ${s.depth ? "is-subsession" : ""}"
      role="button"
      tabindex="0"
      aria-current=${isActive ? "true" : nothing}
      @click=${() => props.onSelectSession(s.key)}
      @keydown=${activateOnKeydown(() => props.onSelectSession(s.key))}
    >
      <span
        class="oc-panel__session-name"
        title=${s.label}
      >${s.depth ? html`<span class="oc-panel__subsession-marker" aria-hidden="true">↳</span>` : nothing}${s.unread ? html`<span class="oc-panel__unread-dot" role="img" aria-label=${t("sidebar.unread")}></span>` : nothing}<span class="oc-panel__session-label">${s.label}</span>${s.pinned ? html`<span class="oc-panel__session-pin" role="img" aria-label=${t("sidebar.pinned")}>${icons.pin}</span>` : nothing}${s.worktreeBranch ? html`<span class="oc-panel__session-worktree" title=${s.worktreeBranch}>${icons.gitBranch}${s.worktreeBranch}</span>` : nothing}</span>
      <span class="oc-panel__session-menu-wrap">
        <button
          class="oc-panel__session-action ${menuOpen ?"is-open" : ""} ${deleting ? "is-loading" : ""}"
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
            <div class="oc-panel__session-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
              ${sessionMenuMode === "workspace"
                ? renderWorkspacePicker(host, props, s)
                : html`
              ${!s.archived
                ? html`
                  <button class="oc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onTogglePin(s.key, !s.pinned); }}>
                    <span class="oc-panel__session-menu-icon">${s.pinned ? icons.pinActive : icons.pin}</span>
                    <span>${s.pinned ? t("sidebar.unpinSession") : t("sidebar.pinSession")}</span>
                  </button>
                  <button class="oc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onToggleUnread(s.key, !s.unread); }}>
                    <span class="oc-panel__session-menu-icon">${s.unread ? icons.eye : icons.eyeOff}</span>
                    <span>${s.unread ? t("sidebar.markRead") : t("sidebar.markUnread")}</span>
                  </button>
                  <button class="oc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${(e: Event) => {
                      closeSessionMenu(host.bump);
                      const item = (e.currentTarget as HTMLElement).closest(".oc-panel__session-item")!;
                      const span = item.querySelector(".oc-panel__session-name") as HTMLSpanElement;
                      startInlineRename(span, s.key, s.label, props.onRenameSession, props.requestUpdate);
                    }}>
                    <span class="oc-panel__session-menu-icon">${icons.edit}</span>
                    <span>${t("sidebar.rename")}</span>
                  </button>
                  ${props.pinnedWorkspaces.length > 0
                    ? html`
                      <button class="oc-panel__session-menu-item" type="button" role="menuitem"
                        aria-haspopup="true"
                        @click=${() => { sessionMenuMode = "workspace"; host.bump(); }}>
                        <span class="oc-panel__session-menu-icon">${icons.folder}</span>
                        <span>${t("workspace.assign")}</span>
                      </button>
                    `
                    : nothing}
                  ${!isMain
                    ? html`
                      <button class="oc-panel__session-menu-item" type="button" role="menuitem"
                        @click=${() => { closeSessionMenu(host.bump); props.onSetArchived(s.key, true); }}>
                        <span class="oc-panel__session-menu-icon">${icons.archive}</span>
                        <span>${t("sidebar.archiveSession")}</span>
                      </button>
                      <button class="oc-panel__session-menu-item oc-panel__session-menu-item--danger" type="button" role="menuitem"
                        ?disabled=${props.activeTaskSessions.has(s.key)}
                        title=${props.activeTaskSessions.has(s.key) ? t("sidebar.deleteBlockedByTask") : ""}
                        @click=${() => { closeSessionMenu(host.bump); props.onDeleteSession(s.key); }}>
                        <span class="oc-panel__session-menu-icon">${icons.trash}</span>
                        <span>${t("sidebar.delete")}</span>
                      </button>
                    `
                    : nothing}
                `
                : html`
                  <button class="oc-panel__session-menu-item" type="button" role="menuitem"
                    @click=${() => { closeSessionMenu(host.bump); props.onSetArchived(s.key, false); }}>
                    <span class="oc-panel__session-menu-icon">${icons.archiveRestore}</span>
                    <span>${t("sidebar.restoreSession")}</span>
                  </button>
                  <button class="oc-panel__session-menu-item oc-panel__session-menu-item--danger" type="button" role="menuitem"
                    ?disabled=${props.activeTaskSessions.has(s.key)}
                    title=${props.activeTaskSessions.has(s.key) ? t("sidebar.deleteBlockedByTask") : ""}
                    @click=${() => { closeSessionMenu(host.bump); props.onDeleteSession(s.key); }}>
                    <span class="oc-panel__session-menu-icon">${icons.trash}</span>
                    <span>${t("sidebar.delete")}</span>
                  </button>
                `}
              `}
            </div>
          `
          : nothing}
      </span>
    </div>
  `;
}

// 会话「⋯」菜单二级：指定工作区选择列表（含「无工作区」解绑项；当前绑定打勾）
function renderWorkspacePicker(
  host: OcSessionPanel,
  props: SessionPanelProps,
  s: SessionPanelSessionOption,
) {
  const currentWs = props.sessionWorkspaceMap[s.key] ?? null;
  const bind = (workspaceId: string | null) => {
    closeSessionMenu(host.bump);
    props.onBindSessionWorkspace(s.key, workspaceId);
  };
  return html`
    <button class="oc-panel__session-menu-item" type="button" role="menuitem"
      @click=${() => { sessionMenuMode = "root"; host.bump(); }}>
      <span class="oc-panel__session-menu-icon">${icons.arrowLeft}</span>
      <span>${t("workspace.assign")}</span>
    </button>
    <button class="oc-panel__session-menu-item" type="button" role="menuitemradio"
      aria-checked=${currentWs == null ? "true" : "false"}
      @click=${() => bind(null)}>
      <span class="oc-panel__session-menu-icon">${currentWs == null ? icons.check : nothing}</span>
      <span>${t("workspace.none")}</span>
    </button>
    ${props.pinnedWorkspaces.map(
      (ws) => html`
        <button class="oc-panel__session-menu-item" type="button" role="menuitemradio"
          aria-checked=${currentWs === ws.id ? "true" : "false"}
          title=${ws.path}
          @click=${() => bind(ws.id)}>
          <span class="oc-panel__session-menu-icon">${currentWs === ws.id ? icons.check : nothing}</span>
          <span>${ws.icon} ${ws.name}</span>
        </button>
      `,
    )}
  `;
}

// 新建工作区对话框（面板内嵌浮层；路径可手输或经主进程目录选择器）
function renderWorkspaceDialog(host: OcSessionPanel, props: SessionPanelProps) {
  if (!workspaceDialogOpen) {
    return nothing;
  }
  const canSubmit = workspaceDraftName.trim().length > 0 && workspaceDraftPath.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    props.onCreateWorkspace({
      name: workspaceDraftName.trim(),
      icon: workspaceDraftIcon.trim() || undefined,
      path: workspaceDraftPath.trim(),
    });
    closeWorkspaceDialog(host);
  };
  return html`
    <div class="oc-panel__ws-dialog-backdrop" @click=${() => closeWorkspaceDialog(host)}>
      <div
        class="oc-panel__ws-dialog"
        role="dialog"
        aria-modal="true"
        aria-label=${t("workspace.createTitle")}
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            closeWorkspaceDialog(host);
          } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div class="oc-panel__ws-dialog-title">${t("workspace.createTitle")}</div>
        <label class="oc-panel__ws-field">
          <span>${t("workspace.nameLabel")}</span>
          <input
            type="text"
            .value=${workspaceDraftName}
            placeholder=${t("workspace.namePlaceholder")}
            @input=${(e: Event) => { workspaceDraftName = (e.target as HTMLInputElement).value; host.bump(); }}
          />
        </label>
        <label class="oc-panel__ws-field">
          <span>${t("workspace.iconLabel")}</span>
          <input
            type="text"
            .value=${workspaceDraftIcon}
            placeholder="📁"
            maxlength="4"
            @input=${(e: Event) => { workspaceDraftIcon = (e.target as HTMLInputElement).value; host.bump(); }}
          />
        </label>
        <label class="oc-panel__ws-field">
          <span>${t("workspace.pathLabel")}</span>
          <span class="oc-panel__ws-path-row">
            <input
              type="text"
              .value=${workspaceDraftPath}
              placeholder=${t("workspace.pathPlaceholder")}
              @input=${(e: Event) => { workspaceDraftPath = (e.target as HTMLInputElement).value; host.bump(); }}
            />
            <button
              class="btn btn--sm"
              type="button"
              @click=${() => void pickWorkspaceDirectory(host)}
            >${t("workspace.browse")}</button>
          </span>
        </label>
        <div class="oc-panel__ws-dialog-actions">
          <button type="button" class="btn btn--sm" @click=${() => closeWorkspaceDialog(host)}>
            ${t("workspace.cancel")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${!canSubmit}
            @click=${submit}
          >${t("workspace.create")}</button>
        </div>
      </div>
    </div>
  `;
}

// 会话面板模板主体：面板头（标题 + 新会话/「更多」菜单）+ 归档切换 + 搜索 + 会话列表。
function renderPanelInner(host: OcSessionPanel, props: SessionPanelProps) {
  const showGrouped = !props.showArchived && !props.sessionSearch.trim();
  // 工作区分组只作用于正常视图：归档/搜索态平铺便于扫读
  const wsSplit = showGrouped
    ? splitSessionsByWorkspace(props.sessionOptions, props.pinnedWorkspaces, props.sessionWorkspaceMap)
    : null;
  return html`
    <aside class="oc-panel" aria-label=${t("sidebar.agent")}>
      <div class="oc-panel__header">
        <span class="oc-panel__title">${props.showArchived ? t("sidebar.archivedSessions") : t("sidebar.agent")}</span>
        <div class="oc-panel__actions">
          <button
            class="icon-btn icon-btn--sm"
            type="button"
            @click=${props.onNewChat}
            data-tooltip=${t("sidebar.newChat")}
            data-tooltip-pos="bottom"
            aria-label=${t("sidebar.newChat")}
          >
            ${icons.messagePlus}
          </button>
          <div class="oc-panel__more-wrap">
            <button
              class="icon-btn icon-btn--sm ${moreMenuOpen ?"is-open" : ""}"
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
              ? html`<div class="oc-panel__more-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
                  <button class="oc-panel__more-item" type="button" role="menuitem"
                    data-tooltip=${t("workspace.createHint")}
                    data-tooltip-wide="true"
                    @click=${() => { closeMoreMenu(host.bump); openWorkspaceDialog(host); }}>
                    ${icons.folder} ${t("workspace.create")}
                  </button>
                  ${props.gitAvailable === true
                    ? html`<button class="oc-panel__more-item" type="button" role="menuitem"
                        data-tooltip=${t("sidebar.newWorktreeChatHint")}
                        data-tooltip-wide="true"
                        @click=${() => { closeMoreMenu(host.bump); props.onNewWorktreeChat(); }}>
                        ${icons.gitBranch} ${t("sidebar.newWorktreeChat")}
                      </button>`
                    : nothing}
                </div>`
              : nothing}
          </div>
          <button
            class="icon-btn icon-btn--sm ${props.showArchived ?"active" : ""}"
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
      <div class="oc-panel__search">
        <input
          class="oc-panel__search-input"
          type="search"
          .value=${host.searchDraft ?? props.sessionSearch}
          placeholder=${t("sidebar.searchSessions")}
          aria-label=${t("sidebar.searchSessions")}
          @input=${(e: Event) => host.scheduleSearchCommit((e.target as HTMLInputElement).value)}
        />
      </div>

      <!-- 会话列表 -->
      <div class="oc-panel__list">
        ${props.sessionOptions.length === 0 && (!showGrouped || props.pinnedWorkspaces.length === 0)
          ? html`<div class="oc-panel__empty">${props.showArchived ? t("sidebar.noArchivedSessions") : t("sidebar.noSessions")}</div>`
          : nothing}
        ${!showGrouped
          ? // 归档视图 / 搜索态：平铺列表，便于扫读
            repeat(props.sessionOptions, (s) => s.key, (s) => renderSessionItem(host, props, s))
          : html`
            ${wsSplit!.sections.map(
              (section) => html`
                <div class="oc-panel__group-label oc-panel__workspace-label">
                  <span class="oc-panel__workspace-icon" aria-hidden="true">${section.workspace.icon}</span>
                  <span class="oc-panel__workspace-name" title=${section.workspace.path}>${section.workspace.name}</span>
                  <button
                    class="icon-btn icon-btn--xs oc-panel__workspace-action"
                    type="button"
                    data-tooltip=${t("workspace.newSessionHere")}
                    data-tooltip-pos="bottom"
                    aria-label=${t("workspace.newSessionHere")}
                    @click=${() => props.onNewChatInWorkspace(section.workspace.id)}
                  >${icons.plus}</button>
                  <button
                    class="icon-btn icon-btn--xs oc-panel__workspace-action oc-panel__workspace-action--danger"
                    type="button"
                    data-tooltip=${t("workspace.remove")}
                    data-tooltip-pos="bottom"
                    aria-label=${t("workspace.remove")}
                    @click=${() => props.onRemoveWorkspace(section.workspace.id)}
                  >${icons.x}</button>
                </div>
                ${repeat(section.items, (s) => s.key, (s) => renderSessionItem(host, props, s))}
              `,
            )}
            ${groupSidebarSessions(wsSplit!.unbound).map(
              (group) => html`
                <div class="oc-panel__group-label">${t(group.labelKey)}</div>
                ${repeat(group.items, (s) => s.key, (s) => renderSessionItem(host, props, s))}
              `,
            )}
          `}
      </div>
      ${renderWorkspaceDialog(host, props)}
    </aside>
  `;
}
