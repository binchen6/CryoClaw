// git CLI 底层 runner —— 从 git-ipc.ts 拆出（不依赖 electron，可独立单测）。
// execFile 数组传参（无 shell 注入面）+ 超时 + windowsHide + maxBuffer 截断检测；
// 非零退出也统一 resolve 为结构化结果，由调用方按 code/stderr/truncated 分类。
import { execFile } from "child_process";

export type GitRunResult = { code: number; stdout: string; stderr: string; truncated: boolean };

// execFile 回调形态（便于测试注入假 runner）
export type GitRunner = (
  args: string[],
  callback: (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => void;

const realRunner =
  (cwd: string, timeoutMs: number, maxBuffer: number): GitRunner =>
  (args, callback) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer },
      (err, stdout, stderr) => callback(err, String(stdout), String(stderr)),
    );
  };

export function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
  runner?: GitRunner,
): Promise<GitRunResult> {
  const run = runner ?? realRunner(cwd, timeoutMs, maxBuffer);
  return new Promise((resolve, reject) => {
    run(args, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new Error(`git ${args[0]} timed out (${timeoutMs}ms)`));
        return;
      }
      // git 可执行文件不存在（竞态：探测后刚卸载）
      if (err && err.code === "ENOENT") {
        reject(err);
        return;
      }
      // maxBuffer 截断：Node ≥22 的 err.code 是字符串 ERR_CHILD_PROCESS_STDIO_MAXBUFFER
      //（旧版 ERR_OUT_OF_RANGE / ENOBUFS 一并兼容）；截断按成功+truncated 标记处理
      const truncated =
        !!err &&
        (err.code === "ERR_OUT_OF_RANGE" ||
          err.code === "ENOBUFS" ||
          err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      // err.code 为字符串（截断等）或 null（信号杀死）时不是进程退出码：
      // 截断归 0（带 truncated 标记），其余 err 归 1 走失败路径，不得静默按成功处理
      const code = typeof err?.code === "number" ? err.code : err ? (truncated ? 0 : 1) : 0;
      resolve({ code, stdout, stderr, truncated });
    });
  });
}
