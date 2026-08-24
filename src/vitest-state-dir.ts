/**
 * vitest 用例共享的临时 OPENCLAW_STATE_DIR 环境装配
 * （cryoclaw-config.test.ts / startup-ownership.test.ts 共用）。
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { beforeEach, afterEach, vi } from "vitest";

// 登记 beforeEach/afterEach：每个用例独立的临时状态目录 + 环境还原与清理。
// 返回的 holder.dir 在用例内读取即为当前目录。
export function useTempStateDir(prefix: string): { dir: string } {
  const holder = { dir: "" };
  beforeEach(() => {
    holder.dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    vi.stubEnv("OPENCLAW_STATE_DIR", holder.dir);
  });
  afterEach(() => {
    fs.rmSync(holder.dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  return holder;
}
