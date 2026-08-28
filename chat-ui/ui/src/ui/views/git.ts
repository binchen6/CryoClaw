/**
 * Git 面板视图（P4，文件级 v1）—— staged/unstaged/untracked 分组 + 单栏 diff + 提交框。
 * 范式同 views/worktrees.ts：纯渲染 + props 回调；样式 gitp-*（misc.css，全 token）。
 */
import { html, nothing } from "lit";
import {
  gitFileKey,
  groupGitEntries,
  type DiffFile,
  type GitRepoOption,
  type GitStatusEntry,
} from "../controllers/git.ts";
import { icons } from "../icons.ts";
import { t, tWithDetail } from "../i18n.ts";

export type GitPanelProps = {
  gitAvailable: boolean | null;
  connected: boolean;
  repoOptions: GitRepoOption[];
  repoPath: string | null;
  loading: boolean;
  repoState: "ok" | "no-git" | "not-a-repo" | null;
  errorKind: "identity" | "generic" | null;
  errorDetail: string | null;
  status: import("../controllers/git.ts").GitStatusResult | null;
  selectedFile: string | null;
  diffFiles: DiffFile[] | null;
  diffLoading: boolean;
  /** status/diff 被主进程截断（buffer 上限）时显示提示行 */
  statusTruncated: boolean;
  diffTruncated: boolean;
  busyPaths: ReadonlySet<string>;
  commitMessage: string;
  committing: boolean;
  onRepoChange: (path: string) => void;
  onRefresh: () => void;
  onSelectFile: (side: "cached" | "worktree", path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
};

// 状态字母着色类：M 修改 / A 新增 / D 删除 / R 重命名 / U 冲突 / ? 未跟踪
function statusLetterClass(letter: string): string {
  switch (letter) {
    case "A":
      return "gitp-letter--added";
    case "D":
      return "gitp-letter--deleted";
    case "R":
      return "gitp-letter--renamed";
    case "U":
      return "gitp-letter--conflict";
    case "?":
      return "gitp-letter--untracked";
    default:
      return "gitp-letter--modified";
  }
}

function renderDiff(props: GitPanelProps) {
  if (props.diffLoading) {
    return html`<div class="gitp-diff__placeholder">${icons.loader} ${t("git.diffLoading")}</div>`;
  }
  const files = props.diffFiles;
  if (!files || files.length === 0) {
    return html`<div class="gitp-diff__placeholder">${t("git.diffEmpty")}</div>`;
  }
  return html`
    ${props.diffTruncated
      ? html`<div class="gitp-diff__placeholder gitp-diff__truncated">${t("git.diffTruncated")}</div>`
      : nothing}
    ${files.map((f) => {
    const displayPath = f.newPath ?? f.oldPath ?? "";
    return html`
      <div class="gitp-diff-file">
        <div class="gitp-diff-file__path" title=${displayPath}>
          ${f.isRename && f.oldPath ? html`${f.oldPath} → ${f.newPath}` : displayPath}
        </div>
        ${f.isBinary
          ? html`<div class="gitp-diff__placeholder">${t("git.diffBinary")}</div>`
          : f.hunks.length === 0
            ? html`<div class="gitp-diff__placeholder">${t("git.diffEmpty")}</div>`
            : html`
                <pre class="gitp-diff__body">${f.hunks.map(
                  (h) => html`
                    <div class="gitp-diff__hunk-header">${h.header}</div>
                    ${h.lines.map(
                      (line) => html`
                        <div class="gitp-diff__line gitp-diff__line--${line.kind}"
                          ><span class="gitp-diff__sign">${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}</span
                          >${line.text}${line.noNewlineAfter
                            ? html`<span class="gitp-diff__nonewline">⏎ ${t("git.noNewline")}</span>`
                            : nothing}</div
                        >
                      `,
                    )}
                  `,
                )}</pre>
              `}
      </div>
    `;
    })}
  `;
}

function renderFileRow(
  props: GitPanelProps,
  entry: GitStatusEntry,
  group: "staged" | "unstaged" | "untracked",
) {
  const letter =
    group === "staged" ? entry.index : group === "unstaged" ? entry.worktree : "?";
  const side = group === "staged" ? "cached" : "worktree";
  const key = gitFileKey(side, entry.path);
  const selected = props.selectedFile === key;
  const busy = props.busyPaths.has(entry.path);
  const canShowDiff = group !== "untracked"; // untracked 无 diff 可看（git diff 不含未跟踪文件）
  return html`
    <div class="gitp-file ${selected ? "active" : ""}">
      <div
        class="gitp-file__main ${canShowDiff ? "gitp-file__main--clickable" : ""}"
        @click=${() => {
          if (canShowDiff) props.onSelectFile(side, entry.path);
        }}
      >
        <span class="gitp-letter ${statusLetterClass(letter)}">${letter}</span>
        <span class="gitp-file__path" title=${entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}>
          ${entry.origPath ? html`${entry.origPath} → ${entry.path}` : entry.path}
        </span>
        <button
          class="btn btn--sm gitp-file__action"
          type="button"
          ?disabled=${busy}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (group === "staged") props.onUnstage([entry.path]);
            else props.onStage([entry.path]);
          }}
        >
          ${busy ? icons.loader : nothing}
          ${group === "staged" ? t("git.unstage") : t("git.stage")}
        </button>
      </div>
      ${selected ? html`<div class="gitp-diff">${renderDiff(props)}</div>` : nothing}
    </div>
  `;
}

function renderGroup(
  props: GitPanelProps,
  group: "staged" | "unstaged" | "untracked",
  entries: GitStatusEntry[],
) {
  if (entries.length === 0) return nothing;
  const titleKey =
    group === "staged" ? "git.staged" : group === "unstaged" ? "git.unstaged" : "git.untracked";
  const allPaths = entries.map((e) => e.path);
  const anyBusy = allPaths.some((p) => props.busyPaths.has(p));
  return html`
    <section class="gitp-group">
      <div class="gitp-group__header">
        <h3 class="gitp-group__title">${t(titleKey)} <span class="gitp-group__count">${entries.length}</span></h3>
        ${group === "staged"
          ? html`<button class="btn btn--sm" type="button" ?disabled=${anyBusy} @click=${() => props.onUnstage(allPaths)}>
              ${t("git.unstageAll")}
            </button>`
          : html`<button class="btn btn--sm" type="button" ?disabled=${anyBusy} @click=${() => props.onStage(allPaths)}>
              ${t("git.stageAll")}
            </button>`}
      </div>
      <div class="gitp-group__list">
        ${entries.map((e) => renderFileRow(props, e, group))}
      </div>
    </section>
  `;
}

function renderCommitBox(props: GitPanelProps, stagedCount: number) {
  if (stagedCount === 0) return nothing;
  return html`
    <section class="gitp-commit">
      <h3 class="gitp-group__title">${t("git.commitTitle")}</h3>
      <textarea
        class="gitp-commit__input"
        rows="3"
        placeholder=${t("git.commitPlaceholder")}
        .value=${props.commitMessage}
        ?disabled=${props.committing}
        @input=${(e: Event) => props.onCommitMessageChange((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <div class="gitp-commit__actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${props.committing || !props.commitMessage.trim()}
          @click=${props.onCommit}
        >
          ${props.committing ? icons.loader : icons.check}
          ${props.committing ? t("git.committing") : t("git.commit")}
        </button>
      </div>
    </section>
  `;
}

export function renderGitPanel(props: GitPanelProps, opts?: { showRepoSelect?: boolean }) {
  const groups = props.status ? groupGitEntries(props.status.entries) : null;
  const branch = props.status?.branch ?? null;
  const hasChanges =
    !!groups && (groups.staged.length > 0 || groups.unstaged.length > 0 || groups.untracked.length > 0);

  return html`
    <div class="gitp-layout panel">
      ${opts?.showRepoSelect === false
        ? html`<div class="gitp-toolbar">
            <button
              class="btn"
              type="button"
              ?disabled=${props.loading || !props.repoPath}
              @click=${props.onRefresh}
            >
              ${props.loading ? icons.loader : icons.refreshCw}
              ${t("git.refresh")}
            </button>
          </div>`
        : html`<div class="gitp-header panel__header">
            <div>
              <h2 class="gitp-title panel__title">${t("git.title")}</h2>
              <p class="gitp-sub panel__subtitle">${t("git.subtitle")}</p>
            </div>
            <div class="gitp-toolbar panel__actions">
              ${props.repoOptions.length > 1
                ? html`<select
                    class="gitp-repo-select"
                    .value=${props.repoPath ?? ""}
                    @change=${(e: Event) => props.onRepoChange((e.target as HTMLSelectElement).value)}
                  >
                    ${props.repoOptions.map(
                      (o) => html`<option value=${o.path} ?selected=${o.path === props.repoPath}>
                        ${o.kind === "workspace" ? t("git.repoWorkspace") : `${t("git.repoWorktree")} · ${o.branch || o.path}`}
                      </option>`,
                    )}
                  </select>`
                : nothing}
              <button
                class="btn"
                type="button"
                ?disabled=${props.loading || !props.repoPath}
                @click=${props.onRefresh}
              >
                ${props.loading ? icons.loader : icons.refreshCw}
                ${t("git.refresh")}
              </button>
            </div>
          </div>`}

      ${!props.connected
        ? html`<div class="callout info">${t("error.disconnected")}</div>`
        : nothing}
      ${props.gitAvailable === false || props.repoState === "no-git"
        ? html`<div class="callout danger">${t("git.noGit")}</div>`
        : nothing}
      ${props.repoState === "not-a-repo"
        ? html`<div class="callout info">${t("git.notARepo")}</div>`
        : nothing}
      ${props.errorKind === "identity"
        ? html`<div class="callout danger">
            <div>${t("git.identityGuide")}</div>
            ${props.errorDetail ? html`<pre class="gitp-error-detail">${props.errorDetail}</pre>` : nothing}
          </div>`
        : props.errorKind === "generic"
          ? html`<div class="callout danger">${tWithDetail("git.opFailed", props.errorDetail)}</div>`
          : nothing}

      ${props.repoState === "ok" && branch
        ? html`<div class="chip-row gitp-branch-row">
            <span class="chip">${icons.gitBranch} ${branch.head ?? t("git.branchUnknown")}</span>
            ${branch.upstream
              ? html`<span class="chip">${branch.upstream}
                  ${branch.ahead > 0 || branch.behind > 0
                    ? html` ↑${branch.ahead} ↓${branch.behind}`
                    : nothing}</span>`
              : nothing}
          </div>`
        : nothing}

      ${props.loading && !props.status
        ? html`<div class="gitp-loading">${icons.loader} ${t("git.loading")}</div>`
        : props.repoState === "ok" && groups && !hasChanges
          ? html`<p class="gitp-empty panel__empty">${t("git.clean")}</p>`
          : nothing}

      ${props.repoState === "ok" && props.statusTruncated
        ? html`<div class="callout info">${t("git.statusTruncated")}</div>`
        : nothing}

      ${groups ? renderGroup(props, "staged", groups.staged) : nothing}
      ${groups ? renderGroup(props, "unstaged", groups.unstaged) : nothing}
      ${groups ? renderGroup(props, "untracked", groups.untracked) : nothing}
      ${groups ? renderCommitBox(props, groups.staged.length) : nothing}
    </div>
  `;
}
