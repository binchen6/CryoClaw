// 配置归属四态判定集成测试
import { test, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { useTempStateDir } from "./vitest-state-dir";

vi.mock("electron", () => ({
  app: { getVersion: () => "2026.3.10" },
}));

const stateDir = useTempStateDir("ownership-test-");

test("全新安装：无文件 → fresh", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  expect(detectOwnership()).toBe("fresh");
});

test("正常启动：cryoclaw.config.json 完整 → cryoclaw", async () => {
  const { writeCryoclawConfig, detectOwnership } = await import("./cryoclaw-config");
  writeCryoclawConfig({ setupCompletedAt: "2026-03-10T00:00:00.000Z" });
  expect(detectOwnership()).toBe("cryoclaw");
});

test("老用户升级：有 setup-baseline 无 cryoclaw.config.json → legacy-cryoclaw", async () => {
  // legacy 标记是 openclaw-setup-baseline.json；.device-id 官方 CLI 也会创建，不可靠
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, "openclaw-setup-baseline.json"), "{}");
  expect(detectOwnership()).toBe("legacy-cryoclaw");
});

test("外部 OpenClaw：有 openclaw.json 无归属 → external-openclaw", async () => {
  const { detectOwnership } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, "openclaw.json"), "{}");
  expect(detectOwnership()).toBe("external-openclaw");
});

test("迁移后 .device-id 的 deviceId 被保留", async () => {
  // deviceId 由 .device-id 文件独立管理（与官方 CLI 共用），迁移不动它；
  // ensureDeviceId 应继续读到原值而不是生成新 UUID
  const { migrateFromLegacy, ensureDeviceId } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, ".device-id"), "preserved-id");
  fs.writeFileSync(path.join(stateDir.dir, "openclaw.json"), JSON.stringify({
    wizard: { lastRunAt: "2026-01-01T00:00:00.000Z" },
  }));
  migrateFromLegacy();
  expect(ensureDeviceId()).toBe("preserved-id");
});

test("markSetupComplete 创建完整的 cryoclaw.config.json", async () => {
  const { markSetupComplete, detectOwnership } = await import("./cryoclaw-config");
  markSetupComplete();
  expect(detectOwnership()).toBe("cryoclaw");
});

test("迁移保留 skill-store.json 的 registryUrl", async () => {
  const { migrateFromLegacy, readCryoclawConfig } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, ".device-id"), "id-1");
  fs.writeFileSync(path.join(stateDir.dir, "openclaw.json"), "{}");
  fs.writeFileSync(path.join(stateDir.dir, "skill-store.json"), JSON.stringify({
    registryUrl: "https://my-registry.com",
  }));
  migrateFromLegacy();
  expect(readCryoclawConfig()?.skillStore?.registryUrl).toBe("https://my-registry.com");
});

test("ensureDeviceId 无 .device-id 文件时自动创建", async () => {
  const { ensureDeviceId } = await import("./cryoclaw-config");
  const id = ensureDeviceId();
  expect(id).toBeTruthy();
  expect(fs.readFileSync(path.join(stateDir.dir, ".device-id"), "utf-8").trim()).toBe(id);
});

test("ensureDeviceId 已有 .device-id 文件时返回现有 ID", async () => {
  const { ensureDeviceId } = await import("./cryoclaw-config");
  fs.writeFileSync(path.join(stateDir.dir, ".device-id"), "existing-id");
  expect(ensureDeviceId()).toBe("existing-id");
});
