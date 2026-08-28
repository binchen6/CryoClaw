// git CLI 探测 —— worktrees 等依赖 git 的功能的降级开关
// 模式与 install-detector.ts 一致：execFile + 超时 + windowsHide；结果缓存一次
// （git 安装状态在 app 生命周期内视为不变，不重复探测）
import { execFile } from "child_process";
import * as log from "./logger";

const EXEC_TIMEOUT_MS = 5_000;

export type GitDetection = { available: boolean; version: string | null };

// 从 `git --version` 输出提取版本号（"git version 2.43.0.windows.1" → "2.43.0.windows.1"）
export function parseGitVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^git version (\S+)/i);
  return match ? match[1] : null;
}

// 底层 runner 可注入（测试用）；默认 execFile git --version
export type GitRunner = () => Promise<string>;

function defaultRunner(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--version"],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function detectGit(run: GitRunner = defaultRunner): Promise<GitDetection> {
  try {
    const out = await run();
    const version = parseGitVersion(out);
    if (!version) {
      log.warn(`[git-detector] unexpected git --version output: ${out.slice(0, 80)}`);
      return { available: false, version: null };
    }
    log.info(`[git-detector] git available: ${version}`);
    return { available: true, version };
  } catch (err) {
    log.info(`[git-detector] git unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { available: false, version: null };
  }
}

let cached: Promise<GitDetection> | null = null;

// 探测一次并缓存；首个调用方可注入 runner（测试用），后续调用返回缓存结果
export function detectGitCached(run?: GitRunner): Promise<GitDetection> {
  if (!cached) {
    cached = detectGit(run);
  }
  return cached;
}

// 测试专用：重置缓存
export function resetGitDetectionCacheForTest(): void {
  cached = null;
}
