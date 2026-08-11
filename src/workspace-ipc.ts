// 工作空间文件系统操作 — 目录浏览、文件读取、系统打开
// 所有路径操作均验证在 workspace 根目录内，防止路径穿越
import { ipcMain, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as log from "./logger";
import { resolveUserStateDir } from "./constants";
import { assertTrustedIpcSender } from "./ipc-sender-guard";

// workspace 根路径由渲染进程首次调用 workspace:set-root 设定
let workspaceRoot: string | null = null;

// 安全面：shell.openPath 会用系统默认程序打开任意文件，可执行文件会被直接运行。
// agent 可写目录（workspace）里的可执行文件风险更高，仅允许"安全打开"扩展名
// （与 main.ts app:open-path 的 SAFE_OPEN_EXTS 保持一致；渲染层 chat 路径链接走
// app:open-path，不受此白名单影响）。
const SAFE_OPEN_EXTS = new Set([
  // 图片
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff",
  // 文档
  "pdf", "txt", "md", "markdown", "json", "csv", "tsv", "log",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  // 音视频
  "mp3", "wav", "flac", "aac", "ogg", "m4a",
  "mp4", "mkv", "webm", "avi", "mov", "m4v", "mpg", "mpeg",
  // 压缩包（仅打开不执行）
  "zip", "tar", "gz", "bz2", "7z", "rar",
]);

// 路径穿越校验：确保 target 在 root 内
function isInsideRoot(target: string, root: string): boolean {
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

// 公共守卫：检查 workspace root 和路径合法性
function guardPath(filePath: string): { ok: true } | { ok: false; error: { success: false; message: string } } {
  if (!workspaceRoot) {
    return { ok: false, error: { success: false, message: "Workspace root not set" } };
  }
  if (!isInsideRoot(filePath, workspaceRoot)) {
    log.error(`workspace: path traversal blocked: ${filePath}`);
    return { ok: false, error: { success: false, message: "Access denied" } };
  }
  return { ok: true };
}

export function registerWorkspaceIpc(): void {
  // 设置 workspace 根路径（渲染进程从 gateway 获取后传入）
  // 安全面：root 必须在 ~/.openclaw/workspace/ 内，阻止渲染进程任意改根目录绕过 traversal 守卫
  ipcMain.handle("workspace:set-root", (event, root: string) => {
    if (!assertTrustedIpcSender(event, "workspace:set-root")) throw new Error("IPC sender not trusted");
    const allowedRoot = path.join(resolveUserStateDir(), "workspace");
    const resolved = path.resolve(root);
    if (!isInsideRoot(resolved, allowedRoot)) {
      log.error(`workspace: set-root 拒绝非 workspace 子目录: ${resolved}（允许范围: ${allowedRoot}）`);
      return { success: false, message: "Workspace root must be inside ~/.openclaw/workspace/" };
    }
    workspaceRoot = resolved;
    log.info(`workspace root set: ${resolved}`);
    return { success: true };
  });

  // 用系统默认应用打开文件
  ipcMain.handle("workspace:open-file", async (event, filePath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:open-file")) throw new Error("IPC sender not trusted");
    const check = guardPath(filePath);
    if (!check.ok) return check.error;
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!ext || !SAFE_OPEN_EXTS.has(ext)) {
      log.warn(`[security] workspace:open-file 拒绝非白名单扩展名: .${ext || "(无)"} ${filePath.slice(0, 100)}`);
      return { success: false, message: "不支持的文件类型" };
    }
    try {
      await shell.openPath(filePath);
      return { success: true };
    } catch (err: any) {
      log.error(`workspace:open-file failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 在 Finder/Explorer 中显示文件所在目录
  ipcMain.handle("workspace:open-folder", (event, filePath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:open-folder")) throw new Error("IPC sender not trusted");
    const check = guardPath(filePath);
    if (!check.ok) return check.error;
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (err: any) {
      log.error(`workspace:open-folder failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 列出目录内容（支持子目录浏览）
  ipcMain.handle("workspace:list-dir", async (event, dirPath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:list-dir")) throw new Error("IPC sender not trusted");
    const check = guardPath(dirPath);
    if (!check.ok) return check.error;
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: path.join(dirPath, e.name),
        }))
        .sort((a, b) => {
          // 文件夹在前，文件在后；同类型按名称排序
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { success: true, data: { items, root: dirPath } };
    } catch (err: any) {
      log.error(`workspace:list-dir failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 读取文件内容（纯文本，限制 1MB）
  ipcMain.handle("workspace:read-file", async (event, filePath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:read-file")) throw new Error("IPC sender not trusted");
    const check = guardPath(filePath);
    if (!check.ok) return check.error;
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 1024 * 1024) {
        return { success: false, message: "File too large (>1MB)" };
      }
      const content = await fs.promises.readFile(filePath, "utf-8");
      return { success: true, data: { content, name: path.basename(filePath), path: filePath } };
    } catch (err: any) {
      log.error(`workspace:read-file failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });
}

