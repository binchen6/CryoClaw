import { test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("electron", () => ({
  app: { getVersion: () => "2026.3.10" },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-config-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("readCryoclawConfig 无文件时返回 null", async () => {
  const { readCryoclawConfig } = await import("./cryoclaw-config");
  expect(readCryoclawConfig()).toBeNull();
});

test("writeCryoclawConfig + readCryoclawConfig 往返一致", async () => {
  const { readCryoclawConfig, writeCryoclawConfig } = await import("./cryoclaw-config");
  const config = {
    setupCompletedAt: "2026-03-10T00:00:00.000Z",
  };
  writeCryoclawConfig(config);
  expect(readCryoclawConfig()).toEqual(config);
  // 写只写新文件名
  expect(fs.existsSync(path.join(tmpDir, "cryoclaw.config.json"))).toBe(true);
  expect(fs.existsSync(path.join(tmpDir, "oneclaw.config.json"))).toBe(false);
});

test("readCryoclawConfig 读不到新文件时 fallback 旧 oneclaw.config.json", async () => {
  const { readCryoclawConfig } = await import("./cryoclaw-config");
  // 只有上一代配置文件时也能读到（保住 updateChannel 等老设置）
  fs.writeFileSync(
    path.join(tmpDir, "oneclaw.config.json"),
    JSON.stringify({ updateChannel: "dev", setupCompletedAt: "2026-01-01T00:00:00.000Z" }),
    "utf-8",
  );
  const config = readCryoclawConfig();
  expect(config?.updateChannel).toBe("dev");
  expect(config?.setupCompletedAt).toBe("2026-01-01T00:00:00.000Z");
});

test("readCryoclawConfig 新文件存在时优先于旧文件", async () => {
  const { readCryoclawConfig } = await import("./cryoclaw-config");
  fs.writeFileSync(
    path.join(tmpDir, "oneclaw.config.json"),
    JSON.stringify({ updateChannel: "dev" }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(tmpDir, "cryoclaw.config.json"),
    JSON.stringify({ updateChannel: "off" }),
    "utf-8",
  );
  expect(readCryoclawConfig()?.updateChannel).toBe("off");
});

test("detectOwnership 无任何文件时返回 fresh", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  expect(detectOwnership()).toBe("fresh");
});

test("detectOwnership 有 cryoclaw.config.json + setupCompletedAt 时返回 cryoclaw", async () => {
  const { writeCryoclawConfig, detectOwnership } = await import("./cryoclaw-config");
  writeCryoclawConfig({
    setupCompletedAt: "2026-03-10T00:00:00.000Z",
  });
  expect(detectOwnership()).toBe("cryoclaw");
});

test("detectOwnership 只有旧 oneclaw.config.json（含 setupCompletedAt）时也返回 cryoclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(
    path.join(tmpDir, "oneclaw.config.json"),
    JSON.stringify({ setupCompletedAt: "2026-03-10T00:00:00.000Z" }),
    "utf-8",
  );
  expect(detectOwnership()).toBe("cryoclaw");
});

test("detectOwnership 有 setup-baseline 文件时返回 legacy-cryoclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(tmpDir, "openclaw-setup-baseline.json"), "{}", "utf-8");
  expect(detectOwnership()).toBe("legacy-cryoclaw");
});

test("detectOwnership 有 .device-id 但无 CryoClaw 独有文件时返回 external-openclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(tmpDir, ".device-id"), "some-uuid", "utf-8");
  fs.writeFileSync(path.join(tmpDir, "openclaw.json"), "{}", "utf-8");
  expect(detectOwnership()).toBe("external-openclaw");
});

test("detectOwnership 有 openclaw.json 无 .device-id 无 cryoclaw.config.json 时返回 external-openclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(tmpDir, "openclaw.json"), "{}", "utf-8");
  expect(detectOwnership()).toBe("external-openclaw");
});

test("migrateFromLegacy 从 wizard.lastRunAt 和 skill-store.json 迁移", async () => {
  // deviceId 不再迁入 cryoclaw.config.json（commit 2958084 起改由 .device-id 文件独立管理）
  const { migrateFromLegacy, readCryoclawConfig } = await import("./cryoclaw-config");
  fs.writeFileSync(
    path.join(tmpDir, "openclaw.json"),
    JSON.stringify({ wizard: { lastRunAt: "2026-01-01T00:00:00.000Z" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(tmpDir, "skill-store.json"),
    JSON.stringify({ registryUrl: "https://custom.registry" }),
    "utf-8",
  );

  const result = migrateFromLegacy();
  expect(result.setupCompletedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(result.skillStore?.registryUrl).toBe("https://custom.registry");

  const saved = readCryoclawConfig();
  expect(saved?.setupCompletedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(saved?.skillStore?.registryUrl).toBe("https://custom.registry");
});

test("markSetupComplete 写入 setupCompletedAt", async () => {
  const { markSetupComplete, readCryoclawConfig } = await import("./cryoclaw-config");
  markSetupComplete();
  const config = readCryoclawConfig();
  expect(config?.setupCompletedAt).toBeTruthy();
  expect(typeof config?.setupCompletedAt).toBe("string");
});
