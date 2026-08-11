import { test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kimi-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("saveKimiSearchConfig allow 非空时把 kimi-search 同步 push 进 allow", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const config: any = {
    plugins: { allow: ["openclaw-weixin", "browser", "moonshot"], entries: {} },
  };
  saveKimiSearchConfig(config, { enabled: true });
  expect(config.plugins.allow).toContain("kimi-search");
  // 已有的不被移除
  expect(config.plugins.allow).toEqual(
    expect.arrayContaining(["openclaw-weixin", "browser", "moonshot", "kimi-search"]),
  );
});

test("saveKimiSearchConfig allow 为空数组或缺失时不主动创建/写入", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const c1: any = { plugins: { allow: [], entries: {} } };
  saveKimiSearchConfig(c1, { enabled: true });
  expect(c1.plugins.allow).toEqual([]);

  const c2: any = { plugins: { entries: {} } };
  saveKimiSearchConfig(c2, { enabled: true });
  expect(c2.plugins.allow).toBeUndefined();
});

test("saveKimiSearchConfig 重复 enable 时 allow 不重复 push", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const config: any = {
    plugins: { allow: ["browser", "kimi-search"], entries: {} },
  };
  saveKimiSearchConfig(config, { enabled: true });
  expect(config.plugins.allow.filter((x: string) => x === "kimi-search")).toHaveLength(1);
});

test("saveKimiSearchConfig disable 不从 allow 移除", async () => {
  const { saveKimiSearchConfig } = await import("./kimi-config");
  const config: any = {
    plugins: { allow: ["browser", "kimi-search"], entries: {} },
  };
  saveKimiSearchConfig(config, { enabled: false });
  expect(config.plugins.allow).toContain("kimi-search");
});
