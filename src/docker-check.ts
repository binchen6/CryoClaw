/**
 * docker-check.ts — 沙盒模式前置检测：本机 Docker 是否可用。
 *
 * 内核沙盒（agents.defaults.sandbox.mode != off / tools.exec.host = sandbox）
 * 依赖 docker CLI + 守护进程。未安装时内核只在 agent 运行期才报
 * "spawn docker ENOENT"（英文内核错误），用户在 UI 上无法预知。
 * CryoClaw 在设置页展示与保存时先做检测，给出可操作的中文引导。
 *
 * 检测结果缓存 60s：设置页会反复读取，docker version 本身有进程启动开销。
 */

import { spawn } from "child_process";

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;

let cached: { at: number; available: boolean } | null = null;

/** 清空缓存（测试用；用户刚装好 Docker 时可强制复检）。 */
export function resetDockerCheckCache(): void {
  cached = null;
}

function probeDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (available: boolean) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // 同时验证客户端在 PATH 且守护进程在线（--format 取 Server.Version 需连 daemon）。
      // 仅客户端存在而 daemon 未启动时沙盒同样不可用，返回 false 引导用户启动 Docker。
      child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false)); // ENOENT：docker 不在 PATH
    child.on("close", (code) => done(code === 0));
  });
}

export async function checkDockerAvailable(opts?: { force?: boolean }): Promise<boolean> {
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.available;
  }
  const available = await probeDocker();
  cached = { at: Date.now(), available };
  return available;
}
