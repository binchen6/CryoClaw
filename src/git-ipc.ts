// git 能力探测 IPC —— 渲染层据此降级 worktree 等 git 依赖入口
// P4 的 git:status/diff/stage/commit 通道也将在本文件扩展
import { ipcMain } from "electron";
import { assertTrustedIpcSender } from "./ipc-sender-guard";
import { detectGitCached } from "./git-detector";

export function registerGitIpc(): void {
  // 返回缓存的 git 探测结果（{available, version}）；探测本身在注册时已启动
  ipcMain.handle("git:detect", async (event) => {
    if (!assertTrustedIpcSender(event, "git:detect")) throw new Error("IPC sender not trusted");
    const result = await detectGitCached();
    return { success: true, data: result };
  });
}
