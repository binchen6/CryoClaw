import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import { buildChatItemsMemoized, computeSessionFileChangesMemoized } from "./oc-chat-history.ts";
import type { FileChange } from "../chat/file-changes.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import {
  fetchTurnFileStats,
  summarizeTurnStats,
  turnStatsSignature,
  type TurnStatsLookup,
} from "../chat/turn-file-stats.ts";

/** 拉取行数统计的防抖：消息/可见数连续变化只在安静后拉一次 */
const STATS_DEBOUNCE_MS = 250;
/** 按签名缓存最近多少轮结果（回看上一轮时直接命中，不再打 git） */
const STATS_CACHE_LIMIT = 16;
const EMPTY_LOOKUP: TurnStatsLookup = { byPath: {}, complete: false };

type TurnStatsBridge = {
  gitChangeStats?: (cwd: string, paths: string[]) => Promise<{
    success?: boolean;
    data?: { stats?: unknown; truncated?: boolean };
    error?: string;
    message?: string;
  }>;
};

function statsBridge(): TurnStatsBridge | undefined {
  return (window as unknown as { cryoclaw?: TurnStatsBridge }).cryoclaw;
}

/** Shares the history memo; draft and stream frames do not rescan the transcript. */
@customElement("oc-turn-files")
export class OcTurnFiles extends LitElement {
  static properties = {
    messages: { attribute: false }, toolMessages: { attribute: false },
    visibleHistoryCount: { attribute: false }, gitAvailable: { attribute: false },
    workspacePath: { attribute: false },
    onOpenGit: { attribute: false }, onOpenFile: { attribute: false }, locale: { attribute: false },
    // 行数统计到达后递增：内部 lookup 不是响应式字段，靠它触发一次重渲染
    statsRevision: { attribute: false },
  };
  messages: unknown[] = []; toolMessages: unknown[] = []; visibleHistoryCount = 0;
  gitAvailable = false; locale = ""; workspacePath = "";
  onOpenGit?: () => void; onOpenFile?: (path: string) => void;
  statsRevision = 0;

  private statsLookup: TurnStatsLookup = EMPTY_LOOKUP;
  private statsSignature = "";
  private statsSeq = 0;
  private statsTimer: ReturnType<typeof setTimeout> | undefined;
  private statsCache = new Map<string, TurnStatsLookup>();

  createRenderRoot() { return this; }
  shouldUpdate(changed: Map<PropertyKey, unknown>) { return [...changed.keys()].some(key => key !== "onOpenGit" && key !== "onOpenFile"); }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown);
  }

  disconnectedCallback() {
    document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.removeEventListener("keydown", this.onDocumentKeyDown);
    this.cancelStatsTimer();
    // 组件销毁后在途响应不再落位（seq 前进即让旧响应过期）
    this.statsSeq += 1;
    super.disconnectedCallback();
  }

  private turnFilesDetails(): HTMLDetailsElement | null {
    return this.querySelector<HTMLDetailsElement>(".chat-turn-files");
  }

  private onDocumentPointerDown = (event: PointerEvent) => {
    const details = this.turnFilesDetails();
    if (!details?.open) return;
    if (event.target instanceof Node && details.contains(event.target)) return;
    details.open = false;
  };

  private onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const details = this.turnFilesDetails();
    if (!details?.open) return;
    details.open = false;
    details.querySelector<HTMLElement>("summary")?.focus();
  };

  // 触发拉取的条件：当前轮的改动列表或工作区/git 可用性变化，
  // visibleHistoryCount 变化说明本轮又有新消息（同一批文件可能被再次编辑，行数要刷新）。
  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    const triggers = ["messages", "toolMessages", "visibleHistoryCount", "workspacePath", "gitAvailable"];
    if (!triggers.some(key => changed.has(key))) return;
    this.refreshStats(this.currentTurn());
  }

  /** 当前轮（最后一个消息组）的改动文件与组键（组键随轮次变化，用于缓存签名） */
  private currentTurn(): { files: FileChange[]; key: string } {
    const items = buildChatItemsMemoized(this);
    const byGroup = computeSessionFileChangesMemoized(items);
    const latest = items.filter(item => item.kind === "group").at(-1);
    if (!latest) return { files: [], key: "" };
    return { files: byGroup.get(latest.key) ?? [], key: String(latest.key) };
  }

  private cancelStatsTimer(): void {
    if (this.statsTimer !== undefined) {
      clearTimeout(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  /** 签名变化时重置结果并在 250ms 安静后拉取；缓存命中直接复用 */
  private refreshStats(turn: { files: FileChange[]; key: string }): void {
    const paths = turn.files.map(file => file.path);
    const enabled = this.gitAvailable && Boolean(this.workspacePath) && paths.length > 0;
    // 组键 + visibleHistoryCount 一起进签名：同一批文件在后续消息里被再次编辑时重新统计
    const signature = enabled
      ? `${turnStatsSignature(this.workspacePath, paths)}\u0002${turn.key}\u0002${this.visibleHistoryCount}`
      : "";
    if (signature === this.statsSignature) return;
    this.statsSignature = signature;
    const seq = ++this.statsSeq;
    this.cancelStatsTimer();
    if (!enabled) {
      this.statsLookup = EMPTY_LOOKUP;
      return;
    }
    const cached = this.statsCache.get(signature);
    if (cached) {
      this.statsLookup = cached;
      return;
    }
    this.statsLookup = EMPTY_LOOKUP;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = undefined;
      void this.loadStats(signature, paths, seq);
    }, STATS_DEBOUNCE_MS);
  }

  private async loadStats(signature: string, paths: string[], seq: number): Promise<void> {
    const lookup = await fetchTurnFileStats(
      statsBridge()?.gitChangeStats,
      this.workspacePath,
      paths,
    );
    // 过期响应丢弃：签名/序号已变（切轮次、组件销毁、更新的请求）时不得覆盖
    if (seq !== this.statsSeq || signature !== this.statsSignature) return;
    this.rememberStats(signature, lookup);
    this.statsLookup = lookup;
    this.statsRevision += 1;
  }

  private rememberStats(signature: string, lookup: TurnStatsLookup): void {
    this.statsCache.delete(signature);
    this.statsCache.set(signature, lookup);
    while (this.statsCache.size > STATS_CACHE_LIMIT) {
      const oldest = this.statsCache.keys().next();
      if (oldest.done) break;
      this.statsCache.delete(oldest.value);
    }
  }

  /** 浮层单行右侧的该文件 +/− 行数；二进制与无统计时不显示 */
  private renderRowStat(file: FileChange): TemplateResult | typeof nothing {
    const stat = this.statsLookup.byPath[file.path];
    if (!stat || stat.binary) return nothing;
    const addedTitle = t("chat.fileChange.addedLines").replace("{n}", String(stat.additions));
    const deletedTitle = t("chat.fileChange.deletedLines").replace("{n}", String(stat.deletions));
    return html`<span class="chat-turn-files__row-stat">
      <span class="chat-turn-files__stat chat-turn-files__stat--added" title=${addedTitle}>+${stat.additions}</span>
      <span class="chat-turn-files__stat chat-turn-files__stat--deleted" title=${deletedTitle}>−${stat.deletions}</span>
    </span>`;
  }

  render() {
    const files = this.currentTurn().files;
    if (!files.length) return nothing;
    const summary = summarizeTurnStats(files, this.statsLookup);
    // 优先显示行数；无 git / 统计失败 / 结果不完整时退回新增/删除文件数，
    // 并用 title 说明降级原因，避免把「文件数」误读成「行数」。
    const additions = summary.lineStatsAvailable ? summary.additions : summary.addedFiles;
    const deletions = summary.lineStatsAvailable ? summary.deletions : summary.deletedFiles;
    const addedLabel = summary.lineStatsAvailable
      ? t("chat.fileChange.addedLines")
      : t("chat.fileChange.addedFiles");
    const deletedLabel = summary.lineStatsAvailable
      ? t("chat.fileChange.deletedLines")
      : t("chat.fileChange.deletedFiles");
    const addedTitle = addedLabel.replace("{n}", String(additions));
    const deletedTitle = deletedLabel.replace("{n}", String(deletions));
    const summaryTitle = summary.lineStatsAvailable
      ? `${addedTitle} · ${deletedTitle}`
      : `${t("chat.fileChange.linesUnavailable")} · ${addedTitle} · ${deletedTitle}`;
    return html`<details class="chat-turn-files">
      <summary title=${summaryTitle}>
        <span class="chat-turn-files__label">${t("chat.fileChanges").replace("{n}", String(files.length))}</span>
        <span class="chat-turn-files__stat chat-turn-files__stat--added" title=${addedTitle}>+${additions}</span>
        <span class="chat-turn-files__stat chat-turn-files__stat--deleted" title=${deletedTitle}>−${deletions}</span>
      </summary>
      <div class="chat-turn-files__popover">
        <div class="chat-turn-files__list">${files.map(file => html`<div class="chat-turn-files__row">
          <span class="chat-file-change__badge chat-file-change__badge--${file.kind}">${t(`chat.fileChange.${file.kind}`)}</span>
          <button type="button" class="chat-turn-files__path" title=${file.path} @click=${() => this.onOpenFile?.(file.path)}>${file.path}</button>
          ${this.renderRowStat(file)}
        </div>`)}</div>
        ${this.gitAvailable ? html`<button type="button" class="btn btn--sm" @click=${() => this.onOpenGit?.()}>${icons.diff}${t("chat.viewInGit")}</button>` : nothing}
      </div>
    </details>`;
  }
}
