export type DockTreeItem = {name: string; path: string; isDir: boolean};
export type DockDirectory = {items: DockTreeItem[]; loading: boolean; loaded: boolean; truncated: boolean; error: string | null};
type DirectoryLoader = (path: string, showHidden: boolean) => Promise<{items: DockTreeItem[]; truncated?: boolean}>;

function normalized(path: string): string {
  const value = path.replace(/\\/g, "/");
  return value === "/" ? value : value.replace(/\/+$/, "");
}

/** UI containment is additional defense; the native bridge remains the authority. */
export function dockRelativePath(root: string, path: string): string | null {
  const base = normalized(root), target = normalized(path);
  if (!base || !target || target.split("/").some(part => part === "." || part === "..")) return null;
  const windows = /^[a-z]:/i.test(base) || base.startsWith("//");
  const left = windows ? base.toLowerCase() : base, right = windows ? target.toLowerCase() : target;
  if (left === right) return "";
  const prefix = left === "/" ? "/" : left + "/";
  return right.startsWith(prefix) ? target.slice(prefix.length) : null;
}

export class DockFileTree {
  root: string | null = null;
  showHidden = false;
  readonly directories = new Map<string, DockDirectory>();
  readonly expanded = new Set<string>();
  private generation = 0;
  private pending = new Map<string, Promise<void>>();
  private admitted = new Set<string>();
  private readonly maxNodes: number;
  private readonly maxDepth: number;
  private readonly loader: DirectoryLoader;
  private readonly changed: () => void;

  constructor(loader: DirectoryLoader, changed: () => void = () => {}, limits: {maxNodes?: number; maxDepth?: number} = {}) {
    this.loader = loader;
    this.changed = changed;
    this.maxNodes = Math.max(1, limits.maxNodes ?? 800);
    this.maxDepth = Math.max(1, limits.maxDepth ?? 12);
  }

  configure(root: string | null, showHidden: boolean, force = false): void {
    if (!force && root === this.root && showHidden === this.showHidden) return;
    this.cancel();
    this.root = root;
    this.showHidden = showHidden;
    this.directories.clear();
    this.expanded.clear();
    this.admitted.clear();
    if (root) this.expanded.add(root);
  }

  cancel(): void {
    ++this.generation;
    this.pending.clear();
    for (const directory of this.directories.values()) directory.loading = false;
  }

  canExpand(path: string): boolean {
    if (!this.root) return false;
    const relative = dockRelativePath(this.root, path);
    if (relative === null || (path !== this.root && !this.admitted.has(path))) return false;
    return !relative || relative.split("/").length < this.maxDepth;
  }

  load(path: string): Promise<void> {
    if (!this.canExpand(path)) return Promise.resolve();
    const pending = this.pending.get(path);
    if (pending) return pending;
    const previous = this.directories.get(path);
    if (previous?.loaded) return Promise.resolve();
    const directory: DockDirectory = {items: [], loading: true, loaded: false, truncated: false, error: null};
    this.directories.set(path, directory);
    const generation = this.generation, root = this.root!, showHidden = this.showHidden;
    this.changed();
    let response: ReturnType<DirectoryLoader>;
    try { response = this.loader(path, showHidden); } catch (error) { response = Promise.reject(error); }
    const task = response.then(result => {
      if (generation !== this.generation) return;
      const relative = dockRelativePath(root, path)!;
      const prefix = relative ? relative + "/" : "";
      const seen = new Set<string>();
      let omitted = false;
      for (const item of result.items) {
        if (!item || typeof item.name !== "string" || typeof item.path !== "string" || typeof item.isDir !== "boolean") continue;
        const child = dockRelativePath(root, item.path);
        if (!child || !child.startsWith(prefix) || child.slice(prefix.length).includes("/") || seen.has(item.path)) continue;
        if (!showHidden && item.name.startsWith(".")) continue;
        if (this.admitted.size >= this.maxNodes) { omitted = true; continue; }
        seen.add(item.path);
        this.admitted.add(item.path);
        // Names from the bridge must agree with the path; never display external path text.
        directory.items.push({name: child.slice(prefix.length), path: item.path, isDir: item.isDir});
      }
      directory.items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      directory.truncated = omitted || result.truncated === true;
      directory.loaded = true;
    }).catch(() => {
      if (generation === this.generation) directory.error = "unavailable";
    }).finally(() => {
      if (generation !== this.generation) return;
      directory.loading = false;
      this.pending.delete(path);
      this.changed();
    });
    this.pending.set(path, task);
    return task;
  }
}
