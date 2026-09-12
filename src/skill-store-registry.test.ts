// skill-store registry 写入 scheme 守卫：明文 http 的 registry 会 MITM 技能载荷。
import { test, expect, vi } from "vitest";
import { useTempStateDir } from "./test-support/vitest-state-dir";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "2026.912.0",
    isPackaged: false,
    getAppPath: () => "/app",
  },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("./build-config", () => ({
  readBuildConfigClawhubRegistry: () => null,
}));

const stateDir = useTempStateDir("skill-store-registry-test-");

test("writeSkillStoreRegistry：https 放行，http 限回环，其余拒绝", async () => {
  const { writeSkillStoreRegistry, readSkillStoreRegistry } = await import("./skill-store");

  // https 任意主机放行
  expect(() => writeSkillStoreRegistry("https://registry.example.com/")).not.toThrow();
  expect(readSkillStoreRegistry()).toBe("https://registry.example.com/");

  // http 仅本机回环放行（本地镜像场景）
  expect(() => writeSkillStoreRegistry("http://localhost:9000")).not.toThrow();
  expect(() => writeSkillStoreRegistry("http://127.0.0.1:9000")).not.toThrow();
  expect(readSkillStoreRegistry()).toBe("http://127.0.0.1:9000");

  // 明文 http 远端拒绝（技能清单/载荷可被篡改，技能会引导 agent 行为）
  expect(() => writeSkillStoreRegistry("http://registry.example.com")).toThrow(/https/);
  // 非 http(s) scheme 拒绝
  expect(() => writeSkillStoreRegistry("ftp://registry.example.com")).toThrow(/https/);
  expect(() => writeSkillStoreRegistry("file:///etc")).toThrow(/https/);
  // 非法 URL 拒绝
  expect(() => writeSkillStoreRegistry("not a url")).toThrow(/合法 URL/);

  // 空串 = 清除自定义，放行
  expect(() => writeSkillStoreRegistry("")).not.toThrow();
  expect(readSkillStoreRegistry()).toBe("");
});
