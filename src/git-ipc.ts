// git IPC —— 渲染层 git 面板（P4）的主进程侧。
// git:detect 探测 + git:status/diff/stage/unstage/commit 五个操作通道。
// 安全面：
// - 全部 assertTrustedIpcSender；
// - execFile 数组传参（无 shell 注入面）+ 超时 + windowsHide；
// - cwd 必须 ∈ workspace 白名单根（resolveAllowedDir：path 校验 + realpath 复核防 symlink）；
// - 文件路径入参只接受仓库相对路径（sanitizeGitRelPaths 拒绝绝对路径与 .. 逃逸）。
// 错误协议（渲染层据此降级）：
// - git 不存在 → { success:false, error:"no-git" }
// - cwd 不在白名单 → { success:false, error:"denied" }
// - 非 git 仓库 → { success:false, error:"not-a-repo" }
// - 其余 git 失败 → { success:false, error:"git-error", message: stderr 截断 }
import { ipcMain } from "electron";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { detectGitCached } from "./git-detector";
import { resolveAllowedDir } from "./workspace-ipc";
import { runGit, type GitRunResult } from "./git-run";
import {
  isNotARepoError,
  normalizeCommitMessage,
  parsePorcelainV2Status,
  parseUnifiedDiff,
  sanitizeGitRelPaths,
} from "./git-parse";
import * as log from "./logger";

const GIT_TIMEOUT_MS = 15_000;
const GIT_COMMIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const STDERR_PREVIEW = 4_000;

type Guarded =
  | { ok: true; dir: string }
  | { ok: false; resp: { success: false; error: string; message?: string } };

// 公共守卫链：sender 可信 → git 可用 → cwd ∈ 白名单根
async function guardGitOp(
  event: Electron.IpcMainInvokeEvent,
  channel: string,
  cwd: unknown,
): Promise<Guarded> {
  if (!assertTrustedIpcSender(event, channel)) throw new Error("IPC sender not trusted");
  const detection = await detectGitCached();
  if (!detection.available) {
    return { ok: false, resp: { success: false, error: "no-git" } };
  }
  const dir = await resolveAllowedDir(typeof cwd === "string" ? cwd : "");
  if (!dir) {
    log.error(`[git-ipc] ${channel} 拒绝白名单外 cwd: ${String(cwd).slice(0, 200)}`);
    return { ok: false, resp: { success: false, error: "denied" } };
  }
  return { ok: true, dir };
}

// git 非零退出的统一归类：not-a-repo 单列，其余透传 stderr（渲染层做身份未配置等友好引导）
function gitFailure(res: GitRunResult): { success: false; error: string; message?: string } {
  if (isNotARepoError(res.stderr)) {
    return { success: false, error: "not-a-repo" };
  }
  const message = res.stderr.trim().slice(0, STDERR_PREVIEW) || `git exited with code ${res.code}`;
  return { success: false, error: "git-error", message };
}

// runGit 抛错（spawn 失败等）的统一归类：ENOENT 说明 git 二进制消失（探测后被卸载 /
// PATH 变更的竞态），归 no-git 而非 git-error，渲染层按「未装 git」引导。
function gitCatchResp(channel: string, err: unknown): { success: false; error: string; message?: string } {
  log.error(`[git-ipc] ${channel} failed: ${err instanceof Error ? err.message : String(err)}`);
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
    return { success: false, error: "no-git", message: String(err instanceof Error ? err.message : err) };
  }
  return { success: false, error: "git-error", message: String(err instanceof Error ? err.message : err) };
}

export function registerGitIpc(): void {
  // 返回缓存的 git 探测结果（{available, version}）；探测本身在注册时已启动
  ipcMain.handle("git:detect", async (event) => {
    if (!assertTrustedIpcSender(event, "git:detect")) throw new Error("IPC sender not trusted");
    const result = await detectGitCached();
    return { success: true, data: result };
  });

  // 仓库状态：branch header + 分组前的全量条目（porcelain v2 解析在 git-parse.ts）
  ipcMain.handle("git:status", async (event, cwd: unknown) => {
    const g = await guardGitOp(event, "git:status", cwd);
    if (!g.ok) return g.resp;
    try {
      const res = await runGit(g.dir, ["status", "--porcelain=v2", "-z", "-b"], GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
      if (res.code !== 0) return gitFailure(res);
      return { success: true, data: { ...parsePorcelainV2Status(res.stdout), truncated: res.truncated } };
    } catch (err) {
      return gitCatchResp("git:status", err);
    }
  });

  // 单文件/全量 diff：cached=staged 区 diff；path 限定单文件（懒拉）
  ipcMain.handle("git:diff", async (event, cwd: unknown, opts?: { cached?: boolean; path?: string }) => {
    const g = await guardGitOp(event, "git:diff", cwd);
    if (!g.ok) return g.resp;
    const args = ["diff", "--no-color", "--no-ext-diff"];
    if (opts?.cached === true) args.push("--cached");
    if (typeof opts?.path === "string" && opts.path) {
      const paths = sanitizeGitRelPaths([opts.path]);
      if (!paths) return { success: false, error: "denied" };
      args.push("--", paths[0]);
    }
    try {
      const res = await runGit(g.dir, args, GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
      if (res.code !== 0 && !res.truncated) return gitFailure(res);
      return {
        success: true,
        data: { files: parseUnifiedDiff(res.stdout), truncated: res.truncated },
      };
    } catch (err) {
      return gitCatchResp("git:diff", err);
    }
  });

  // 文件级暂存 / 取消暂存（v1 不做 hunk 级）
  const registerMutation = (
    channel: "git:stage" | "git:unstage",
    buildArgs: (paths: string[]) => string[],
  ) => {
    ipcMain.handle(channel, async (event, cwd: unknown, rawPaths: unknown) => {
      const g = await guardGitOp(event, channel, cwd);
      if (!g.ok) return g.resp;
      const paths = sanitizeGitRelPaths(rawPaths);
      if (!paths) return { success: false, error: "denied" };
      try {
        const res = await runGit(g.dir, buildArgs(paths), GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
        if (res.code !== 0) return gitFailure(res);
        return { success: true };
      } catch (err) {
        return gitCatchResp(channel, err);
      }
    });
  };
  registerMutation("git:stage", (paths) => ["add", "--", ...paths]);

  // 取消暂存：`restore --staged` 在空仓库（unborn HEAD）恒定失败
  // （fatal: could not resolve 'HEAD'），此时回退 `rm --cached`（只动索引，不依赖 HEAD）
  ipcMain.handle("git:unstage", async (event, cwd: unknown, rawPaths: unknown) => {
    const g = await guardGitOp(event, "git:unstage", cwd);
    if (!g.ok) return g.resp;
    const paths = sanitizeGitRelPaths(rawPaths);
    if (!paths) return { success: false, error: "denied" };
    try {
      let res = await runGit(g.dir, ["restore", "--staged", "--", ...paths], GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
      if (res.code !== 0 && /could not resolve '?HEAD'?/i.test(res.stderr)) {
        res = await runGit(g.dir, ["rm", "--cached", "--", ...paths], GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
      }
      if (res.code !== 0) return gitFailure(res);
      return { success: true };
    } catch (err) {
      return gitCatchResp("git:unstage", err);
    }
  });

  // 提交：message 数组传参（无注入面）；失败 stderr 原样透传给渲染层做友好引导
  ipcMain.handle("git:commit", async (event, cwd: unknown, message: unknown) => {
    const g = await guardGitOp(event, "git:commit", cwd);
    if (!g.ok) return g.resp;
    const msg = normalizeCommitMessage(message);
    if (!msg) return { success: false, error: "invalid-message" };
    try {
      const res = await runGit(g.dir, ["commit", "-m", msg], GIT_COMMIT_TIMEOUT_MS, GIT_MAX_BUFFER);
      if (res.code !== 0) return gitFailure(res);
      return { success: true };
    } catch (err) {
      return gitCatchResp("git:commit", err);
    }
  });
}
