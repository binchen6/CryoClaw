import {html, LitElement, nothing, type PropertyValues, type TemplateResult} from "lit";
import type {AppViewState} from "../app-view-state.ts";
import {initWorkspace, loadWorkspaceFile, setWorkspaceSearch, workspaceViewState as ws} from "../controllers/workspace.ts";
import {icons} from "../icons.ts";
import {getLocale, t} from "../i18n.ts";
import {DockFileTree, dockRelativePath, type DockTreeItem} from "../utils/dock-file-tree.ts";
import {renderWorkspaceFilePreview, type WorkspaceViewOptions} from "./workspace.ts";

type DockFilesOptions = Pick<WorkspaceViewOptions, "onAttachFile" | "onOpenItemFolder" | "onChooseRoot">;
const initializingHosts = new WeakMap<AppViewState, Promise<void>>();
const visualKeys = [
  "root", "currentPath", "loading", "error", "selectedFile", "selectedFileName", "fileContent", "fileLoading", "fileError",
  "imagePreview", "fileHash", "fileSize", "draft", "editing", "fileSaving", "draftStatus", "recentFiles", "showHidden",
  "search", "searchLoading", "searchResults", "searchTruncated", "fileQuery", "wrap", "historyIndex",
] as const satisfies readonly (keyof typeof ws)[];
const visualRevisions = new WeakMap<AppViewState, {values: unknown[]; historyLength: number; locale: string; revision: object}>();

function workspaceVisualRevision(state: AppViewState): object {
  const previous = visualRevisions.get(state), locale = getLocale();
  // Compare scalar values and collection identities, never serialize file contents or walk the tree.
  if (previous && previous.historyLength === ws.history.length && previous.locale === locale
    && visualKeys.every((key, index) => Object.is(ws[key], previous.values[index]))) return previous.revision;
  const revision = {};
  visualRevisions.set(state, {values: visualKeys.map(key => ws[key]), historyLength: ws.history.length, locale, revision});
  return revision;
}

/** Mounted only by the active Files tab; it owns no global directory navigation state. */
export class DockFiles extends LitElement {
  static properties = {hostState: {attribute: false}, options: {attribute: false}, viewRevision: {attribute: false}, treeVisible: {state: true}};
  hostState?: AppViewState;
  options?: DockFilesOptions;
  viewRevision?: object;
  treeVisible = true;
  private internalUpdate = false;
  // Rendered handlers retain these proxies while options continue receiving fresh app callbacks.
  private readonly previewOptions: DockFilesOptions = {
    onAttachFile: (path, name) => this.options?.onAttachFile(path, name),
    onOpenItemFolder: path => this.options?.onOpenItemFolder(path),
    onChooseRoot: () => this.options?.onChooseRoot(),
  };
  private attemptedInitialization = false;
  private readonly tree = new DockFileTree(async (path, showHidden) => {
    const result = await window.cryoclaw?.workspaceListDir?.(path, {showHidden});
    if (!result?.success || !result.data || !Array.isArray(result.data.items)) throw Error("unavailable");
    return {items: result.data.items, truncated: result.data.truncated === true};
  }, () => this.invalidate());

  protected createRenderRoot() { return this; }

  private invalidate(): void {
    this.internalUpdate = true;
    this.requestUpdate();
  }

  protected shouldUpdate(changed: PropertyValues): boolean {
    const internal = this.internalUpdate;
    this.internalUpdate = false;
    return !this.hasUpdated || internal || changed.has("viewRevision") || changed.has("hostState") || changed.has("treeVisible");
  }

  connectedCallback(): void {
    super.connectedCallback();
    // A reconnected element must not reuse an in-flight snapshot cancelled on disconnect.
    this.tree.configure(ws.root, ws.showHidden, true);
    this.invalidate();
  }

  disconnectedCallback(): void {
    this.tree.cancel();
    super.disconnectedCallback();
  }

  protected updated(_changed: PropertyValues): void {
    if (!this.hostState || !this.isConnected) return;
    this.tree.configure(ws.root, ws.showHidden);
    if (ws.root && this.treeVisible && !this.tree.directories.has(ws.root)) void this.tree.load(ws.root);
    if (!ws.root && !this.attemptedInitialization && !ws.loading) {
      this.attemptedInitialization = true;
      this.initialize();
    }
  }

  private initialize(force = false): void {
    const state = this.hostState;
    if (!state) return;
    let pending = initializingHosts.get(state);
    if (!pending) {
      pending = initWorkspace(state, force).finally(() => {
        initializingHosts.delete(state);
        if (this.isConnected) this.invalidate();
      });
      initializingHosts.set(state, pending);
    }
  }

  private refresh(): void {
    if (!ws.root) { this.initialize(true); return; }
    this.tree.configure(ws.root, ws.showHidden, true);
    if (ws.search.trim() && this.hostState) setWorkspaceSearch(this.hostState, ws.search);
    if (this.treeVisible) void this.tree.load(ws.root);
    this.invalidate();
  }

  private select(item: DockTreeItem): void {
    if (!this.hostState || !ws.root || dockRelativePath(ws.root, item.path) === null || ws.fileSaving) return;
    if (item.isDir) {
      if (!this.tree.canExpand(item.path)) return;
      if (this.tree.expanded.has(item.path)) this.tree.expanded.delete(item.path);
      else { this.tree.expanded.add(item.path); void this.tree.load(item.path); }
      this.invalidate();
    } else void loadWorkspaceFile(this.hostState, item.path, item.name);
  }

  private keydown(event: KeyboardEvent, item: DockTreeItem): void {
    if (event.isComposing || event.keyCode === 229 || event.target !== event.currentTarget) return;
    const current = event.currentTarget as HTMLElement;
    const nodes = Array.from(this.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const index = nodes.indexOf(current);
    let focus: HTMLElement | undefined;
    if (event.key === "ArrowDown") focus = nodes[Math.min(index + 1, nodes.length - 1)];
    else if (event.key === "ArrowUp") focus = nodes[Math.max(0, index - 1)];
    else if (event.key === "Home") focus = nodes[0];
    else if (event.key === "End") focus = nodes.at(-1);
    else if (event.key === "ArrowRight" && item.isDir && !ws.search.trim()) {
      if (!this.tree.expanded.has(item.path)) this.select(item);
      else focus = nodes[index + 1];
    } else if (event.key === "ArrowLeft" && !ws.search.trim()) {
      if (item.isDir && this.tree.expanded.has(item.path)) this.select(item);
      else focus = current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined;
    } else if (event.key === "Enter" || event.key === " ") this.select(item);
    else return;
    event.preventDefault();
    event.stopPropagation();
    focus?.focus();
  }

  private renderItems(items: DockTreeItem[], depth: number, search = false): TemplateResult[] {
    return items.map(item => {
      const expanded = !search && item.isDir && this.tree.expanded.has(item.path);
      const relative = ws.root ? dockRelativePath(ws.root, item.path) : null;
      const expandable = item.isDir && this.tree.canExpand(item.path);
      return html`<div role="treeitem" class="dock-files__item ${ws.selectedFile === item.path ? "is-selected" : ""}" tabindex="0"
        aria-selected=${ws.selectedFile === item.path} aria-expanded=${item.isDir ? expanded : nothing}
        aria-disabled=${ws.fileSaving || (item.isDir && !expandable)}
        @keydown=${(event: KeyboardEvent) => this.keydown(event, item)}>
        <div class="dock-files__row" style=${`--dock-tree-depth:${depth}`} title=${relative ?? item.name} @click=${() => this.select(item)}>
          <span class="dock-files__chevron">${item.isDir ? expanded ? icons.chevronDown : icons.chevronRight : nothing}</span>
          <span class="dock-files__file-icon">${item.isDir ? expanded ? icons.folderOpen : icons.folder : icons.fileText}</span>
          <span class="dock-files__name">${item.name}${search && relative && relative !== item.name ? html`<small>${relative}</small>` : nothing}</span>
        </div>
        ${expanded ? html`<div role="group">${this.renderDirectory(item.path, depth + 1)}</div>` : nothing}
      </div>`;
    });
  }

  private renderDirectory(path: string, depth: number): unknown {
    const directory = this.tree.directories.get(path);
    if (!directory || directory.loading) return html`<div class="dock-files__hint" role="status">${t("workspace.loading")}</div>`;
    if (directory.error) return html`<div class="dock-files__hint" role="alert">${t("workspace.error")} <button class="btn btn--sm" @click=${() => void this.tree.load(path)}>${t("workspace.refresh")}</button></div>`;
    return html`${this.renderItems(directory.items, depth)}
      ${!directory.items.length ? html`<div class="dock-files__hint">${t("workspace.browser.empty")}</div>` : nothing}
      ${directory.truncated ? html`<div class="dock-files__hint">${t("workspace.browser.refineSearch")}</div>` : nothing}`;
  }

  protected render(): unknown {
    if (!this.hostState || !this.options) return nothing;
    const rootName = ws.root?.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1) || t("workspace.files");
    const searching = !!ws.search.trim();
    const results = ws.root ? ws.searchResults.filter(item => dockRelativePath(ws.root!, item.path) !== null).slice(0, 200) : [];
    return html`<div class="dock-files ${this.treeVisible ? "" : "dock-files--tree-hidden"}">
      <header class="dock-files__header">
        <div class="dock-files__workspace">${icons.folder}<span>${rootName}</span></div>
        <div class="dock-files__actions">
          <button class="icon-btn icon-btn--sm" aria-label=${t("workspace.browser.chooseRoot")} title=${t("workspace.browser.chooseRoot")} ?disabled=${ws.fileSaving} @click=${this.previewOptions.onChooseRoot}>${icons.folderOpen}</button>
          <button class="icon-btn icon-btn--sm" aria-label=${t("workspace.files")} title=${t("workspace.files")} aria-pressed=${this.treeVisible} @click=${() => { this.treeVisible = !this.treeVisible; if (!this.treeVisible) this.tree.cancel(); else this.tree.configure(ws.root, ws.showHidden, true); }}>${icons.panelRight}</button>
        </div>
      </header>
      <div class="dock-files__body">
        <div class="dock-files__preview">${renderWorkspaceFilePreview(this.hostState, this.previewOptions)}</div>
        ${this.treeVisible ? html`<aside class="dock-files__tree" aria-label=${t("workspace.files")}>
          <div class="dock-files__search-row"><div class="dock-files__search">${icons.search}<input type="search" aria-label=${t("workspace.browser.searchLabel")} placeholder=${t("workspace.browser.searchPlaceholder")} .value=${ws.search}
            @input=${(event: Event) => setWorkspaceSearch(this.hostState!, (event.target as HTMLInputElement).value)}
            @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) setWorkspaceSearch(this.hostState!, ""); }} /></div>
            <button class="icon-btn icon-btn--xs" aria-label=${t("workspace.refresh")} title=${t("workspace.refresh")} ?disabled=${ws.fileSaving || ws.loading} @click=${() => this.refresh()}>${icons.refreshCw}</button>
          </div>
          <div class="dock-files__nodes" role="tree" aria-label=${t("workspace.files")} aria-busy=${ws.loading || ws.searchLoading || !!(ws.root && this.tree.directories.get(ws.root)?.loading)}>
            ${ws.loading && !ws.root || ws.searchLoading ? html`<div class="dock-files__hint" role="status">${t("workspace.loading")}</div>` : searching ? html`
              ${ws.error ? html`<div class="dock-files__hint" role="alert">${t("workspace.error")}</div>` : this.renderItems(results, 0, true)}
              ${!results.length && !ws.error ? html`<div class="dock-files__hint">${t("workspace.browser.noMatches")}</div>` : nothing}
              ${ws.searchTruncated ? html`<div class="dock-files__hint">${t("workspace.browser.refineSearch")}</div>` : nothing}` : ws.root ? this.renderDirectory(ws.root, 0) : html`<div class="dock-files__hint" role=${ws.error ? "alert" : "status"}>${ws.error ? t("workspace.error") : t("workspace.browser.empty")}</div>`}
          </div>
        </aside>` : nothing}
      </div>
    </div>`;
  }
}

if (!customElements.get("oc-dock-files")) customElements.define("oc-dock-files", DockFiles);

export function renderDockFiles(state: AppViewState, opts: DockFilesOptions): TemplateResult {
  return html`<oc-dock-files .hostState=${state} .options=${opts} .viewRevision=${workspaceVisualRevision(state)}></oc-dock-files>`;
}
