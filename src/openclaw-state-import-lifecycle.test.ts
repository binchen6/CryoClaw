// openclaw-state-import-lifecycle 测试（L3）：
// 归档可能来自旧内核机器，导入后、startGateway 前必须执行内核配置迁移。
import { test, expect, vi } from "vitest";

vi.mock("./openclaw-config-migration", () => ({
  migrateOpenclawConfigForKernelUpgrade: vi.fn(),
}));

test("importOpenclawState 在 startGateway 前执行内核配置迁移", async () => {
  const calls: string[] = [];
  const migration = await import("./openclaw-config-migration");
  (migration.migrateOpenclawConfigForKernelUpgrade as any).mockImplementation(() => {
    calls.push("migrate");
  });
  const { createOpenclawStateImportLifecycle } = await import("./openclaw-state-import-lifecycle");
  const lifecycle = createOpenclawStateImportLifecycle({
    quiesceGateway: async () => { calls.push("quiesce"); },
    validateArchive: async () => { calls.push("validate"); },
    stopGateway: async () => { calls.push("stop"); },
    importArchive: async () => { calls.push("import"); },
    reconcileHostState: async () => { calls.push("reconcile"); },
    syncImportedConfigState: async () => { calls.push("sync"); },
    startGateway: async () => { calls.push("start"); },
  });

  await lifecycle.importOpenclawState("/tmp/a.zip");
  expect(calls).toEqual(["quiesce", "validate", "stop", "import", "reconcile", "sync", "migrate", "start"]);
});

test("importOpenclawState 导入进行中重入被拒", async () => {
  const { createOpenclawStateImportLifecycle } = await import("./openclaw-state-import-lifecycle");
  let releaseStop: () => void = () => {};
  const lifecycle = createOpenclawStateImportLifecycle({
    quiesceGateway: async () => {},
    validateArchive: async () => {},
    stopGateway: () => new Promise<void>((r) => { releaseStop = r; }),
    importArchive: async () => {},
    reconcileHostState: async () => {},
    syncImportedConfigState: async () => {},
    startGateway: async () => {},
  });

  const first = lifecycle.importOpenclawState("/tmp/a.zip");
  await expect(lifecycle.importOpenclawState("/tmp/b.zip")).rejects.toThrow("正在导入");
  releaseStop();
  await first;
});
