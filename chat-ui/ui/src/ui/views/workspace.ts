/**
 * 工作区页（R42 第二期）—— IDE 式融合：左导航（仓库选择/文件树/Git 变更节点/
 * Worktrees 区块）+ 右主区（文件预览 | Git 面板 slot）。纯渲染，状态在
 * controllers/workspace.ts 与 app state；git/worktrees 内容以 slot 注入。
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

export type WorkspaceViewOptions = {
  gitSlot: TemplateResult;
  worktreesSlot: TemplateResult;
  onSelectGitNode: () => void;
  onOpenFiles: () => void;
  onRepoChange: (path: string) => void;
  /** worktree 区块节点点击 → 切换仓库上下文 + 右区切 git */
  onSelectWorktreeRepo: (path: string) => void;
};

// 相对路径（面包屑展示）
function relativePath(root: string, current: string): string {
  if (!current.startsWith(root)) return current;
  return current.slice(root.length).replace(/^[/\\]/, "");
}

export function renderWorkspaceView(state: AppViewState, opts: WorkspaceViewOptions) {
  const ws = workspaceViewState;
  const isAtRoot = !ws.currentPath || !ws.root || ws.currentPath === ws.root;
  const relPath = ws.root && ws.selectedFile ? relativePath(ws.root, ws.selectedFile) : "";
  const rootName = ws.root?.split("/").pop() ?? "workspace";
  const breadcrumb = relPath ? `${rootName}/${relPath}` : rootName;
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
      <section class="wk-main">
        ${ws.mode === "git" ? opts.gitSlot : html`
          <div class="wk-preview">
            ${ws.selectedFile ? html`
              <div class="wk-preview__header"><span title=${ws.selectedFile}>${breadcrumb}</span></div>
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
            : html`<div class="wk-preview__empty panel__empty"><span>${t("workspace.selectFile")}</span></div>`}
          </div>`}
      </section>
    </div>
  `;
}
