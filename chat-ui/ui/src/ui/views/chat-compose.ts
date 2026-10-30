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
import { adjustTextareaHeight } from "../utils/textarea-height.ts";
import { setComposeForToast } from "../toast-clearance.ts";
import type { GatewaySessionRow } from "../types.ts";
import { icons } from "../icons.ts";
import { t,getLocale } from "../i18n.ts";
import { detectTextDirection } from "../text-direction.ts";
import { resolveContextMeterStats } from "../context-meter.ts";
import { completeCommand, type CommandSuggestion } from "../chat/command-completion.ts";
import {
  goalStatusKey,
  goalStatusKind,
  goalSummaryText,
  goalTokenPercent,
  goalTokensLabel,
} from "../chat/goal-display.ts";
import "../components/oc-model-picker.ts";
import type { ChatProps } from "./chat.ts";
import {hydrateAttachmentThumbnails} from "../chat/attachment-thumbnails.ts";

// renderChat 已派生好的 compose 上下文（模型选择器/占位文案/忙碌态在装配层算好传入）
export type ComposeRenderContext = {
  activeSession: GatewaySessionRow | null | undefined;
  composePlaceholder: string;
  modelSelectValue: string | null;
  isBusy: boolean;
  showStop: boolean;
  allowEmptySend?: boolean;
};

// 加号菜单 / 目标表单本地状态（非响应式，渲染由 requestUpdate 驱动）
let plusMenuOpen = false;
let plusMenuLeaving = false;
let plusMenuEpoch = 0;
let goalFormOpen = false;
let goalDraft = "";

// Refresh on opening; late responses from closed menus must not cross sessions.
let skillPickerOpen = false;
let skillPickerLoading = false;
let skillPickerItems: Array<{ key: string; name: string; description?: string; emoji?: string }> = [];
let skillPickerGeneration = 0;
let skillPickerQuery = "";
let skillPickerIndex = 0;
let skillPickerError = false;

// 加号菜单「点击外部关闭」的 document 监听句柄；菜单关闭时必须同步注销，
// 否则监听会残留到下一次外部点击才被清掉（并持有过期 props 闭包）。
let plusMenuOutsideCloser: ((ev: MouseEvent) => void) | null = null;

// 思考档位 / 分支 popover 的「点击外部关闭」监听（模块级单例）。
// toggle 按钮本身 stopPropagation，document 点击永远看不到按钮点击——
// 若关闭分支不显式注销，每次 开→关→开 循环都会永久泄漏一个持有过期
// popover/el 闭包的 document 监听器。
let branchPopoverCloser: ((ev: MouseEvent) => void) | null = null;
// 分支 popover 的开关态镜像：面板开关是 DOM class，但 aria-expanded 必须随渲染更新，
// 否则读屏用户听不到「已展开」。Escape 与点选分支共用同一条关闭路径。
let branchPopoverOpen = false;
let branchPopoverEscape: ((ev: KeyboardEvent) => void) | null = null;

// 加号菜单的打开者：关闭后焦点回到真正触发它的按钮（加号 / 权限档位共用一个菜单），
// 而不是一律回加号——否则键盘用户从权限按钮打开后会被丢到别处。
let plusMenuOpener: HTMLElement | null = null;
let plusMenuEscape: ((ev: KeyboardEvent) => void) | null = null;

// popover 退场两段式：--open → --closing（播 chat-popover-out），
// --duration-fast(120ms) 后摘净。重开时清定时器 + 摘 --closing 防串场。
const POPOVER_EXIT_MS = 120;
const popoverExitTimers = new WeakMap<Element, number>();

function animatePopoverOut(el: Element, openClass: string, closingClass: string) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || el.classList.contains(closingClass)) {
    el.classList.remove(openClass, closingClass);
    return;
  }
  el.classList.remove(openClass);
  el.classList.add(closingClass);
  const prev = popoverExitTimers.get(el);
  if (prev != null) window.clearTimeout(prev);
  popoverExitTimers.set(
    el,
    window.setTimeout(() => {
      el.classList.remove(closingClass);
      popoverExitTimers.delete(el);
    }, POPOVER_EXIT_MS),
  );
}

function revivePopover(el: Element, closingClass: string) {
  const t = popoverExitTimers.get(el);
  if (t != null) {
    window.clearTimeout(t);
    popoverExitTimers.delete(el);
  }
  el.classList.remove(closingClass);
}

function closeBranchPopover(options: { restoreFocus?: boolean } = {}) {
  for (const el of document.querySelectorAll(".chat-compose__branch-popover--open")) {
    animatePopoverOut(el, "chat-compose__branch-popover--open", "chat-compose__branch-popover--closing");
  }
  const wasOpen = branchPopoverOpen;
  branchPopoverOpen = false;
  if (branchPopoverCloser) {
    document.removeEventListener("click", branchPopoverCloser);
    branchPopoverCloser = null;
  }
  if (branchPopoverEscape) {
    document.removeEventListener("keydown", branchPopoverEscape, true);
    branchPopoverEscape = null;
  }
  // 原路返回：关闭后焦点回到开启它的分支按钮，键盘用户不必重新 Tab 一遍。
  if (wasOpen && options.restoreFocus !== false) {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".chat-compose__branch .chat-compose__tool-btn")?.focus());
  }
}

/** 分支 popover 是否展开（渲染 aria-expanded 用）。 */
export function branchPopoverIsOpen() {
  return branchPopoverOpen;
}

let plusMenuAnimation:Animation|null=null;

function closePlusMenu(props: { onRequestUpdate?: () => void }, options: { restoreFocus?: boolean } = {}) {
  const epoch=++plusMenuEpoch;
  plusMenuAnimation?.cancel();plusMenuAnimation=null;
  const wasOpen=plusMenuOpen||plusMenuLeaving;
  plusMenuOpen = false;
  plusMenuLeaving = wasOpen;
  skillPickerOpen = false;
  skillPickerGeneration++;
  skillPickerLoading = false;
  if (plusMenuOutsideCloser) {
    document.removeEventListener("click", plusMenuOutsideCloser);
    plusMenuOutsideCloser = null;
  }
  if (plusMenuEscape) {
    document.removeEventListener("keydown", plusMenuEscape, true);
    plusMenuEscape = null;
  }
  const opener=plusMenuOpener;
  plusMenuOpener=null;
  props.onRequestUpdate?.();
  // 原路返回：焦点交回真正打开菜单的那个按钮（加号或权限档位）。
  if(wasOpen && options.restoreFocus !== false)requestAnimationFrame(()=>opener?.isConnected&&opener.focus());
  if(!wasOpen)return;
  requestAnimationFrame(()=>{
    const menu=document.querySelector<HTMLElement>('.chat-plus__menu');
    let exitTimer:number|undefined,finished=false;
    const finish=()=>{if(finished||epoch!==plusMenuEpoch)return;finished=true;if(exitTimer!==undefined)clearTimeout(exitTimer);plusMenuLeaving=false;plusMenuAnimation=null;props.onRequestUpdate?.();};
    if(!menu||matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
    plusMenuAnimation=menu.animate([{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(6px) scale(.98)'}],{duration:POPOVER_EXIT_MS,easing:'ease-in',fill:'forwards'});
    plusMenuAnimation.finished.then(finish).catch(finish);
    // Background windows may suspend WAAPI completion; cleanup still needs a bound.
    exitTimer=window.setTimeout(finish,POPOVER_EXIT_MS+50);
  });
}

function openPlusMenu(props: { onRequestUpdate?: () => void }, opener: HTMLElement | null = null) {
  document.dispatchEvent(new CustomEvent('cryoclaw:compose-other-menu'));
  closeBranchPopover({ restoreFocus: false });
  plusMenuEpoch++;
  plusMenuAnimation?.cancel();plusMenuAnimation=null;
  plusMenuLeaving=false;
  plusMenuOpen = true;
  plusMenuOpener = opener;
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
  // Esc 与「再点一次触发器」走同一条关闭路径：菜单开着时任何位置按 Esc 都收起菜单并回焦。
  if (!plusMenuEscape) {
    plusMenuEscape = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.isComposing) return;
      if (!plusMenuOpen) return;
      ev.preventDefault();
      ev.stopPropagation();
      closePlusMenu(props);
    };
    document.addEventListener("keydown", plusMenuEscape, true);
  }
  props.onRequestUpdate?.();
}

/** 加号菜单是否展开（渲染 aria-expanded 用）。 */
export function plusMenuIsOpen() {
  return plusMenuOpen;
}

/** 切会话复位 compose 全部模块级瞬态（renderChat 的 lastSessionKey 门控调用）。 */
export function resetComposeTransient(props: { onRequestUpdate?: () => void }) {
  closePlusMenu(props, { restoreFocus: false });
  closeBranchPopover({ restoreFocus: false });
  goalFormOpen = false;
  goalDraft = "";
  commandSuggestions = [];
  commandIndex = 0;
  commandDraft = null;
}

// / 命令补全状态
let commandSuggestions: CommandSuggestion[] = [];
let commandCaret = 0;
let commandFocused = false;
let commandComposing = false;
let commandIndex = 0;
let commandDraft:string|null=null;
let commandSource:ChatProps["commands"];

/**
 * Context Ring — 输入卡工具条右侧的小圆环，展示当前对话记忆占用。
 * 数据源：
 *   - used = session.totalTokens（最后一次调用的 prompt token 数，gateway 在
 *            turn 结束后持久化）
 *   - max  = session.contextTokens（gateway 按调用时用的模型写入的窗口大小）
 *            缺失时回退到 lookupContextWindow(session.model)，不跨会话信任 currentModel
 * 仅展示「当前会话」占用比例，跨会话独立；模型未知且 used>0 时整体隐藏。
 *
 * 模型切换：用户切完 model 后，该 sessionKey 会被加入 dirtyMeterSessions 集合，
 * 直到下一轮 usage（totalTokens 变化）落库才清除——天然 per-session 独立。
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

function renderContextRing(
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
  const tone = stats.ratio >= 0.9 ? "danger" : stats.ratio >= 0.7 ? "warn" : "ok";
  return html`
    <span
      class="chat-compose__ctx-ring"
      data-tone=${tone}
      data-tooltip=${title}
      data-tooltip-wide="true"
      role="progressbar"
      aria-label=${label}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${String(stats.percent)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle class="chat-compose__ctx-ring-track" cx="12" cy="12" r="10" pathLength="100"></circle>
        <circle class="chat-compose__ctx-ring-fill" cx="12" cy="12" r="10" pathLength="100" stroke-dasharray=${`${stats.widthPct} 100`}></circle>
        <text class="chat-compose__ctx-ring-center" x="12" y="12" text-anchor="middle" dominant-baseline="central">${stats.percent}</text>
      </svg>
    </span>
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
    if(props.onAttachmentsChange)hydrateAttachmentThumbnails(additions,props.onAttachmentsChange);
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
          <div class="chat-attachment ${att.filePath && !att.dataUrl && !att.thumbnailUrl ?"chat-attachment--file" : ""}">
            ${
              att.dataUrl || att.thumbnailUrl
                ? html`<img
                    src=${att.thumbnailUrl??att.dataUrl}
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
    <div class="chat-compose__branch-popover" role="menu" aria-label=${t("chat.branch.title")}>
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
                    @click=${() => {
                      props.onSwitchBranch?.(branch.leafEntryId);
                      // 选中即完成：收起 popover 并回焦触发按钮，否则面板悬在原处像「没生效」。
                      closeBranchPopover();
                    }}
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
  skillPickerQuery="";skillPickerIndex=0;skillPickerError=false;skillPickerItems=[];
  const generation=++skillPickerGeneration;
  requestAnimationFrame(()=>document.querySelector<HTMLInputElement>(".chat-plus__skill-search")?.focus());
  if (props.onListSkills) {
    skillPickerLoading = true;
    props.onRequestUpdate?.();
    try {
      const items = await props.onListSkills();
      if(generation!==skillPickerGeneration)return;
      skillPickerItems = items;
    } catch {
      if(generation!==skillPickerGeneration)return;
      skillPickerItems = [];
      skillPickerError=true;
    } finally {
      if(generation===skillPickerGeneration)skillPickerLoading = false;
    }
  }
  props.onRequestUpdate?.();
}

function closeSkillPicker(props:ChatProps) {
  skillPickerOpen=false;skillPickerGeneration++;skillPickerLoading=false;props.onRequestUpdate?.();
  requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('[data-skill-picker-trigger]')?.focus());
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
  closePlusMenu(props, { restoreFocus: false });
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
    const query=skillPickerQuery.trim().toLocaleLowerCase();
  const filtered=skillPickerItems.filter(skill=>`${skill.name} ${skill.description??""}`.toLocaleLowerCase().includes(query));
  skillPickerIndex=Math.max(0,Math.min(skillPickerIndex,filtered.length-1));
  return html`
    <div class="chat-plus__skill-picker" @click=${(e: Event) => e.stopPropagation()}
      @keydown=${(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeSkillPicker(props);}}}>
      <div class="chat-plus__skill-picker-title">${t("chat.plusSkillPickerTitle")}<button type="button" class="icon-btn icon-btn--sm" aria-label=${t("chat.skillPicker.close")} @click=${()=>closeSkillPicker(props)}>${icons.x}</button></div>
      <input class="chat-plus__skill-search" type="search" role="combobox" aria-label=${t("chat.skillPicker.search")} aria-autocomplete="list" aria-expanded="true" aria-controls="chat-skill-options" aria-activedescendant=${filtered.length?`chat-skill-option-${skillPickerIndex}`:nothing} placeholder=${t("chat.skillPicker.searchPlaceholder")} .value=${skillPickerQuery}
        @input=${(event:Event)=>{skillPickerQuery=(event.target as HTMLInputElement).value;skillPickerIndex=0;props.onRequestUpdate?.();}}
        @keydown=${(event:KeyboardEvent)=>{if(event.isComposing)return;if((event.key==="ArrowDown" || event.key==="ArrowUp") && filtered.length){event.preventDefault();skillPickerIndex=(skillPickerIndex+(event.key==="ArrowDown"?1:-1)+filtered.length)%filtered.length;props.onRequestUpdate?.();requestAnimationFrame(()=>document.getElementById(`chat-skill-option-${skillPickerIndex}`)?.scrollIntoView({block:"nearest"}));}else if(event.key==="Enter" && filtered.length){event.preventDefault();insertSkillReference(props,filtered[skillPickerIndex].name);}}} />
      <div class="chat-plus__skill-list" role="listbox" id="chat-skill-options" aria-label=${t("chat.plusSkillPickerTitle")} aria-busy=${skillPickerLoading}>
      ${skillPickerLoading
        ? html`<div class="chat-plus__skill-picker-status">${t("chat.loading")}</div>`
        : skillPickerError?html`<div class="chat-plus__skill-picker-status" role="alert">${t("chat.skillPicker.loadFailed")}<button class="btn btn--sm" @click=${()=>void openSkillPicker(props)}>${t("chat.skillPicker.retry")}</button></div>`
        : filtered.length === 0
          ? html`<div class="chat-plus__skill-picker-status" role="status">${query?t("chat.skillPicker.noMatches"):t("chat.plusSkillEmpty")}</div>`
          : filtered.map((skill,index) => html`
            <button class="chat-plus__skill-item" type="button" role="option" id=${`chat-skill-option-${index}`} aria-selected=${index===skillPickerIndex}
              @click=${() => insertSkillReference(props, skill.name)}>
              <span class="chat-plus__skill-item-name">${skill.emoji ? `${skill.emoji} ` : nothing}${skill.name}</span>
              ${skill.description
                ? html`<span class="chat-plus__skill-item-desc" title=${skill.description}>${skill.description}</span>`
                : nothing}
            </button>
          `)}
      </div>
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
  // 关闭一律走这里：Esc / 取消 / 提交同一条路径，并把焦点交回长得像「返回原地」的触发按钮。
  const closeGoalForm = (restoreFocus = true) => {
    goalFormOpen = false;
    goalDraft = "";
    props.onRequestUpdate?.();
    if (restoreFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(".chat-plus__trigger")?.focus());
  };
  return html`
    <div class="chat-goal-form"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        closeGoalForm();
      }}>
      <input
        class="chat-goal-form__input"
        type="text"
        .value=${goalDraft}
        placeholder=${t("goal.placeholder")}
        @input=${(e: Event) => { goalDraft = (e.target as HTMLInputElement).value; }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && goalDraft.trim()) {
            props.onGoalCommand?.(`/goal ${goalDraft.trim()}`);
            closeGoalForm(false);
          }
        }}
      />
      <button class="chat-goal-form__submit" type="button" ?disabled=${!goalDraft.trim()} @click=${() => {
        if (!goalDraft.trim()) return;
        props.onGoalCommand?.(`/goal ${goalDraft.trim()}`);
        closeGoalForm(false);
      }}>${t("goal.start")}</button>
      <button class="chat-goal-form__cancel" type="button" @click=${() => closeGoalForm()}>${t("chat.cancel")}</button>
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
      if(props.onAttachmentsChange)hydrateAttachmentThumbnails(additions,props.onAttachmentsChange);
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
            openPlusMenu(props, e.currentTarget as HTMLElement);
          }
        }}
        data-tooltip=${t("chat.plusMenu")}
        aria-label=${t("chat.plusMenu")}
        aria-haspopup="menu"
        ?disabled=${!props.connected}
        aria-expanded=${plusMenuOpen ? "true" : "false"}
      >
        ${icons.plus}
      </button>
      ${plusMenuOpen||plusMenuLeaving
        ? html`
            <div class="chat-plus__menu ${plusMenuLeaving?'chat-plus__menu--closing':''}" role="menu" aria-label=${t("chat.plusMenu")} ?inert=${plusMenuLeaving} @click=${(e: Event) => e.stopPropagation()}>
              <button class="chat-plus__item" type="button" @click=${() => {
                closePlusMenu(props);
                void openFilePicker();
              }}>
                <span class="chat-plus__item-icon">${icons.paperclip}</span>
                <span>${t("chat.plusAttachFile")}</span>
              </button>
              ${props.onListSkills
                ? html`
                  <button class="chat-plus__item ${skillPickerOpen ?"chat-plus__item--active" : ""}" type="button" data-skill-picker-trigger @click=${() => {
                    if (skillPickerOpen) {
                      closeSkillPicker(props);
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
                closePlusMenu(props, { restoreFocus: false });
                goalFormOpen = !goalFormOpen;
                goalDraft = props.goal?.objective ?? "";
                props.onRequestUpdate?.();
                // 表单从菜单里长出来：焦点跟着一起过去，否则 Esc/输入都要再点一次。
                requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".chat-goal-form__input")?.focus());
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
  commandDraft = draft; commandSource = props.commands;
  commandSuggestions = commandFocused && !commandComposing
    ? completeCommand(draft, commandCaret, props.commands ?? [], props.configuredModels ?? []) : [];
  commandIndex = 0;
}

// 插入选中命令到 draft（光标在末尾）
function insertCommand(props: ChatProps, suggestion: CommandSuggestion) {
  props.onDraftChange(suggestion.value);
  commandDraft = suggestion.value;
  commandCaret = suggestion.caret;
  commandSuggestions = [];
  commandIndex = 0;
  requestAnimationFrame(() => {
    const field = document.querySelector<HTMLTextAreaElement>(".chat-compose textarea");
    if (!field || field.value !== suggestion.value) return;
    field.focus(); field.setSelectionRange(suggestion.caret, suggestion.caret);
  });
}

// 渲染 / 命令建议浮层
function renderCommandSuggestions(props: ChatProps) {
  // 防御校验：发送后清空草稿 / 切会话 / 引用插入等程序化改 draft 的路径不触发
  // input 事件，过期建议不能继续浮在空输入框上（点了会把旧命令插进新草稿）
  if (commandDraft !== props.draft) {
    return nothing;
  }
  if (commandSuggestions.length === 0) {
    return nothing;
  }
  return html`
    <div id="chat-command-options" class="chat-cmd-suggest" role="listbox" aria-label=${getLocale().startsWith("zh")?"命令候选":"Command suggestions"}>
      ${commandSuggestions.map((cmdEntry, idx) => html`
        <button
          class="chat-cmd-suggest__item ${idx === commandIndex ?"chat-cmd-suggest__item--active" : ""}"
          type="button"
          role="option"
          id=${`chat-command-option-${idx}`}
          aria-selected=${idx === commandIndex ? "true" : "false"}
          @mousedown=${(e: Event) => {
            e.preventDefault();
          }}
          @click=${() => {
            insertCommand(props, cmdEntry);
            props.onRequestUpdate?.();
          }}
        >
          <span class="chat-cmd-suggest__name">${cmdEntry.label}</span>
          <span class="chat-cmd-suggest__desc">${cmdEntry.description}</span>
        </button>
      `)}
    </div>
  `;
}

// ── compose 主体：输入框 + 工具条（纯模板装配，事件全走 props 回调） ──
export function renderCompose(props: ChatProps, ctx: ComposeRenderContext) {
  if(commandDraft!==props.draft || commandSource!==props.commands)refreshCommandSuggestions(props,props.draft??"");
  const canSend=ctx.allowEmptySend||Boolean(props.draft.trim())||Boolean(props.attachments?.length);
  const execMode=props.execMode??'ask';
  const execLabel=execMode==='auto'?t('chat.execModeAuto'):execMode==='full'?t('chat.execModeApproveAll'):t('chat.execModeAsk');
  return html`
    <div class="chat-compose"
      ${ref(setComposeForToast)}
      @cryoclaw:compose-menu=${()=>{closePlusMenu(props,{restoreFocus:false});closeBranchPopover({restoreFocus:false});}}
      @dragenter=${(event:DragEvent)=>{if(!event.dataTransfer?.types.includes("Files"))return;const root=event.currentTarget as HTMLElement;root.dataset.dragDepth=String(Number(root.dataset.dragDepth??0)+1);root.dataset.fileDrag="true";}}
      @dragover=${(event:DragEvent)=>{if(event.dataTransfer?.types.includes("Files")){event.preventDefault();event.dataTransfer.dropEffect="copy";}}}
      @dragleave=${(event:DragEvent)=>{const root=event.currentTarget as HTMLElement;const depth=Math.max(0,Number(root.dataset.dragDepth??0)-1);root.dataset.dragDepth=String(depth);if(!depth)delete root.dataset.fileDrag;}}
      @drop=${(event:DragEvent)=>{const root=event.currentTarget as HTMLElement;delete root.dataset.fileDrag;delete root.dataset.dragDepth;}}>
      <div class="chat-compose__drop-hint" role="status">${getLocale().startsWith("zh")?"松开鼠标，将文件添加到当前会话":"Drop to attach files to this conversation"}</div>
      ${renderAttachmentPreview(props)}
      <div class="field chat-compose__field">
        <span>${t("chat.messageLabel")}</span>
        <textarea
          ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement, true))}
          .value=${props.draft}
          dir=${detectTextDirection(props.draft)}
          aria-autocomplete="list"
          aria-controls="chat-command-options"
          aria-activedescendant=${commandSuggestions.length?`chat-command-option-${commandIndex}`:nothing}
          @keydown=${(e: KeyboardEvent) => {
            // IME owns its candidate keys before either completion or send handles them.
            if(e.defaultPrevented || e.isComposing || e.keyCode===229)return;
            // 程序化改 draft（引用消息/插入技能/发送清空）不触发 @input，过期建议
            // 须先作废——否则 Enter 会把 draft 替换成损坏文本（与下方
            // renderCommandSuggestions 的 /^\/(\S*)$/ 防御同款，两处缺一不可：
            // 那里管渲染浮层，这里管键盘拦截）。
            if (
              commandSuggestions.length > 0 &&
              (commandDraft !== props.draft || (e.currentTarget as HTMLTextAreaElement).selectionStart !== commandCaret || (e.currentTarget as HTMLTextAreaElement).selectionStart !== (e.currentTarget as HTMLTextAreaElement).selectionEnd)
            ) {
              commandSuggestions = [];
              commandIndex = 0;
            }
            if (commandSuggestions.length > 0) {
              if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
                e.preventDefault();
                const pick = commandSuggestions[commandIndex];
                if (pick) {
                  insertCommand(props, pick);
                  props.onRequestUpdate?.();
                }
                return;
              }
              if (e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                commandIndex = (commandIndex + 1) % commandSuggestions.length;
                props.onRequestUpdate?.();
                return;
              }
              if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
            // Enter stays a native line break, including while completing commands.
            if(e.key!=="Enter" || !(e.ctrlKey||e.metaKey) || e.shiftKey || e.altKey || e.repeat)return;
            e.preventDefault();
            if(canSend)props.onSend();
          }}
          @input=${(e: Event) => {
            const target = e.target as HTMLTextAreaElement;
            adjustTextareaHeight(target);
            commandCaret = target.selectionStart;
            commandFocused = true;
            props.onDraftChange(target.value);
            refreshCommandSuggestions(props, target.value);
            props.onRequestUpdate?.();
          }}
          @keyup=${(e: KeyboardEvent) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            const field = e.target as HTMLTextAreaElement;
            commandCaret = field.selectionStart;
            refreshCommandSuggestions(props, field.selectionStart === field.selectionEnd ? field.value : "");
            props.onRequestUpdate?.();
          }}
          @focus=${(e: FocusEvent) => { commandFocused = true; commandCaret = (e.target as HTMLTextAreaElement).selectionStart; refreshCommandSuggestions(props, props.draft); props.onRequestUpdate?.(); }}
          @blur=${() => { commandFocused = false; commandSuggestions = []; props.onRequestUpdate?.(); }}
          @click=${(e: MouseEvent) => { const field = e.target as HTMLTextAreaElement; commandCaret = field.selectionStart; refreshCommandSuggestions(props, field.selectionStart === field.selectionEnd ? field.value : ""); props.onRequestUpdate?.(); }}
          @compositionstart=${() => { commandComposing = true; commandSuggestions = []; props.onRequestUpdate?.(); }}
          @compositionend=${(e: CompositionEvent) => { commandComposing = false; const field = e.target as HTMLTextAreaElement; commandCaret = field.selectionStart; refreshCommandSuggestions(props, field.value); props.onRequestUpdate?.(); }}
          @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
          placeholder=${ctx.composePlaceholder}
        ></textarea>
        ${renderCommandSuggestions(props)}
        <div class="chat-compose__toolbar">
          <div class="chat-compose__toolbar-left">
            ${renderPlusMenu(props)}
            <oc-model-picker .props=${props} .value=${ctx.modelSelectValue}></oc-model-picker>
            ${['ask','auto','full'].includes(execMode)?html`<button class="chat-compose__permission chat-compose__permission--${execMode}" type="button" aria-label=${`${t('chat.execMode')}: ${execLabel}`} data-tooltip=${`${t('chat.execMode')}: ${execLabel}`} aria-haspopup="menu" aria-expanded=${plusMenuOpen ? "true" : "false"} ?disabled=${!props.connected} @click=${(event:Event)=>{event.stopPropagation();if(plusMenuOpen)closePlusMenu(props);else openPlusMenu(props,event.currentTarget as HTMLElement);}}>${icons.shieldCheck}<span>${execLabel}</span></button>`:nothing}
          </div>
          <div class="chat-compose__toolbar-right">
            <div class="chat-compose__branch">
              <button
                class="chat-compose__tool-btn"
                type="button"
                data-tooltip=${t("chat.branch.tooltip")}
                aria-label=${t("chat.branch.tooltip")}
                aria-haspopup="menu"
                aria-expanded=${branchPopoverOpen ? "true" : "false"}
                ?disabled=${!props.connected}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  const el = (e.currentTarget as HTMLElement).closest(".chat-compose__branch") as HTMLElement;
                  const popover = el.querySelector(".chat-compose__branch-popover") as HTMLElement | null;
                  if (!popover) return;
                  if (popover.classList.contains("chat-compose__branch-popover--open")) {
                    closeBranchPopover();
                  } else {
                    closePlusMenu(props, { restoreFocus: false });
                    closeBranchPopover({ restoreFocus: false });
                    revivePopover(popover, "chat-compose__branch-popover--closing");
                    popover.classList.add("chat-compose__branch-popover--open");
                    branchPopoverOpen = true;
                    props.onRequestUpdate?.();
                    props.onOpenSessionBranches?.();
                    const container = el;
                    branchPopoverCloser = (ev: MouseEvent) => {
                      if (!container.contains(ev.target as Node)) closeBranchPopover();
                    };
                    const closer = branchPopoverCloser;
                    requestAnimationFrame(() => {
                      if (branchPopoverCloser === closer) document.addEventListener("click", closer);
                    });
                    // 分支 popover 与其它浮层同一套 Esc 语义：任何位置按 Esc 收起并回焦。
                    if (!branchPopoverEscape) {
                      branchPopoverEscape = (ev: KeyboardEvent) => {
                        if (ev.key !== "Escape" || ev.isComposing || !branchPopoverOpen) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        closeBranchPopover();
                      };
                      document.addEventListener("keydown", branchPopoverEscape, true);
                    }
                  }
                }}
              >
                ${icons.history}
              </button>
              ${renderBranchPopover(props)}
            </div>
            <span class="chat-compose__toolbar-divider" aria-hidden="true"></span>
            ${renderContextRing(ctx.activeSession, props.dirtyMeterSessions)}
            ${
              // busy 时停止键与发送键并存（kimi web UI 契约）：发送=入队，不再被停止键替换
              ctx.showStop
                ? html`<button
                    class="chat-compose__send-btn chat-compose__send-btn--stop"
                    type="button"
                    ?disabled=${!props.connected || Boolean(props.abortPending)}
                    @click=${()=>props.onAbort?.()}
                    aria-busy=${Boolean(props.abortPending)}
                    aria-label=${props.abortPending?t("chat.stopping"):t("chat.stop")}
                    data-tooltip=${props.abortPending?t("chat.stopping"):t("chat.stop")}
                  ><span class="chat-compose__stop-icon" aria-hidden="true"></span></button>`
                : nothing
            }
            <button
              class="chat-compose__send-btn chat-compose__send-btn--send ${canSend?'is-ready':''}"
              type="button"
              ?disabled=${!canSend}
              @click=${()=>{if(canSend)props.onSend();}}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              aria-label=${!props.connected ? t("chat.sendQueued") : ctx.isBusy ? t("chat.sendEnqueue") : t("chat.send")}
              data-tooltip=${`${!props.connected ? t("chat.sendQueued") : ctx.isBusy ? t("chat.sendEnqueue") : t("chat.send")} · ${t("chat.sendShortcut")}`}
            >${icons.arrowUp}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}
