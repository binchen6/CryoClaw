import type { GatewayBrowserClient } from "../gateway.ts";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";

export type WorkspaceGatewayState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
};

// 从 gateway 动态获取 agent 的 workspace 路径（agents.files.list 响应里的 workspace 字段）。
// 未连接时返回 null；RPC 失败向上抛，由调用方统一降级为错误提示。
export async function resolveAgentWorkspacePath(
  state: WorkspaceGatewayState,
  agentId: string,
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const res = await state.client.request<{ workspace?: string } | undefined>(
    "agents.files.list",
    { agentId },
  );
  return res?.workspace ?? null;
}

// ── 工作区视图状态与加载逻辑（R42 自 views/workspace.ts 抽入，对齐 controllers 范式）──

// 可预览的文本文件扩展名
export const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".log",
  ".ts", ".js", ".jsx", ".tsx", ".py", ".sh", ".bash", ".zsh",
  ".html", ".css", ".scss", ".less",
  ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".sql",
  ".env", ".conf", ".cfg", ".ini", ".properties",
  ".gitignore", ".dockerignore", ".editorconfig",
]);

// 判断文件是否可预览（无扩展名的文件也视为文本，如 Makefile, Dockerfile）
export function isTextFile(name: string): boolean {
  const ext = name.includes(".") ? "." + name.split(".").pop()!.toLowerCase() : "";
  return !ext || TEXT_EXTENSIONS.has(ext);
}

export type WorkspaceFileItem = { name: string; isDir: boolean; path: string };

export type WorkspaceViewState = {
  root: string | null;
  currentPath: string | null;
  items: WorkspaceFileItem[];
  loading: boolean;
  error: string | null;
  selectedFile: string | null;
  selectedFileName: string | null;
  fileContent: string | null;
  fileLoading: boolean;
  /** 右主区模式：files = 文件预览，git = Git 变更面板 */
  mode: "files" | "git";
};

export const workspaceViewState: WorkspaceViewState = {
  root: null,
  currentPath: null,
  items: [],
  loading: false,
  error: null,
  selectedFile: null,
  selectedFileName: null,
  fileContent: null,
  fileLoading: false,
  mode: "files",
};

// 加载序号：防止快速连点时旧响应覆盖新响应
let dirLoadSeq = 0;
let fileLoadSeq = 0;

export function selectWorkspaceMode(mode: "files" | "git") {
  workspaceViewState.mode = mode;
}

// 列目录
export async function loadWorkspaceDirectory(state: AppViewState, dirPath: string) {
  const w = window as any;
  if (!w.cryoclaw?.workspaceListDir) return;

  const seq = ++dirLoadSeq;
  workspaceViewState.loading = true;
  state.requestUpdate();

  try {
    const result = await w.cryoclaw.workspaceListDir(dirPath);
    if (seq !== dirLoadSeq) return;
    if (result?.success && result.data) {
      workspaceViewState.items = result.data.items;
      workspaceViewState.currentPath = dirPath;
      workspaceViewState.error = null;
    } else {
      workspaceViewState.error = result?.message ?? t("workspace.error");
    }
  } catch {
    if (seq !== dirLoadSeq) return;
    workspaceViewState.error = t("workspace.error");
  } finally {
    if (seq === dirLoadSeq) {
      workspaceViewState.loading = false;
      state.requestUpdate();
    }
  }
}

// 初始化：从 gateway 获取 workspace 路径，设定 IPC root 守卫，然后列目录
export async function initWorkspace(state: AppViewState) {
  const w = window as any;
  workspaceViewState.loading = true;
  workspaceViewState.error = null;
  state.requestUpdate();

  try {
    // 从 gateway 动态获取 workspace 路径
    const newRoot = await resolveAgentWorkspacePath(state, "main");
    if (newRoot) {
      // workspace 变化时重置状态
      if (workspaceViewState.root !== newRoot) {
        workspaceViewState.selectedFile = null;
        workspaceViewState.selectedFileName = null;
        workspaceViewState.fileContent = null;
        workspaceViewState.items = [];
      }
      workspaceViewState.root = newRoot;
      workspaceViewState.currentPath = newRoot;
      // 通知 main 进程设定路径穿越守卫（全应用唯一注册点）
      await w.cryoclaw?.workspaceSetRoot?.(newRoot);
    }

    if (!workspaceViewState.root) {
      workspaceViewState.error = t("workspace.error");
      return;
    }

    await loadWorkspaceDirectory(state, workspaceViewState.root);
  } catch {
    workspaceViewState.error = t("workspace.error");
  } finally {
    workspaceViewState.loading = false;
    state.requestUpdate();
  }
}

// 读取文件内容
export async function loadWorkspaceFile(state: AppViewState, filePath: string, fileName: string) {
  const w = window as any;
  if (!w.cryoclaw?.workspaceReadFile) return;

  const seq = ++fileLoadSeq;
  workspaceViewState.fileLoading = true;
  workspaceViewState.selectedFile = filePath;
  workspaceViewState.selectedFileName = fileName;
  workspaceViewState.fileContent = null;
  workspaceViewState.error = null;
  state.requestUpdate();

  try {
    const result = await w.cryoclaw.workspaceReadFile(filePath);
    if (seq !== fileLoadSeq) return;
    if (result?.success && result.data) {
      workspaceViewState.fileContent = result.data.content;
    } else {
      workspaceViewState.fileContent = null;
      workspaceViewState.error = result?.message ?? t("workspace.fileTooLarge");
    }
  } catch {
    if (seq !== fileLoadSeq) return;
    workspaceViewState.fileContent = null;
    workspaceViewState.error = t("workspace.error");
  } finally {
    if (seq === fileLoadSeq) {
      workspaceViewState.fileLoading = false;
      state.requestUpdate();
    }
  }
}

// 文件/文件夹点击处理
export function openWorkspaceDirectory(state: AppViewState, item: WorkspaceFileItem) {
  if (item.isDir) {
    // 进入子目录时清除选中的文件，并使进行中的文件加载失效
    fileLoadSeq++;
    workspaceViewState.selectedFile = null;
    workspaceViewState.selectedFileName = null;
    workspaceViewState.fileContent = null;
    workspaceViewState.fileLoading = false;
    state.requestUpdate();
    void loadWorkspaceDirectory(state, item.path);
  } else if (isTextFile(item.name)) {
    void loadWorkspaceFile(state, item.path, item.name);
  } else {
    // 非文本文件：标记选中但不预览，并使进行中的文件加载失效
    fileLoadSeq++;
    workspaceViewState.selectedFile = item.path;
    workspaceViewState.selectedFileName = item.name;
    workspaceViewState.fileContent = null;
    workspaceViewState.fileLoading = false;
    state.requestUpdate();
  }
}

// 返回上级目录
export function navigateWorkspaceUp(state: AppViewState) {
  if (!workspaceViewState.currentPath || !workspaceViewState.root) return;
  if (workspaceViewState.currentPath === workspaceViewState.root) return;
  // 兼容 Windows 反斜杠和 Unix 正斜杠
  let parent = workspaceViewState.currentPath.replace(/[/\\][^/\\]+[/\\]?$/, "");
  // 防止越过 workspace 根目录
  if (!parent || parent.length < workspaceViewState.root.length) {
    parent = workspaceViewState.root;
  }
  void loadWorkspaceDirectory(state, parent);
}
