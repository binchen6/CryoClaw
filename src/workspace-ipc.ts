// 工作空间文件系统操作 — 目录浏览、文件读取、系统打开
// 所有路径操作均验证在允许的根目录内（workspace 根 + 内核 worktrees 目录），防止路径穿越
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

// 多根版 containment 校验（导出供单测）：target 落在任一 root 内即通过
export function isInsideAnyRoot(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInsideRoot(target, root));
}

// 允许访问的根集合：workspace 根（渲染层 set-root 设定，可能未设置）+
// 内核 worktrees 目录 ~/.openclaw/worktrees/（worktree 管理视图「打开目录」走这里）
function allowedRoots(): string[] {
  const roots: string[] = [];
  if (workspaceRoot) {
    roots.push(workspaceRoot);
  }
  roots.push(path.join(resolveUserStateDir(), "worktrees"));
  return roots;
}

// 公共守卫：检查路径合法性（workspace 根或 worktrees 根之内）
function guardPath(filePath: string): { ok: true } | { ok: false; error: { success: false; message: string } } {
  if (!isInsideAnyRoot(filePath, allowedRoots())) {
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
  try {
    const real = await fs.promises.realpath(filePath);
    return isInsideAnyRoot(real, allowedRoots()) ? real : null;
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

// 目录版守卫（git IPC 的 cwd 入参用）：目录必须在白名单根内（path 校验 + realpath
// 复核防 symlink）。通过时返回 realpath（realpath 失败回退原路径，后续 git 自然报错）；
// 不通过返回 null。与 guardRealPath 同规则，只是错误交由调用方组织。
export async function resolveAllowedDir(dirPath: string): Promise<string | null> {
  if (typeof dirPath !== "string" || !dirPath) return null;
  if (!isInsideAnyRoot(dirPath, allowedRoots())) return null;
  try {
    const real = await fs.promises.realpath(dirPath);
    return isInsideAnyRoot(real, allowedRoots()) ? real : null;
  } catch {
    // 目录不存在/权限问题：回退原路径，让 git 自己报具体错误
    return dirPath;
  }
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
  ipcMain.handle("workspace:open-folder", async (event, filePath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:open-folder")) throw new Error("IPC sender not trusted");
    const check = await guardRealPath(filePath);
    if (!check.ok) return check.error;
    const target = check.target;
    try {
      shell.showItemInFolder(target);
      return { success: true };
    } catch (err: any) {
      log.error(`workspace:open-folder failed: ${err?.message}`);
      return { success: false, message: err?.message ?? String(err) };
    }
  });

  // 列出目录内容（支持子目录浏览）
  ipcMain.handle("workspace:list-dir", async (event, dirPath: string) => {
    if (!assertTrustedIpcSender(event, "workspace:list-dir")) throw new Error("IPC sender not trusted");
    const check = await guardRealPath(dirPath);
    if (!check.ok) return check.error;
    const target = check.target;
    try {
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: path.join(target, e.name),
        }))
        .sort((a, b) => {
          // 文件夹在前，文件在后；同类型按名称排序
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { success: true, data: { items, root: target } };
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

