// 工作空间文件系统操作 — 目录浏览、文件读取、系统打开
// 所有路径操作均验证在 workspace 根目录内，防止路径穿越
import { ipcMain, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as log from "./logger";
import { resolveUserStateDir } from "./constants";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { isSafeOpenExt } from "./safe-open";

// workspace 根路径由渲染进程首次调用 workspace:set-root 设定
let workspaceRoot: string | null = null;

// 安全面：agent 可写目录（workspace）里的可执行文件风险更高，仅允许"安全打开"扩展名。
// 白名单与 main.ts app:open-path 共用（见 safe-open.ts）；渲染层 chat 路径链接走
// app:open-path，不受此白名单影响。

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

// symlink 逃逸守卫：workspace 是 agent 可写目录，攻击面在于 agent 可在其中创建
// 指向任意位置的符号链接（如 credentials/kimi-api-key），而 path.resolve 不解引用
// symlink、fs.stat/readFile/shell.openPath 都会跟随。解析真实路径后复核 containment；
// realpath 失败（文件不存在等）交由后续操作自然报错。返回 null 表示拒绝。
async function resolveRealInsideRoot(
  filePath: string,
): Promise<string | null | undefined> {
  if (!workspaceRoot) return null;
  try {
    const real = await fs.promises.realpath(filePath);
    return isInsideRoot(real, workspaceRoot) ? real : null;
  } catch {
    // 解析失败（不存在/权限）：返回 undefined，让后续 stat/open 用原路径报具体错误
    return undefined;
  }
}

// guardPath + symlink 复核的组合守卫：通过时返回实际要操作的 target 路径
// （realpath 优先，解析失败回退原路径由后续操作报具体错误）。
async function guardRealPath(
  filePath: string,
): Promise<{ ok: true; target: string } | { ok: false; error: { success: false; message: string } }> {
  const check = guardPath(filePath);
  if (!check.ok) return check;
  const realPath = await resolveRealInsideRoot(filePath);
  if (realPath === null) {
    log.error(`workspace: symlink escape blocked: ${filePath}`);
    return { ok: false, error: { success: false, message: "Access denied" } };
  }
  return { ok: true, target: realPath ?? filePath };
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
    const check = await guardRealPath(filePath);
    if (!check.ok) return check.error;
    const target = check.target;
    const ext = path.extname(target).slice(1).toLowerCase();
    if (!isSafeOpenExt(ext)) {
      log.warn(`[security] workspace:open-file 拒绝非白名单扩展名: .${ext || "(无)"} ${target.slice(0, 100)}`);
      return { success: false, message: "不支持的文件类型" };
    }
    try {
      await shell.openPath(target);
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
    const check = await guardRealPath(filePath);
    if (!check.ok) return check.error;
    const target = check.target;
    try {
      const stat = await fs.promises.stat(target);
      if (stat.size > 1024 * 1024) {
        return { success: false, message: "File too large (>1MB)" };
      }
      const content = await fs.promises.readFile(target, "utf-8");
      return { success: true, data: { content, name: path.basename(target), path: filePath } };
    } catch (err: any) {
      log.error(`workspace:read-file failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });
}

