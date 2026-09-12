// readUserConfig 原文缓存（R77）的失效语义：键控 (mtimeMs, size)，
// 外部改写/原子替换必须让缓存失效，读-改-写仍拿到独立对象。
import { test, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cache-test-"));
const cfgPath = path.join(tmpDir, "openclaw.json");

vi.mock("./constants", () => ({
  resolveUserConfigPath: () => cfgPath,
  resolveUserStateDir: () => tmpDir,
}));
// 隔离依赖链：writeUserConfig 会触达的旁路模块与本测试无关
vi.mock("./openclaw-health-state", () => ({ syncOpenClawStateAfterWrite: () => {} }));
vi.mock("./config-backup", () => ({ backupCurrentUserConfig: () => {} }));
vi.mock("./provider-image-probe", () => ({ probeImageSupport: async () => null }));
vi.mock("./wecom-config", () => ({ verifyWecom: async () => {} }));

test("readUserConfig 缓存：外部改写失效 + 返回独立对象", async () => {
  const { readUserConfig } = await import("./provider-config");

  // 1) 无文件 → {}
  expect(readUserConfig()).toEqual({});

  // 2) 首次写入后可读
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1 }), "utf-8");
  expect(readUserConfig()).toEqual({ version: 1 });

  // 3) 同一内容重复读：返回独立对象（调用方改写互不可见）
  const a = readUserConfig();
  const b = readUserConfig();
  expect(a).not.toBe(b);
  a.injected = true;
  expect(b.injected).toBeUndefined();
  expect(readUserConfig().injected).toBeUndefined();

  // 4) 外部改写（mtime/size 变化）→ 缓存失效
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 2, extra: "x".repeat(64) }), "utf-8");
  expect(readUserConfig()).toEqual({ version: 2, extra: "x".repeat(64) });

  // 5) 文件删除 → 回到 {}
  fs.rmSync(cfgPath, { force: true });
  expect(readUserConfig()).toEqual({});

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
