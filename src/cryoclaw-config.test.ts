import { test, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { useTempStateDir } from "./vitest-state-dir";

vi.mock("electron", () => ({
  app: { getVersion: () => "2026.3.10" },
}));

const stateDir = useTempStateDir("cryoclaw-config-test-");

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
  expect(fs.existsSync(path.join(stateDir.dir, "cryoclaw.config.json"))).toBe(true);
  expect(fs.existsSync(path.join(stateDir.dir, "oneclaw.config.json"))).toBe(false);
});

test("readCryoclawConfig 读不到新文件时 fallback 旧 oneclaw.config.json", async () => {
  const { readCryoclawConfig } = await import("./cryoclaw-config");
  // 只有上一代配置文件时也能读到（保住 updateChannel 等老设置）
  fs.writeFileSync(
    path.join(stateDir.dir, "oneclaw.config.json"),
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
    path.join(stateDir.dir, "oneclaw.config.json"),
    JSON.stringify({ updateChannel: "dev" }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(stateDir.dir, "cryoclaw.config.json"),
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
    path.join(stateDir.dir, "oneclaw.config.json"),
    JSON.stringify({ setupCompletedAt: "2026-03-10T00:00:00.000Z" }),
    "utf-8",
  );
  expect(detectOwnership()).toBe("cryoclaw");
});

test("detectOwnership 有 setup-baseline 文件时返回 legacy-cryoclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, "openclaw-setup-baseline.json"), "{}", "utf-8");
  expect(detectOwnership()).toBe("legacy-cryoclaw");
});

test("detectOwnership 有 .device-id 但无 CryoClaw 独有文件时返回 external-openclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, ".device-id"), "some-uuid", "utf-8");
  fs.writeFileSync(path.join(stateDir.dir, "openclaw.json"), "{}", "utf-8");
  expect(detectOwnership()).toBe("external-openclaw");
});

test("detectOwnership 有 openclaw.json 无 .device-id 无 cryoclaw.config.json 时返回 external-openclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, "openclaw.json"), "{}", "utf-8");
  expect(detectOwnership()).toBe("external-openclaw");
});

test("migrateFromLegacy 从 wizard.lastRunAt 和 skill-store.json 迁移", async () => {
  // deviceId 不再迁入 cryoclaw.config.json（commit 2958084 起改由 .device-id 文件独立管理）
  const { migrateFromLegacy, readCryoclawConfig } = await import("./cryoclaw-config");
  fs.writeFileSync(
    path.join(stateDir.dir, "openclaw.json"),
    JSON.stringify({ wizard: { lastRunAt: "2026-01-01T00:00:00.000Z" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(stateDir.dir, "skill-store.json"),
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

test("migrateFromLegacy 补齐 legacy 文件的全部已知字段", async () => {
  const { migrateFromLegacy, readCryoclawConfig } = await import("./cryoclaw-config");
  fs.writeFileSync(
    path.join(stateDir.dir, "oneclaw.config.json"),
    JSON.stringify({
      setupCompletedAt: "2025-12-01T00:00:00.000Z",
      updateChannel: "dev",
      cliPreference: "installed",
      channelId: "channel-x",
      channelSource: "installer",
      lastShownReleaseNotesVersion: "2026.2.1",
      skillStore: { registryUrl: "https://legacy.registry" },
    }),
    "utf-8",
  );

  const result = migrateFromLegacy();
  expect(result.setupCompletedAt).toBe("2025-12-01T00:00:00.000Z");
  expect(result.updateChannel).toBe("dev");
  expect(result.cliPreference).toBe("installed");
  expect(result.channelId).toBe("channel-x");
  expect(result.channelSource).toBe("installer");
  expect(result.lastShownReleaseNotesVersion).toBe("2026.2.1");
  expect(result.skillStore?.registryUrl).toBe("https://legacy.registry");

  // 已落盘到新文件
  const saved = readCryoclawConfig();
  expect(saved?.updateChannel).toBe("dev");
  expect(saved?.channelId).toBe("channel-x");
});

test("migrateFromLegacy 新文件已存在的值优先，仅补齐缺失字段", async () => {
  const { migrateFromLegacy, readCryoclawConfig } = await import("./cryoclaw-config");
  fs.writeFileSync(
    path.join(stateDir.dir, "cryoclaw.config.json"),
    JSON.stringify({ updateChannel: "off", skillStore: { registryUrl: "https://new.registry" } }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(stateDir.dir, "oneclaw.config.json"),
    JSON.stringify({
      updateChannel: "dev",
      channelId: "channel-x",
      skillStore: { registryUrl: "https://legacy.registry" },
    }),
    "utf-8",
  );

  const result = migrateFromLegacy();
  // 新文件已有值不被覆盖
  expect(result.updateChannel).toBe("off");
  expect(result.skillStore?.registryUrl).toBe("https://new.registry");
  // 缺失字段从 legacy 补齐
  expect(result.channelId).toBe("channel-x");
  expect(readCryoclawConfig()?.channelId).toBe("channel-x");
});

test("migrateFromLegacy 不迁移 gatewayControl（运行时连接信息）", async () => {
  const { migrateFromLegacy } = await import("./cryoclaw-config");
  fs.writeFileSync(
    path.join(stateDir.dir, "oneclaw.config.json"),
    JSON.stringify({ gatewayControl: { port: 12345, token: "stale" } }),
    "utf-8",
  );
  const result = migrateFromLegacy();
  expect(result.gatewayControl).toBeUndefined();
});
