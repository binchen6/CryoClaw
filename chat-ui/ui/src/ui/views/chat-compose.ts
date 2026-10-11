/**
 * chat-compose.ts — 对话页输入区（textarea + 工具条 + 附属浮层）纯渲染模块。
 * 对齐 question-cards/progress-card 已拆出范式：纯函数搬迁，不动状态层——
 * 全部业务状态仍归 OpenClawApp（app-*.ts），本模块只接 props、渲染模板。
 *
 * 模块级瞬态（非响应式，渲染由 props.onRequestUpdate 驱动）：
 *   - 加号菜单展开态 + 技能选择子面板 + document 外部点击监听
 *   - 思考档位 / 分支 popover 的外部点击监听（单例，关闭即注销防泄漏）
 *   - / 命令补全浮层（列表 + 高亮索引）
 *   - 目标表单（加号菜单「目标模式」，goalDraft 非响应式）
 * 切会话时由 resetComposeTransient 统一复位（renderChat 的 lastSessionKey 门控调用）。
 */
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewaySessionRow } from "../types.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import { detectTextDirection } from "../text-direction.ts";
import { resolveContextMeterStats } from "../context-meter.ts";
import type { CommandEntry } from "../types.ts";
import { filterCommands, resolveCommandDescription } from "../controllers/commands.ts";
import {
  goalStatusKey,
  goalStatusKind,
  goalSummaryText,
  goalTokenPercent,
  goalTokensLabel,
} from "../chat/goal-display.ts";
import { renderConfiguredModelOptions } from "../model-options.ts";
import { loadModelOrg } from "./settings/model-org.lib.ts";
import { KNOWN_THINKING_LEVELS } from "../chat/thinking-levels.ts";
import type { ChatProps } from "./chat.ts";

// renderChat 已派生好的 compose 上下文（模型选择器/占位文案/忙碌态在装配层算好传入）
export type ComposeRenderContext = {
  activeSession: GatewaySessionRow | null | undefined;
  composePlaceholder: string;
  modelSelectValue: string | null;
  isBusy: boolean;
  showStop: boolean;
};

// 加号菜单 / 目标表单本地状态（非响应式，渲染由 requestUpdate 驱动）
let plusMenuOpen = false;
let goalFormOpen = false;
let goalDraft = "";

// 加号菜单「引用技能」子面板状态：技能列表缓存于模块级，
// 每次打开时若未加载过则拉取一次（skills.status 变化频率低）
let skillPickerOpen = false;
let skillPickerLoading = false;
let skillPickerItems: Array<{ key: string; name: string; description?: string; emoji?: string }> = [];
let skillPickerLoaded = false;

// 加号菜单「点击外部关闭」的 document 监听句柄；菜单关闭时必须同步注销，
// 否则监听会残留到下一次外部点击才被清掉（并持有过期 props 闭包）。
let plusMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

// 思考档位 / 分支 popover 的「点击外部关闭」监听（模块级单例）。
// toggle 按钮本身 stopPropagation，document 点击永远看不到按钮点击——
// 若关闭分支不显式注销，每次 开→关→开 循环都会永久泄漏一个持有过期
// popover/el 闭包的 document 监听器。
let thinkingPopoverCloser: ((ev: MouseEvent) => void) | null = null;
let branchPopoverCloser: ((ev: MouseEvent) => void) | null = null;

function closeThinkingPopover() {
  for (const el of document.querySelectorAll(".chat-compose__thinking-popover--open")) {
    el.classList.remove("chat-compose__thinking-popover--open");
  }
  if (thinkingPopoverCloser) {
    document.removeEventListener("click", thinkingPopoverCloser);
    thinkingPopoverCloser = null;
  }
}

function closeBranchPopover() {
  for (const el of document.querySelectorAll(".chat-compose__branch-popover--open")) {
    el.classList.remove("chat-compose__branch-popover--open");
  }
  if (branchPopoverCloser) {
    document.removeEventListener("click", branchPopoverCloser);
    branchPopoverCloser = null;
  }
}

function closePlusMenu(props: { onRequestUpdate?: () => void }) {
  plusMenuOpen = false;
  skillPickerOpen = false;
  if (plusMenuOutsideCloser) {
    document.removeEventListener("click", plusMenuOutsideCloser);
    plusMenuOutsideCloser = null;
  }
  props.onRequestUpdate?.();
}

function openPlusMenu(props: { onRequestUpdate?: () => void }) {
  plusMenuOpen = true;
  // 延迟一帧注册，避免触发本次打开的 click 立刻把菜单关掉。
  requestAnimationFrame(() => {
    if (!plusMenuOpen || plusMenuOutsideCloser) return;
    plusMenuOutsideCloser = (ev: MouseEvent) => {
      const root = document.querySelector(".chat-plus");
      // root 为 null = chat 视图已卸载（切到设置/任务等），同样要关闭并注销
      if (!root || !root.contains(ev.target as Node)) {
        closePlusMenu(props);
      }
    };
    document.addEventListener("click", plusMenuOutsideCloser);
  });
  props.onRequestUpdate?.();
}

/** 切会话复位 compose 全部模块级瞬态（renderChat 的 lastSessionKey 门控调用）。 */
export function resetComposeTransient(props: { onRequestUpdate?: () => void }) {
  closePlusMenu(props);
  closeThinkingPopover();
  closeBranchPopover();
  goalFormOpen = false;
  goalDraft = "";
  commandSuggestions = [];
  commandIndex = 0;
}

// / 命令补全状态
let commandSuggestions: CommandEntry[] = [];
let commandIndex = 0;

// 思考档位标签：已知档走 i18n（chat.thinkLevel.*），未知档原样显示内核 id
function thinkingLevelLabel(level: string): string {
  return (KNOWN_THINKING_LEVELS as readonly string[]).includes(level)
    ? t(`chat.thinkLevel.${level}`)
    : level;
}

// 自适应高度（首次挂载时延迟到下一帧，确保 CSS 已应用）。
// lit ref 回调是内联箭头函数，每次渲染 commit 都会重新执行——流式期间每帧
// 重渲染都会调度一次 rAF 布局，而 draft 未变时高度必然不变。用 value+宽度+换行数
// 指纹跳过冗余布局（style 类与字体均不变，指纹不变则高度不变）。
function adjustTextareaHeight(el: HTMLTextAreaElement, deferred = false) {
  const apply = () => {
    // 指纹含换行数：等长但换行数不同的 value 高度不同（scrollHeight 随 soft-wrap 变化），
    // 只有长度+宽度会漏掉这种碰撞
    const fingerprint = `${el.value.length}:${el.clientWidth}:${el.value.split("\n").length - 1}`;
    if (el.dataset.hAdjust === fingerprint) {
      return;
    }
    el.dataset.hAdjust = fingerprint;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  if (deferred) {
    requestAnimationFrame(apply);
  } else {
    apply();
  }
}

/**
 * Context Meter — 放在发送按钮左侧，展示当前对话记忆占用。
 * 数据源：
 *   - used = session.totalTokens（最后一次调用的 prompt token 数，gateway 在
 *            turn 结束后持久化）
 *   - max  = session.contextTokens（gateway 按调用时用的模型写入的窗口大小）
 *            缺失时回退到 lookupContextWindow(session.model)，不跨会话信任 currentModel
 * 仅展示「当前会话」占用比例，跨会话独立；模型未知且 used>0 时整体隐藏。
 *
 * 模型切换：用户切完 model 后，该 sessionKey 会被加入 dirtyMeterSessions 集合，
 * 直到下一轮 usage（totalTokens 单调推进）落库才清除——天然 per-session 独立。
 */
function contextMeterText(
  key: string,
  values: { percent: string; used: string; max: string },
) {
  return t(key)
    .replace("{percent}", values.percent)
    .replace("{used}", values.used)
    .replace("{max}", values.max);
}

function renderContextMeter(
  session: GatewaySessionRow | null | undefined,
  dirtySessions: ReadonlySet<string> | undefined,
) {
  if (!session) return nothing;
  const stats = resolveContextMeterStats(session, dirtySessions);
  if (!stats) return nothing;
  const values = {
    percent: String(stats.percent),
    used: stats.used.toLocaleString(),
    max: stats.max.toLocaleString(),
  };
  const label = contextMeterText("chat.contextMeterAria", values);
  const title = contextMeterText("chat.contextMeterHint", values);
  return html`
    <div class="chat-compose__ctx-meter" data-tooltip=${title} data-tooltip-wide="true">
      <div
        class="chat-compose__ctx-meter-bar"
        role="progressbar"
        aria-label=${label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${String(stats.percent)}
      >
        <div class="chat-compose__ctx-meter-fill" style=${`width: ${stats.widthPct}%`}></div>
      </div>
    </div>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// 从路径提取文件名
function basename(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  return path.split(sep).pop() || path;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  if (!props.onAttachmentsChange) return;

  // 图片粘贴：走 dataUrl 内嵌
  const items = e.clipboardData?.items;
  if (items) {
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) imageItems.push(items[i]);
    }
    if (imageItems.length > 0) {
      e.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          const dataUrl = reader.result as string;
          // 函数式更新：基于最新附件列表合并，快速连贴不会互相覆盖
          props.onAttachmentsChange?.((prev) => [...prev, {
            id: generateAttachmentId(), dataUrl, mimeType: file.type,
          }]);
        });
        reader.readAsDataURL(file);
      }
      return;
    }
  }

  // 文件粘贴：从剪贴板读取文件路径（Cmd+C / Ctrl+C 复制的文件）
  // IPC 是异步的，但 preventDefault 必须同步调用——先检查剪贴板是否含文件条目
  const hasFileItems = items && Array.from({ length: items.length }, (_, i) => items[i])
    .some((item) => item.kind === "file");
  if (!hasFileItems) return;
  e.preventDefault();
  const w = window as unknown as Record<string, unknown>;
  const cryoclaw = w.cryoclaw as Record<string, (...args: unknown[]) => Promise<string[]>> | undefined;
  if (!cryoclaw?.readClipboardFilePaths) return;
  cryoclaw.readClipboardFilePaths().then((paths: string[]) => {
    if (!paths?.length) return;
    const additions = paths.map((p: string) => ({
      id: generateAttachmentId(), filePath: p, name: basename(p),
    }));
    // 函数式更新：基于最新附件列表合并，快速连贴不会互相覆盖
    props.onAttachmentsChange?.((prev) => [...prev, ...additions]);
  }).catch(() => {
    // 读取剪贴板文件路径失败时静默忽略（用户可重试粘贴）
  });
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment ${att.filePath && !att.dataUrl ?"chat-attachment--file" : ""}">
            ${
              att.dataUrl
                ? html`<img
                    src=${att.dataUrl}
                    alt=${t("chat.attachmentPreview")}
                    class="chat-attachment__img"
                  />`
                : html`<div class="chat-attachment__file">
                    <span class="chat-attachment__file-icon">${icons.fileText}</span>
                    <span class="chat-attachment__file-name">${att.name || basename(att.filePath ?? "")}</span>
                  </div>`
            }
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label=${t("chat.removeAttachment")}
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

// 分支 popover：列出当前会话的分支（transcript 树各 tip），支持切换到指定分支；
// 回退/分叉入口在用户消息气泡上（rewind/fork 回调），此处只做分支浏览与切换
function renderBranchPopover(props: ChatProps) {
  const busy = props.branchBusyAction ?? null;
  // 缓存的 branches 属于别的会话时视为加载中，不把旧会话的分支展示/暴露给当前会话
  const keyMismatch =
    props.sessionBranchesKey != null && props.sessionBranchesKey !== props.sessionKey;
  const loading = props.sessionBranchesLoading || keyMismatch;
  const branches = keyMismatch ? [] : (props.sessionBranches ?? []);
  const busySwitch = busy?.startsWith("switch:") ? busy.slice("switch:".length) : null;
  return html`
    <div class="chat-compose__branch-popover">
      <div class="chat-compose__branch-title">${t("chat.branch.title")}</div>
      ${loading
        ? html`<div class="chat-compose__branch-status">${t("chat.loading")}</div>`
        : nothing}
      ${props.sessionBranchesError
        ? html`<div class="chat-compose__branch-status chat-compose__branch-status--error" title=${props.sessionBranchesError}>
            ${t("chat.branch.loadFailed")}
          </div>`
        : nothing}
      ${!loading && !props.sessionBranchesError && !branches.length
        ? html`<div class="chat-compose__branch-status">${t("chat.branch.empty")}</div>`
        : nothing}
      ${branches.map(
        (branch) => html`
          <div class="chat-compose__branch-item">
            <div class="chat-compose__branch-item-main">
              <div class="chat-compose__branch-item-headline" title=${branch.headline}>
                ${branch.headline}
              </div>
              <div class="chat-compose__branch-item-meta">
                ${t("chat.branch.messages").replace(
                  "{n}",
                  String(branch.messageCount ?? 0),
                )}
                ${branch.updatedAt
                  ? html`<span class="chat-compose__branch-item-time">
                      ${new Date(branch.updatedAt).toLocaleString()}
                    </span>`
                  : nothing}
              </div>
            </div>
            <div class="chat-compose__branch-item-actions">
              ${branch.active
                ? html`<span class="chat-compose__branch-current">${t("chat.branch.current")}</span>`
                : html`<button
                    class="chat-compose__branch-action"
                    type="button"
                    ?disabled=${busy !== null}
                    @click=${() => props.onSwitchBranch?.(branch.leafEntryId)}
                  >
                    ${busySwitch === branch.leafEntryId ? icons.loader : nothing}${t(
                      "chat.branch.switch",
                    )}
                  </button>`}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

// ── 引用技能子面板（加号菜单 → 引用技能） ──
async function openSkillPicker(props: ChatProps) {
  skillPickerOpen = true;
  if (!skillPickerLoaded && !skillPickerLoading && props.onListSkills) {
    skillPickerLoading = true;
    props.onRequestUpdate?.();
    try {
      skillPickerItems = await props.onListSkills();
      skillPickerLoaded = true;
    } catch {
      skillPickerItems = [];
    } finally {
      skillPickerLoading = false;
    }
  }
  props.onRequestUpdate?.();
}

function insertSkillReference(props: ChatProps, name: string) {
  const mention = `@${name} `;
  const draft = props.draft ?? "";
  const next = draft.trim().length === 0
    ? mention
    : draft.endsWith(" ") || draft.endsWith("\n")
      ? `${draft}${mention}`
      : `${draft} ${mention}`;
  props.onDraftChange(next);
  closePlusMenu(props);
  // 焦点送回输入框，引用完可以接着打字
  requestAnimationFrame(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".chat-compose__field textarea");
    textarea?.focus();
  });
}

function renderSkillPicker(props: ChatProps) {
  if (!skillPickerOpen) {
    return nothing;
  }
  return html`
    <div class="chat-plus__skill-picker" @click=${(e: Event) => e.stopPropagation()}>
      <div class="chat-plus__skill-picker-title">${t("chat.plusSkillPickerTitle")}</div>
      ${skillPickerLoading
        ? html`<div class="chat-plus__skill-picker-status">${t("chat.loading")}</div>`
        : skillPickerItems.length === 0
          ? html`<div class="chat-plus__skill-picker-status">${t("chat.plusSkillEmpty")}</div>`
          : skillPickerItems.map((skill) => html`
            <button class="chat-plus__skill-item" type="button"
              @click=${() => insertSkillReference(props, skill.name)}>
              <span class="chat-plus__skill-item-name">${skill.emoji ? `${skill.emoji} ` : nothing}${skill.name}</span>
              ${skill.description
                ? html`<span class="chat-plus__skill-item-desc" title=${skill.description}>${skill.description}</span>`
                : nothing}
            </button>
          `)}
    </div>
  `;
}

// ── 目标横幅（compose 上方；窄屏折叠为胶囊） ──
export function renderGoalBanner(props: ChatProps) {
  const goal = props.goal;
  if (!goal) {
    return nothing;
  }
  const kind = goalStatusKind(goal.status);
  const tokens = goalTokensLabel(goal);
  const percent = goalTokenPercent(goal);
  const duration = goalSummaryText(goal);
  const active = goal.status === "active";
  return html`
    <div class="chat-goal chat-goal--${kind}" role="status">
      <div class="chat-goal__main">
        <div class="chat-goal__status">${t(goalStatusKey(goal.status))}</div>
        <div class="chat-goal__objective" title=${goal.objective}>${goal.objective}</div>
        <div class="chat-goal__meta">
          <span class="chat-goal__timer">${duration}</span>
          ${tokens ? html`<span class="chat-goal__tokens">${tokens}</span>` : nothing}
        </div>
        ${percent !== null
          ? html`<div class="chat-goal__bar"><div class="chat-goal__bar-fill" style=${`width: ${percent}%`}></div></div>`
          : nothing}
      </div>
      <div class="chat-goal__actions">
        ${active
          ? html`<button class="btn btn--sm" type="button" @click=${() => props.onGoalCommand?.("/goal pause")}>${t("goal.pause")}</button>`
          : goal.status !== "complete"
            ? html`<button class="btn btn--sm" type="button" @click=${() => props.onGoalCommand?.("/goal resume")}>${t("goal.resume")}</button>`
            : nothing}
        <button class="btn btn--sm" type="button" @click=${() => props.onGoalCommand?.("/goal clear")}>${t("goal.clear")}</button>
      </div>
    </div>
  `;
}

// ── 目标表单（加号菜单 → 目标模式） ──
export function renderGoalForm(props: ChatProps) {
  if (!goalFormOpen) {
    return nothing;
  }
  return html`
    <div class="chat-goal-form">
      <input
        class="chat-goal-form__input"
        type="text"
        .value=${goalDraft}
        placeholder=${t("goal.placeholder")}
        @input=${(e: Event) => { goalDraft = (e.target as HTMLInputElement).value; }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" && goalDraft.trim()) {
            props.onGoalCommand?.(`/goal ${goalDraft.trim()}`);
            goalFormOpen = false;
            goalDraft = "";
            props.onRequestUpdate?.();
          } else if (e.key === "Escape") {
            goalFormOpen = false;
            props.onRequestUpdate?.();
          }
        }}
      />
      <button class="chat-goal-form__submit" type="button" ?disabled=${!goalDraft.trim()} @click=${() => {
        if (!goalDraft.trim()) return;
        props.onGoalCommand?.(`/goal ${goalDraft.trim()}`);
        goalFormOpen = false;
        goalDraft = "";
        props.onRequestUpdate?.();
      }}>${t("goal.start")}</button>
      <button class="chat-goal-form__cancel" type="button" @click=${() => { goalFormOpen = false; props.onRequestUpdate?.(); }}>${t("chat.cancel")}</button>
    </div>
  `;
}

// ── 加号菜单（添加文件 / 引用技能 / 目标模式 / 执行权限三档） ──
function renderPlusMenu(props: ChatProps) {
  const openFilePicker = async () => {
    const w = window as unknown as Record<string, unknown>;
    const cryoclaw = w.cryoclaw as Record<string, (...args: unknown[]) => Promise<string[]>> | undefined;
    if (!cryoclaw?.selectFiles) {
      return;
    }
    try {
      const paths = await cryoclaw.selectFiles();
      if (!paths?.length) {
        return;
      }
      const additions = paths.map((p: string) => ({
        id: generateAttachmentId(),
        filePath: p,
        name: p.split(/[/\\]/).pop() || p,
      }));
      // 函数式更新：基于最新附件列表合并，避免闭包旧值覆盖并发新增的附件
      props.onAttachmentsChange?.((prev) => [...prev, ...additions]);
    } catch {
      // 选文件失败（含用户取消外的异常）静默忽略，用户可重试
    }
  };

  // R89：内核 2026.9.3 tools.exec.mode 五档；聊天页快捷菜单提供常用三档，
  // deny/allowlist（设置页五档）生效时菜单三档均不选中，避免误导当前档位。
  const execMode = props.execMode ?? "ask";
  const execModes: Array<["ask" | "auto" | "full", string]> = [
    ["ask", t("chat.execModeAsk")],
    ["auto", t("chat.execModeAuto")],
    ["full", t("chat.execModeApproveAll")],
  ];

  return html`
    <div class="chat-plus">
      <button
        class="chat-compose__tool-btn chat-plus__trigger ${plusMenuOpen ?"chat-plus__trigger--open" : ""}"
        type="button"
        @click=${(e: Event) => {
          e.stopPropagation();
          // 与 thinking popover 对齐：点击菜单外部即关闭（document 级监听，关闭即注销）
          if (plusMenuOpen) {
            closePlusMenu(props);
          } else {
            openPlusMenu(props);
          }
        }}
        data-tooltip=${t("chat.plusMenu")}
        ?disabled=${!props.connected}
        aria-expanded=${plusMenuOpen ? "true" : "false"}
      >
        ${icons.plus}
      </button>
      ${plusMenuOpen
        ? html`
            <div class="chat-plus__menu" @click=${(e: Event) => e.stopPropagation()}>
              <button class="chat-plus__item" type="button" @click=${() => {
                closePlusMenu(props);
                void openFilePicker();
              }}>
                <span class="chat-plus__item-icon">${icons.paperclip}</span>
                <span>${t("chat.plusAttachFile")}</span>
              </button>
              ${props.onListSkills
                ? html`
                  <button class="chat-plus__item ${skillPickerOpen ?"chat-plus__item--active" : ""}" type="button" @click=${() => {
                    if (skillPickerOpen) {
                      skillPickerOpen = false;
                      props.onRequestUpdate?.();
                    } else {
                      void openSkillPicker(props);
                    }
                  }}>
                    <span class="chat-plus__item-icon">${icons.puzzle}</span>
                    <span>${t("chat.plusSkill")}</span>
                  </button>
                `
                : nothing}
              <button class="chat-plus__item" type="button" @click=${() => {
                closePlusMenu(props);
                goalFormOpen = !goalFormOpen;
                goalDraft = props.goal?.objective ?? "";
                props.onRequestUpdate?.();
              }}>
                <span class="chat-plus__item-icon">${icons.brain}</span>
                <span>${t("chat.plusGoal")}</span>
              </button>
              <div class="chat-plus__divider" role="separator"></div>
              <div class="chat-plus__section">${t("chat.execMode")}</div>
              ${execModes.map(([value, label]) => html`
                <button
                  class="chat-plus__item chat-plus__item--mode ${execMode === value ?"chat-plus__item--active" : ""}"
                  type="button"
                  role="menuitemradio"
                  aria-checked=${execMode === value ? "true" : "false"}
                  @click=${() => {
                    props.onExecModeChange?.(value);
                    closePlusMenu(props);
                  }}
                >
                  <span class="chat-plus__item-icon">${execMode === value ? icons.check : nothing}</span>
                  <span>${label}</span>
                </button>
              `)}
            </div>
            ${renderSkillPicker(props)}
          `
        : nothing}
    </div>
  `;
}

function refreshCommandSuggestions(props: ChatProps, draft: string) {
  const m = /^\/(\S*)$/.exec(draft);
  if (!m || !props.commands?.length) {
    commandSuggestions = [];
    commandIndex = 0;
    return;
  }
  commandSuggestions = filterCommands(props.commands, m[1] ?? "");
  commandIndex = 0;
}

// 插入选中命令到 draft（光标在末尾）
function insertCommand(props: ChatProps, name: string) {
  // trimStart 避免 '/cmd arg' 拼接出双空格；无参数时保留一个尾随空格便于继续输入
  const rest = props.draft.replace(/^\/\S*/, "").trimStart();
  const next = rest ? `/${name} ${rest}` : `/${name} `;
  props.onDraftChange(next);
  commandSuggestions = [];
  commandIndex = 0;
}

// 渲染 / 命令建议浮层
function renderCommandSuggestions(props: ChatProps) {
  // 防御校验：发送后清空草稿 / 切会话 / 引用插入等程序化改 draft 的路径不触发
  // input 事件，过期建议不能继续浮在空输入框上（点了会把旧命令插进新草稿）
  if (!/^\/(\S*)$/.test(props.draft ?? "")) {
    return nothing;
  }
  if (commandSuggestions.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-cmd-suggest" role="listbox">
      ${commandSuggestions.map((cmdEntry, idx) => html`
        <button
          class="chat-cmd-suggest__item ${idx === commandIndex ?"chat-cmd-suggest__item--active" : ""}"
          type="button"
          role="option"
          ?aria-selected=${idx === commandIndex}
          @mousedown=${(e: Event) => {
            e.preventDefault();
            insertCommand(props, cmdEntry.name);
            props.onRequestUpdate?.();
          }}
        >
          <span class="chat-cmd-suggest__name">/${cmdEntry.name}</span>
          <span class="chat-cmd-suggest__desc">${resolveCommandDescription(cmdEntry)}</span>
          ${cmdEntry.acceptsArgs ? html`<span class="chat-cmd-suggest__args">…</span>` : nothing}
        </button>
      `)}
    </div>
  `;
}

// ── compose 主体：输入框 + 工具条（纯模板装配，事件全走 props 回调） ──
export function renderCompose(props: ChatProps, ctx: ComposeRenderContext) {
  return html`
    <div class="chat-compose">
      ${renderAttachmentPreview(props)}
      ${renderContextMeter(ctx.activeSession, props.dirtyMeterSessions)}
      <div class="field chat-compose__field">
        <span>${t("chat.messageLabel")}</span>
        <textarea
          ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement, true))}
          .value=${props.draft}
          dir=${detectTextDirection(props.draft)}
          @keydown=${(e: KeyboardEvent) => {
            // 程序化改 draft（引用消息/插入技能/发送清空）不触发 @input，过期建议
            // 须先作废——否则 Enter 会把 draft 替换成损坏文本（与下方
            // renderCommandSuggestions 的 /^\/(\S*)$/ 防御同款，两处缺一不可：
            // 那里管渲染浮层，这里管键盘拦截）。
            if (
              commandSuggestions.length > 0 &&
              !/^\/(\S*)$/.test(props.draft ?? "")
            ) {
              commandSuggestions = [];
              commandIndex = 0;
            }
            if (commandSuggestions.length > 0) {
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                const pick = commandSuggestions[commandIndex];
                if (pick) {
                  insertCommand(props, pick.name);
                  props.onRequestUpdate?.();
                }
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                commandIndex = (commandIndex + 1) % commandSuggestions.length;
                props.onRequestUpdate?.();
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                commandIndex = (commandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
                props.onRequestUpdate?.();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                commandSuggestions = [];
                props.onRequestUpdate?.();
                return;
              }
            }
            if (e.key !== "Enter") {
              return;
            }
            if (e.isComposing || e.keyCode === 229) {
              return;
            }
            if (e.shiftKey) {
              return;
            } // Allow Shift+Enter for line breaks
            // 断开时也不拦截：发送会走乐观入队（待发送，重连自动补发），
            // 输入框保持可编辑（见 handleSendChat 的 disconnected 分支）
            e.preventDefault();
            props.onSend();
          }}
          @input=${(e: Event) => {
            const target = e.target as HTMLTextAreaElement;
            adjustTextareaHeight(target);
            props.onDraftChange(target.value);
            refreshCommandSuggestions(props, target.value);
          }}
          @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
          placeholder=${ctx.composePlaceholder}
        ></textarea>
        ${renderCommandSuggestions(props)}
        <div class="chat-compose__toolbar">
          <div class="chat-compose__toolbar-left">
            ${renderPlusMenu(props)}
            ${props.thinkingToggleLevels && props.thinkingToggleLevels.length > 0
              ? html`
                  <div class="chat-compose__thinking">
                    <button
                      class="chat-compose__thinking-toggle ${props.thinkingToggleLevel && props.thinkingToggleLevel !=="off" ? "chat-compose__thinking-toggle--active" : ""}"
                      type="button"
                      data-tooltip=${t("chat.thinkingPicker")}
                      aria-label=${t("chat.thinkingPicker")}
                      ?disabled=${!props.connected}
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        // 二元模型（仅 关/开）：单击直接切换；多档模型：单击展开档位 popover
                        if (props.isBinaryThinking) {
                          props.onThinkingToggle?.();
                          return;
                        }
                        const el = (e.currentTarget as HTMLElement).closest(".chat-compose__thinking") as HTMLElement;
                        const popover = el?.querySelector(".chat-compose__thinking-popover") as HTMLElement | null;
                        if (!popover) return;
                        if (popover.classList.contains("chat-compose__thinking-popover--open")) {
                          closeThinkingPopover();
                        } else {
                          closeThinkingPopover(); // 清掉上一轮可能残留的监听
                          popover.classList.add("chat-compose__thinking-popover--open");
                          const container = el;
                          thinkingPopoverCloser = (ev: MouseEvent) => {
                            if (!container.contains(ev.target as Node)) closeThinkingPopover();
                          };
                          const closer = thinkingPopoverCloser;
                          requestAnimationFrame(() => {
                            if (thinkingPopoverCloser === closer) document.addEventListener("click", closer);
                          });
                        }
                      }}
                    >
                      ${icons.brain}
                      <span class="chat-compose__thinking-label">${thinkingLevelLabel(props.thinkingToggleLevel ?? "off")}</span>
                    </button>
                    ${!props.isBinaryThinking
                      ? html`<div class="chat-compose__thinking-popover">
                          ${props.thinkingToggleLevels!.map(level => html`
                            <button
                              class="chat-compose__thinking-option ${level === (props.thinkingToggleLevel ??"off") ? "chat-compose__thinking-option--selected" : ""}"
                              type="button"
                              @click=${(e: Event) => {
                                e.stopPropagation();
                                props.onThinkingLevelChange?.(level);
                                const popover = (e.currentTarget as HTMLElement).closest(".chat-compose__thinking-popover") as HTMLElement;
                                if (popover) popover.classList.remove("chat-compose__thinking-popover--open");
                              }}
                            >
                              <span class="chat-compose__thinking-option-check">${level === (props.thinkingToggleLevel ?? "off") ? icons.check : nothing}</span>
                              ${thinkingLevelLabel(level)}
                            </button>
                          `)}
                        </div>`
                      : nothing
                    }
                  </div>
                `
              : nothing
            }
            ${props.configuredModels && props.configuredModels.length >= 2
              ? html`
                <select
                  class="chat-compose__model-select"
                  .value=${ctx.modelSelectValue ?? ""}
                  @change=${(e: Event) => {
                    const val = (e.target as HTMLSelectElement).value;
                    props.onModelChange?.(val);
                  }}
                  ?disabled=${!props.connected}
                >
                  ${renderConfiguredModelOptions(props.configuredModels, loadModelOrg(), ctx.modelSelectValue || undefined, true)}
                  ${ctx.modelSelectValue !== null && !props.configuredModels.some((m) => m.key === ctx.modelSelectValue)
                    ? html`<option value=${ctx.modelSelectValue} selected>${ctx.modelSelectValue} · ${t("chat.model.sessionCurrent")}</option>`
                    : nothing}
                </select>
              `
                : props.configuredModels && props.configuredModels.length === 1
                  ? html`
                    <select class="chat-compose__model-select" disabled>
                      <option selected>${props.configuredModels[0].name}</option>
                    </select>
                  `
                  : nothing
              }
            <div class="chat-compose__branch">
              <button
                class="chat-compose__tool-btn"
                type="button"
                data-tooltip=${t("chat.branch.tooltip")}
                aria-label=${t("chat.branch.tooltip")}
                ?disabled=${!props.connected}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  const el = (e.currentTarget as HTMLElement).closest(".chat-compose__branch") as HTMLElement;
                  const popover = el.querySelector(".chat-compose__branch-popover") as HTMLElement | null;
                  if (!popover) return;
                  if (popover.classList.contains("chat-compose__branch-popover--open")) {
                    closeBranchPopover();
                  } else {
                    closeBranchPopover(); // 清掉上一轮可能残留的监听
                    popover.classList.add("chat-compose__branch-popover--open");
                    // 打开时拉取最新分支列表
                    props.onOpenSessionBranches?.();
                    const container = el;
                    branchPopoverCloser = (ev: MouseEvent) => {
                      if (!container.contains(ev.target as Node)) closeBranchPopover();
                    };
                    const closer = branchPopoverCloser;
                    requestAnimationFrame(() => {
                      if (branchPopoverCloser === closer) document.addEventListener("click", closer);
                    });
                  }
                }}
              >
                ${icons.history}
              </button>
              ${renderBranchPopover(props)}
            </div>
          </div>
          <div class="chat-compose__toolbar-right">
            ${
              // busy 时停止键与发送键并存（kimi web UI 契约）：发送=入队，不再被停止键替换
              ctx.showStop
                ? html`<button
                    class="chat-compose__send-btn"
                    ?disabled=${!props.connected || Boolean(props.abortPending)}
                    @click=${props.onAbort}
                    aria-label=${t("chat.stop")}
                    data-tooltip=${t("chat.stop")}
                  >${icons.stop}</button>`
                : nothing
            }
            <button
              class="chat-compose__send-btn"
              @click=${props.onSend}
              aria-label=${!props.connected ? t("chat.sendQueued") : ctx.isBusy ? t("chat.sendEnqueue") : t("chat.send")}
              data-tooltip=${!props.connected ? t("chat.sendQueued") : ctx.isBusy ? t("chat.sendEnqueue") : t("chat.send")}
            >${icons.arrowUp}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}
