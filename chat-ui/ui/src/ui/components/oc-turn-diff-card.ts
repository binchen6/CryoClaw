import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import type { FileChange } from "../chat/file-changes.ts";
import { fileChangeBaseName } from "../chat/file-changes.ts";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import {
  fetchTurnFileStats,
  summarizeTurnStats,
  turnStatsSignature,
  type TurnStatsLookup,
} from "../chat/turn-file-stats.ts";

/** 拉取行数统计的防抖：同轮文件列表连续变化只在安静后拉一次 */
const STATS_DEBOUNCE_MS = 250;
/** 按签名缓存最近多少组结果（模块级共享：同会话多组卡片/重挂载直接命中，不打重复 git） */
const STATS_CACHE_LIMIT = 16;
/** 文件列表折叠态默认显示行数，超出收进「再显示 N 个文件」 */
const COLLAPSED_FILE_ROWS = 3;
const EMPTY_LOOKUP: TurnStatsLookup = { byPath: {}, complete: false };

// 模块级共享缓存（key = workspacePath + 路径列表签名）：终态卡片按组渲染，
// 同一会话可能同时存在多张；历史 hydration 重建时卡片重挂载，实例级缓存会
// 全部 miss，共享缓存让重挂载直接复用上次结果。
const statsCache = new Map<string, TurnStatsLookup>();

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

/**
 * 终态「本轮改动」卡片（组底部，对齐 Kimi CLI 样式）：头部「已编辑 N 个文件
 * +x −y」+「撤销」「查看变更」按钮，文件列表默认前 3 行（每行 basename +
 * 该文件 +/−，完整路径放 title）。执行期间不渲染——由 <oc-turn-files> 悬浮
 * 胶囊接力；run 终态后胶囊消失、卡片接管。
 *
 * 无 shadow DOM（同 oc-turn-files）：路径点击/「查看变更」复用 .chat-thread
 * 上的既有事件委托（.chat-path-link / .chat-git-view-link 的 click+keydown
 * 分支），卡片本体只负责「撤销」回调（须携带 files，走属性传入）。
 */
@customElement("oc-turn-diff-card")
export class OcTurnDiffCard extends LitElement {
  static properties = {
    files: { attribute: false }, workspacePath: { attribute: false },
    gitAvailable: { attribute: false }, locale: { attribute: false },
    onDiscard: { attribute: false },
    // 行数统计到达后递增：内部 lookup 不是响应式字段，靠它触发一次重渲染
    statsRevision: { attribute: false },
  };
  files: FileChange[] = []; workspacePath = ""; gitAvailable = false; locale = "";
  onDiscard?: (files: FileChange[]) => void | Promise<void>;
  statsRevision = 0;

  private statsLookup: TurnStatsLookup = EMPTY_LOOKUP;
  private statsSignature = "";
  private statsSeq = 0;
  private statsTimer: ReturnType<typeof setTimeout> | undefined;
  private expanded = false;
  private undoing = false;

  createRenderRoot() { return this; }
  // 回调每帧新闭包（buildChatProps），放行会让无关更新重渲染整棵历史子树
  shouldUpdate(changed: Map<PropertyKey, unknown>) { return [...changed.keys()].some(key => key !== "onDiscard"); }

  disconnectedCallback() {
    this.cancelStatsTimer();
    // 组件销毁后在途响应不再落位（seq 前进即让旧响应过期）
    this.statsSeq += 1;
    super.disconnectedCallback();
  }

  // 触发拉取的条件：本组改动列表或工作区/git 可用性变化
  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    const triggers = ["files", "workspacePath", "gitAvailable"];
    if (!triggers.some(key => changed.has(key))) return;
    this.refreshStats();
  }

  private cancelStatsTimer(): void {
    if (this.statsTimer !== undefined) {
      clearTimeout(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  /** 签名变化时重置结果并在 250ms 安静后拉取；共享缓存命中直接复用 */
  private refreshStats(): void {
    const paths = this.files.map(file => file.path);
    const enabled = this.gitAvailable && Boolean(this.workspacePath) && paths.length > 0;
    const signature = enabled ? turnStatsSignature(this.workspacePath, paths) : "";
    if (signature === this.statsSignature) return;
    this.statsSignature = signature;
    const seq = ++this.statsSeq;
    this.cancelStatsTimer();
    if (!enabled) {
      this.statsLookup = EMPTY_LOOKUP;
      return;
    }
    const cached = statsCache.get(signature);
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
    // 过期响应丢弃：签名/序号已变（组件销毁、更新的请求）时不得覆盖
    if (seq !== this.statsSeq || signature !== this.statsSignature) return;
    rememberStats(signature, lookup);
    this.statsLookup = lookup;
    this.statsRevision += 1;
  }

  /** 行内该文件 +/− 行数；二进制与无统计时不显示 */
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

  private async onUndoClick(): Promise<void> {
    if (this.undoing || !this.onDiscard) return;
    this.undoing = true;
    this.requestUpdate();
    try {
      await this.onDiscard(this.files);
    } finally {
      this.undoing = false;
      this.requestUpdate();
    }
  }

  render() {
    const files = this.files;
    if (!files.length) return nothing;
    const summary = summarizeTurnStats(files, this.statsLookup);
    // 优先显示行数；无 git / 统计失败 / 结果不完整时退回新增/删除文件数，
    // 并用 title 说明降级原因，避免把「文件数」误读成「行数」。
    const lineStats = summary.lineStatsAvailable;
    const additions = lineStats ? summary.additions : summary.addedFiles;
    const deletions = lineStats ? summary.deletions : summary.deletedFiles;
    const addedLabel = lineStats ? t("chat.fileChange.addedLines") : t("chat.fileChange.addedFiles");
    const deletedLabel = lineStats ? t("chat.fileChange.deletedLines") : t("chat.fileChange.deletedFiles");
    const addedTitle = addedLabel.replace("{n}", String(additions));
    const deletedTitle = deletedLabel.replace("{n}", String(deletions));
    const headerTitle = lineStats
      ? `${addedTitle} · ${deletedTitle}`
      : `${t("chat.fileChange.linesUnavailable")} · ${addedTitle} · ${deletedTitle}`;
    const visibleFiles = this.expanded ? files : files.slice(0, COLLAPSED_FILE_ROWS);
    const hiddenCount = files.length - visibleFiles.length;
    return html`<div class="chat-turn-diff-card">
      <div class="chat-turn-diff-card__head">
        <span class="chat-turn-diff-card__icon" aria-hidden="true">${icons.diff}</span>
        <span class="chat-turn-diff-card__title" title=${headerTitle}>${t("chat.editedFiles").replace("{n}", String(files.length))}</span>
        <span class="chat-turn-diff-card__stats">
          <span class="chat-turn-files__stat chat-turn-files__stat--added" title=${addedTitle}>+${additions}</span>
          <span class="chat-turn-files__stat chat-turn-files__stat--deleted" title=${deletedTitle}>−${deletions}</span>
        </span>
        ${this.gitAvailable
          ? html`<span class="chat-turn-diff-card__actions">
              <button
                type="button"
                class="btn btn--sm chat-turn-diff-card__undo"
                ?disabled=${this.undoing}
                @click=${() => void this.onUndoClick()}
              >${icons.rotateCcw}${t("chat.undoChanges")}</button>
              <a class="chat-git-view-link" tabindex="0" role="button">${icons.diff} ${t("chat.viewChanges")}</a>
            </span>`
          : nothing}
      </div>
      <div class="chat-turn-diff-card__list">
        ${visibleFiles.map(file => html`<div class="chat-turn-diff-card__row">
          <a
            class="chat-path-link chat-turn-diff-card__path"
            data-path=${file.path}
            title=${file.path}
            tabindex="0"
            role="button"
          >${fileChangeBaseName(file.path)}</a>
          ${this.renderRowStat(file)}
        </div>`)}
      </div>
      ${hiddenCount > 0
        ? html`<button
            type="button"
            class="chat-turn-diff-card__more"
            @click=${() => {
              this.expanded = true;
              this.requestUpdate();
            }}
          >${t("chat.showMoreFiles").replace("{n}", String(hiddenCount))}</button>`
        : nothing}
    </div>`;
  }
}

function rememberStats(signature: string, lookup: TurnStatsLookup): void {
  statsCache.delete(signature);
  statsCache.set(signature, lookup);
  while (statsCache.size > STATS_CACHE_LIMIT) {
    const oldest = statsCache.keys().next();
    if (oldest.done) break;
    statsCache.delete(oldest.value);
  }
}
