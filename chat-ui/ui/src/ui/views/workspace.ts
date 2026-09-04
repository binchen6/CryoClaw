/**
 * 工作区页（R42 第二期，2026.9 视觉重写）—— IDE 式融合：左导航（仓库选择/文件树/
 * Git 变更节点/Worktrees 区块）+ resizable-divider 拖拽分隔 + 右主区
 * （文件预览：面包屑 + 内容 | Git 面板 slot）。纯渲染，状态在 controllers/workspace.ts
 * 与 app state；git/worktrees 内容以 slot 注入。
 */
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import {
  isTextFile,
  navigateWorkspaceUp,
  openWorkspaceDirectory,
  workspaceViewState,
} from "../controllers/workspace.ts";
import { t, tWithDetail } from "../i18n.ts";
import { icons } from "../icons.ts";
import "../components/resizable-divider.ts";

export type WorkspaceViewOptions = {
  gitSlot: TemplateResult;
  worktreesSlot: TemplateResult;
  onSelectGitNode: () => void;
  onOpenFiles: () => void;
  onRepoChange: (path: string) => void;
  /** 刷新文件树（重新执行 initWorkspace，由 app-workspace 注入） */
  onRefreshFiles: () => void;
  /** 打开工作区根目录（文件管理器，root 为 null 时 noop） */
  onOpenRootFolder: () => void;
  /** 逐项「在文件管理器中打开」（文件/目录项内联按钮） */
  onOpenItemFolder: (path: string) => void;
};

// 相对路径（面包屑展示）
function relativePath(root: string, current: string): string {
  if (!current.startsWith(root)) return current;
  return current.slice(root.length).replace(/^[/\\]/, "");
}

// 左导航拖拽调宽：splitRatio 既写到布局根 CSS 变量（视觉），也记在模块级变量里
// （Lit 重渲染会把 divider 属性重置回绑定值，模块变量保证二次拖拽不跳变）。
// 纯视觉状态，不进 store、不持久化。
let navSplitRatio = 0.26;

function handleNavResize(e: Event) {
  const ratio = (e as CustomEvent<{ splitRatio: number }>).detail?.splitRatio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return;
  navSplitRatio = ratio;
  const host = e.currentTarget as HTMLElement | null;
  const layout = host?.closest(".wk-layout") as HTMLElement | null;
  layout?.style.setProperty("--wk-nav-ratio", ratio.toFixed(4));
}

// 文件预览头部面包屑：根名 → 各级目录 → 当前文件名（强调）
function renderBreadcrumb(rootName: string, relPath: string, fullPath: string) {
  const segments = relPath.split(/[/\\]/).filter(Boolean);
  return html`
    <header class="wk-preview__header" title=${fullPath}>
      <span class="wk-preview__crumb">${rootName}</span>
      ${segments.map(
        (seg, i) => html`
          <span class="wk-preview__crumb-sep" aria-hidden="true">›</span>
          <span class="wk-preview__crumb ${i === segments.length - 1 ? "wk-preview__crumb--current" : ""}">${seg}</span>
        `,
      )}
    </header>
  `;
}

export function renderWorkspaceView(state: AppViewState, opts: WorkspaceViewOptions) {
  const ws = workspaceViewState;
  const isAtRoot = !ws.currentPath || !ws.root || ws.currentPath === ws.root;
  const relPath = ws.root && ws.selectedFile ? relativePath(ws.root, ws.selectedFile) : "";
  const rootName = ws.root?.split("/").pop() ?? "workspace";
  const canPreview = ws.selectedFileName ? isTextFile(ws.selectedFileName) : false;

  return html`
    <div class="wk-layout">
      <aside class="wk-nav">
        <select
          class="wk-nav__repo"
          .value=${state.gitRepoPath ?? ""}
          ?disabled=${state.gitRepoOptions.length === 0}
          @change=${(e: Event) => opts.onRepoChange((e.target as HTMLSelectElement).value)}
        >
          ${state.gitRepoOptions.map((o) => html`<option value=${o.path} ?selected=${o.path === state.gitRepoPath}>
            ${o.kind === "workspace" ? t("git.repoWorkspace") : `${t("git.repoWorktree")} · ${o.branch || o.path}`}
          </option>`)}
        </select>
        <div class="wk-nav__node ${ws.mode === "files" ? "active" : ""}" @click=${opts.onOpenFiles}>
          ${icons.folder}<span>${t("workspace.files")}</span>
          <span class="wk-nav__node-actions">
            <button class="wk-nav__icon-btn" type="button"
              data-tooltip=${t("workspace.refresh")} aria-label=${t("workspace.refresh")}
              @click=${(e: Event) => { e.stopPropagation(); opts.onRefreshFiles(); }}
            >${icons.refreshCw}</button>
            <button class="wk-nav__icon-btn" type="button"
              data-tooltip=${t("workspace.openRoot")} aria-label=${t("workspace.openRoot")}
              @click=${(e: Event) => { e.stopPropagation(); opts.onOpenRootFolder(); }}
            >${icons.folderOpen}</button>
          </span>
        </div>
        <div class="wk-nav__tree">
          ${!isAtRoot ? html`<div class="wk-nav__item wk-nav__item--back" @click=${() => navigateWorkspaceUp(state)}>..</div>` : nothing}
          ${ws.loading && ws.items.length === 0
            ? html`<div class="wk-nav__hint">${t("workspace.loading")}</div>`
            : ws.error && ws.items.length === 0
              ? html`<div class="wk-nav__hint">${ws.error}</div>`
              : ws.items.map((item) => html`
                  <div class="wk-nav__item ${item.isDir ? "wk-nav__item--dir" : ""} ${ws.selectedFile === item.path && ws.mode === "files" ? "active" : ""}"
                    @click=${() => openWorkspaceDirectory(state, item)}>
                    <span class="wk-nav__item-icon">${item.isDir ? icons.folder : icons.fileText}</span>
                    <span class="wk-nav__item-name" title=${item.name}>${item.name}</span>
                    <button class="wk-nav__item-action" type="button"
                      data-tooltip=${t("workspace.openFolder")} aria-label=${t("workspace.openFolder")}
                      @click=${(e: Event) => { e.stopPropagation(); opts.onOpenItemFolder(item.path); }}
                    >${icons.folderOpen}</button>
                  </div>`)}
        </div>
        <div class="wk-nav__node wk-nav__node--git ${ws.mode === "git" ? "active" : ""}" @click=${opts.onSelectGitNode}>
          ${icons.diff}<span>${t("git.title")}</span>
        </div>
        <section class="wk-nav__section">
          <div class="wk-nav__section-title">${t("worktrees.title")}</div>
          ${opts.worktreesSlot}
        </section>
      </aside>
      <resizable-divider
        .splitRatio=${navSplitRatio}
        .minRatio=${0.16}
        .maxRatio=${0.45}
        @resize=${handleNavResize}
      ></resizable-divider>
      <section class="wk-main">
        ${ws.mode === "git" ? opts.gitSlot : html`
          <div class="wk-preview">
            ${ws.selectedFile ? html`
              ${renderBreadcrumb(rootName, relPath, ws.selectedFile)}
              <div class="wk-preview__content">
                ${ws.fileLoading
                  ? html`<div class="wk-preview__placeholder">${t("workspace.loading")}</div>`
                  : ws.fileContent != null
                    ? html`<pre class="wk-preview__text">${ws.fileContent}</pre>`
                    : canPreview && ws.error
                      ? html`<div class="wk-preview__placeholder wk-preview__error">${tWithDetail("workspace.loadFailed", ws.error)}</div>`
                      : canPreview
                        ? html`<div class="wk-preview__placeholder">${t("workspace.loading")}</div>`
                        : html`<div class="wk-preview__placeholder">${t("workspace.noPreview")}</div>`}
              </div>`
            : html`<div class="wk-preview__empty panel__empty">
                <span class="panel__empty-icon wk-preview__empty-icon">${icons.fileText}</span>
                <span>${t("workspace.selectFile")}</span>
              </div>`}
          </div>`}
      </section>
    </div>
  `;
}
