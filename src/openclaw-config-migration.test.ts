// openclaw-config-migration 单元测试
//
// 迁移逻辑：根据内核版本门控（since: YYYY.M）从用户配置删除已废弃节点。
// 关键不变量：
//   1. 版本不可读 / 格式异常 / 未达到门控 → 保守跳过（不修改配置）
//   2. 达到门控且配置存在目标节点 → 删除并写回，log 输出移除清单
//   3. 配置中没有目标节点 → 不写文件
//   4. 任意步骤抛错 → 吞掉，不阻塞启动
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// vi.mock 工厂在 vi.mock 调用注册时只存储闭包，闭包内的变量引用在工厂被调用
// （即被 mock 的模块被 import 时）才求值。使用 const 容器对象避免 TDZ 问题。
const mockState: {
  gatewayPkgDir: string;
  userStateDir: string;
  currentConfig: any;
  writeCount: number;
  writeShouldThrow: boolean;
} = {
  gatewayPkgDir: "",
  userStateDir: "",
  currentConfig: {},
  writeCount: 0,
  writeShouldThrow: false,
};

vi.mock("./constants", () => ({
  // 仅暴露 migration 实际使用的一个函数；其他导出不需要
  resolveGatewayPackageDir: () => mockState.gatewayPkgDir,
  resolveUserStateDir: () => mockState.userStateDir,
}));

vi.mock("./provider-config", () => ({
  readUserConfig: () => mockState.currentConfig,
  writeUserConfig: (cfg: any) => {
    if (mockState.writeShouldThrow) {
      throw new Error("write failed (test)");
    }
    mockState.currentConfig = cfg;
    mockState.writeCount++;
  },
}));

vi.mock("./logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
  mockState.gatewayPkgDir = path.join(tmpDir, "gateway-pkg");
  fs.mkdirSync(mockState.gatewayPkgDir, { recursive: true });
  mockState.userStateDir = path.join(tmpDir, "user-state");
  fs.mkdirSync(path.join(mockState.userStateDir, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(mockState.gatewayPkgDir, "dist", "extensions"), { recursive: true });
  mockState.currentConfig = {};
  mockState.writeCount = 0;
  mockState.writeShouldThrow = false;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeKernelVersion(version: string): void {
  fs.writeFileSync(
    path.join(mockState.gatewayPkgDir, "package.json"),
    JSON.stringify({ version }),
  );
}

// ── 版本门控 ──

test("版本未达到门控值（2026.6.x）时不迁移", async () => {
  writeKernelVersion("2026.6.5");
  mockState.currentConfig = { agents: { defaults: { llm: "keep", model: "x" } }, tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBe("keep");
  expect(mockState.writeCount).toBe(0);
});

test("版本边界：2026.7.0 触发迁移（>=2026.7）", async () => {
  writeKernelVersion("2026.7.0");
  mockState.currentConfig = { agents: { defaults: { llm: "x" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

test("版本边界：2026.6.99 不触发迁移", async () => {
  writeKernelVersion("2026.6.99");
  mockState.currentConfig = { agents: { defaults: { llm: "x" } }, tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBe("x");
  expect(mockState.writeCount).toBe(0);
});

test("实际生产版本 2026.7.1-2 触发迁移", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: { defaults: { llm: "remove me" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

test("高版本号（2027.1.0）也触发迁移", async () => {
  writeKernelVersion("2027.1.0");
  mockState.currentConfig = { agents: { defaults: { llm: "x" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBeUndefined();
});

test("跨年版本 2027.12.0 触发迁移", async () => {
  writeKernelVersion("2027.12.0");
  mockState.currentConfig = { agents: { defaults: { llm: "x" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBeUndefined();
});

// ── 异常容错 ──

test("版本文件缺失时保守跳过", async () => {
  // 不写 package.json
  mockState.currentConfig = { agents: { defaults: { llm: "keep" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
  expect(mockState.currentConfig.agents.defaults.llm).toBe("keep");
  expect(mockState.writeCount).toBe(0);
});

test("版本文件非合法 JSON 时保守跳过", async () => {
  fs.writeFileSync(
    path.join(mockState.gatewayPkgDir, "package.json"),
    "not valid json {{{",
  );
  mockState.currentConfig = { agents: { defaults: { llm: "keep" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
  expect(mockState.currentConfig.agents.defaults.llm).toBe("keep");
});

test("版本号格式异常时保守跳过", async () => {
  writeKernelVersion("not-a-version");
  mockState.currentConfig = { agents: { defaults: { llm: "keep" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBe("keep");
  expect(mockState.writeCount).toBe(0);
});

test("package.json 缺 version 字段时保守跳过", async () => {
  fs.writeFileSync(
    path.join(mockState.gatewayPkgDir, "package.json"),
    JSON.stringify({ name: "openclaw" }),
  );
  mockState.currentConfig = { agents: { defaults: { llm: "keep" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBe("keep");
});

test("writeUserConfig 抛错时不向上传播", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: { defaults: { llm: "x" } } };
  mockState.writeShouldThrow = true;
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
});

// ── 节点结构 ──

test("配置没有目标字段时不写文件", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: { defaults: { other: "keep" } }, tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.writeCount).toBe(0);
  expect(mockState.currentConfig.agents.defaults.other).toBe("keep");
});

test("agents.defaults 节点不存在时不抛错", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: {}, tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
  expect(mockState.writeCount).toBe(0);
});

test("agents 节点不存在时不抛错", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { something: "else", tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
  expect(mockState.writeCount).toBe(0);
});

test("agents.defaults 是 null 时不抛错", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: { defaults: null } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
});

test("agents 是 null 时不抛错", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: null };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
});

// ── 仅删除目标字段，保留同级其他字段 ──

test("迁移只删 llm，保留 defaults 内其他字段", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = {
    agents: {
      defaults: {
        llm: "remove-me",
        model: { primary: "anthropic/claude" },
        workspace: "/path",
      },
      other: "kept",
    },
    top: "value",
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.llm).toBeUndefined();
  expect(mockState.currentConfig.agents.defaults.model).toEqual({ primary: "anthropic/claude" });
  expect(mockState.currentConfig.agents.defaults.workspace).toBe("/path");
  expect(mockState.currentConfig.agents.other).toBe("kept");
  expect(mockState.currentConfig.top).toBe("value");
});

test("同一 defaults 节点多个目标键时（未来扩展）一次写回", async () => {
  // 当前规则只有 agents.defaults.llm，但若未来加 agents.defaults.foo，
  // 同一次迁移应只调用 writeUserConfig 一次
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: { defaults: { llm: "x" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.writeCount).toBe(1);
});

test("deepseek 旧模型别名迁移：providers id + agents.defaults.model 引用", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = {
    models: {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          models: [{ id: "deepseek-chat", name: "deepseek-chat" }, { id: "deepseek-reasoner" }],
        },
        kimi: { models: [{ id: "k3" }] },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "deepseek/deepseek-reasoner",
          fallbacks: ["deepseek/deepseek-chat", "kimi/k3"],
        },
      },
    },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  const providers = mockState.currentConfig.models.providers;
  expect(providers.deepseek.models.map((m: any) => m.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  expect(providers.deepseek.models[0].name).toBe("deepseek-v4-flash");
  expect(providers.kimi.models[0].id).toBe("k3"); // 非 deepseek 不动
  expect(mockState.currentConfig.agents.defaults.model.primary).toBe("deepseek/deepseek-v4-pro");
  expect(mockState.currentConfig.agents.defaults.model.fallbacks).toEqual(["deepseek/deepseek-v4-flash", "kimi/k3"]);
  expect(mockState.writeCount).toBe(1);
});

test("deepseek 无旧名时不写文件", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = {
    models: { providers: { deepseek: { models: [{ id: "deepseek-v4-pro" }] } } },
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
    tools: { experimental: { planTool: true } }, // 隔离 planTool 迁移，只验证 deepseek 不写回
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.writeCount).toBe(0);
});

test("deepseek 迁移与 llm 删除同轮一次写回", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = {
    models: { providers: { deepseek: { models: [{ id: "deepseek-chat" }] } } },
    agents: { defaults: { llm: "x", model: { primary: "kimi/k3" } } },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.writeCount).toBe(1);
  expect(mockState.currentConfig.models.providers.deepseek.models[0].id).toBe("deepseek-v4-flash");
  expect(mockState.currentConfig.agents.defaults.llm).toBeUndefined();
});

// ── exec mode 非法值修正（approve-all → full，无版本门控）──

test("tools.exec.mode=approve-all 修正为 full 并写回", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { tools: { exec: { mode: "approve-all", host: "auto" } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.exec.mode).toBe("full");
  expect(mockState.currentConfig.tools.exec.host).toBe("auto"); // 同级字段保留
  expect(mockState.writeCount).toBe(1);
});

test("tools.exec.mode 为合法值（ask/auto/full）时不写文件", async () => {
  writeKernelVersion("2026.7.1-2");
  for (const mode of ["ask", "auto", "full"]) {
    mockState.currentConfig = { tools: { exec: { mode }, experimental: { planTool: true } } };
    mockState.writeCount = 0;
    const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
    migrateOpenclawConfigForKernelUpgrade();
    expect(mockState.currentConfig.tools.exec.mode).toBe(mode);
    expect(mockState.writeCount).toBe(0);
  }
});

test("tools.exec 节点缺失时 exec mode 迁移不抛错", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { something: "else", tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
  expect(mockState.writeCount).toBe(0);
});

// ── 实验性 planTool 启用（缺失补 true，显式 false 尊重不动，无版本门控）──

test("tools.experimental.planTool 缺失时补 true 并写回，同级字段保留", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { tools: { profile: "full", experimental: { otherFlag: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.experimental.planTool).toBe(true);
  expect(mockState.currentConfig.tools.experimental.otherFlag).toBe(true);
  expect(mockState.currentConfig.tools.profile).toBe("full");
  expect(mockState.writeCount).toBe(1);
});

test("tools 节点整体缺失时补建 experimental.planTool=true", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { something: "else" };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.experimental.planTool).toBe(true);
  expect(mockState.writeCount).toBe(1);
});

test("planTool 显式 false 时保持 false 且不写文件", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { tools: { experimental: { planTool: false } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.experimental.planTool).toBe(false);
  expect(mockState.writeCount).toBe(0);
});

test("planTool 已为 true 时不重复写文件", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.experimental.planTool).toBe(true);
  expect(mockState.writeCount).toBe(0);
});

// ── 2026.8 配置适配（tools.updatePlan / memory.search / meta.lastTouchedAt，双向）──

test("2026.8: experimental.planTool 搬到 tools.updatePlan 并删除 experimental 节点", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = { tools: { profile: "full", experimental: { planTool: true, otherFlag: 1 } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.updatePlan).toBe(true);
  expect(mockState.currentConfig.tools.experimental).toBeUndefined();
  expect(mockState.currentConfig.tools.profile).toBe("full");
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: planTool 显式 false 搬到 updatePlan 保持 false", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = { tools: { experimental: { planTool: false } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.updatePlan).toBe(false);
  expect(mockState.currentConfig.tools.experimental).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: tools 节点缺失时补建 updatePlan=true", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = { something: "else" };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.updatePlan).toBe(true);
  expect(mockState.currentConfig.tools.experimental).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: updatePlan 已就位且无残留时不写文件", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = { tools: { updatePlan: true } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.updatePlan).toBe(true);
  expect(mockState.writeCount).toBe(0);
});

test("2026.8: meta.lastTouchedAt 删除，lastTouchedVersion 保留", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = { meta: { lastTouchedAt: "2026-09-01", lastTouchedVersion: "2026.7.1-2" }, tools: { updatePlan: true } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.meta.lastTouchedAt).toBeUndefined();
  expect(mockState.currentConfig.meta.lastTouchedVersion).toBe("2026.7.1-2");
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: agents.defaults.memorySearch 搬到根级 memory.search", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = {
    agents: { defaults: { memorySearch: { enabled: true, model: "m" }, model: "x" } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.memory.search).toEqual({ enabled: true, model: "m" });
  expect(mockState.currentConfig.agents.defaults.memorySearch).toBeUndefined();
  expect(mockState.currentConfig.agents.defaults.model).toBe("x");
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: memory.search 同名键冲突时以根级为准，legacy 仅补缺", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = {
    memory: { search: { enabled: false, model: "new" } },
    agents: { defaults: { memorySearch: { enabled: true, remote: { baseUrl: "http://x" } } } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.memory.search.enabled).toBe(false);
  expect(mockState.currentConfig.memory.search.model).toBe("new");
  expect(mockState.currentConfig.memory.search.remote).toEqual({ baseUrl: "http://x" });
  expect(mockState.currentConfig.agents.defaults.memorySearch).toBeUndefined();
});

test("2026.7 不触发 2026.8 的删除/挪位规则", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = {
    meta: { lastTouchedAt: "keep" },
    agents: { defaults: { memorySearch: { enabled: true } } },
    tools: { experimental: { planTool: true } },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.meta.lastTouchedAt).toBe("keep");
  expect(mockState.currentConfig.agents.defaults.memorySearch).toEqual({ enabled: true });
  expect(mockState.currentConfig.tools.experimental.planTool).toBe(true);
  expect(mockState.writeCount).toBe(0);
});

test("回退 2026.7: tools.updatePlan 搬回 experimental.planTool", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { tools: { updatePlan: false } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.tools.experimental.planTool).toBe(false);
  expect(mockState.currentConfig.tools.updatePlan).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

test("回退 2026.7: memory.search 搬回 agents.defaults.memorySearch 并删除空 memory 壳", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { memory: { search: { enabled: true } }, tools: { experimental: { planTool: true } } };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.agents.defaults.memorySearch).toEqual({ enabled: true });
  expect(mockState.currentConfig.memory).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

// ── 2026.8: qqbot allowFrom 通配符清除（channelHostConfig 契约禁 "*"）──

test("2026.8: qqbot allowFrom [\"*\"] 替换为哨兵并清掉 dmPolicy=open", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = {
    channels: { qqbot: { enabled: true, allowFrom: ["*"], dmPolicy: "open" } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.channels.qqbot.allowFrom).toEqual(["openclaw:approval-disabled"]);
  expect(mockState.currentConfig.channels.qqbot.dmPolicy).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: qqbot allowFrom 混合列表只剔除 *，显式 ID 保留", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = {
    channels: { qqbot: { allowFrom: ["*", "ABCDEF123"] } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.channels.qqbot.allowFrom).toEqual(["ABCDEF123"]);
});

test("2026.8: qqbot accounts.* 内的 * 同样清除", async () => {
  writeKernelVersion("2026.8.2");
  mockState.currentConfig = {
    channels: { qqbot: { accounts: { bot1: { allowFrom: ["*"] } } } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.channels.qqbot.accounts.bot1.allowFrom).toEqual(["openclaw:approval-disabled"]);
});

test("2026.7 不动 qqbot allowFrom 通配符", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = {
    channels: { qqbot: { allowFrom: ["*"] } },
    tools: { experimental: { planTool: true } },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.channels.qqbot.allowFrom).toEqual(["*"]);
  expect(mockState.writeCount).toBe(0);
});

// ── 2026.8: 未安装的启用插件降级为禁用（plugin verification failed 防线）──

test("2026.8: enabled 但未安装的插件条目降级为禁用", async () => {
  writeKernelVersion("2026.8.2");
  fs.mkdirSync(path.join(mockState.gatewayPkgDir, "dist", "extensions", "kimi"), { recursive: true });
  const weixinDir = path.join(mockState.userStateDir, "extensions", "openclaw-weixin");
  fs.mkdirSync(weixinDir, { recursive: true });
  fs.writeFileSync(path.join(weixinDir, "package.json"), "{}"); // 有可运行载荷才算已安装
  mockState.currentConfig = {
    plugins: { entries: {
      kimi: { enabled: true },                 // bundled → 不动
      "openclaw-weixin": { enabled: true },    // 状态目录已安装 → 不动
      tavily: { enabled: true, config: { webSearch: { apiKey: "x" } } }, // 未安装 → 禁用
      "memory-lancedb": { enabled: false },    // 本就禁用 → 不动
    } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  const entries = mockState.currentConfig.plugins.entries;
  expect(entries.kimi.enabled).toBe(true);
  expect(entries["openclaw-weixin"].enabled).toBe(true);
  expect(entries.tavily.enabled).toBe(false);
  expect(entries.tavily.config.webSearch.apiKey).toBe("x"); // 配置本体保留
  expect(entries["memory-lancedb"].enabled).toBe(false);
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: 插件全部可解析时不写文件", async () => {
  writeKernelVersion("2026.8.2");
  fs.mkdirSync(path.join(mockState.gatewayPkgDir, "dist", "extensions", "kimi"), { recursive: true });
  mockState.currentConfig = {
    plugins: { entries: { kimi: { enabled: true } } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.plugins.entries.kimi.enabled).toBe(true);
  expect(mockState.writeCount).toBe(0);
});

test("2026.7 不做插件可用性降级", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = {
    plugins: { entries: { tavily: { enabled: true } } },
    tools: { experimental: { planTool: true } },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.plugins.entries.tavily.enabled).toBe(true);
  expect(mockState.writeCount).toBe(0);
});

test("2026.8: plugins.slots 引用未安装插件时摘除槽位", async () => {
  writeKernelVersion("2026.8.2");
  fs.mkdirSync(path.join(mockState.gatewayPkgDir, "dist", "extensions", "memory-core"), { recursive: true });
  mockState.currentConfig = {
    plugins: {
      entries: { "memory-core": { enabled: true } },
      slots: { memory: "modelstudio-memory-for-openclaw", other: "memory-core" },
    },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.plugins.slots.memory).toBeUndefined();
  expect(mockState.currentConfig.plugins.slots.other).toBe("memory-core");
  expect(mockState.writeCount).toBe(1);
});

// ── 2026.8: 已安装但无可运行载荷的启用插件降级（startup 收敛死循环防线）──
// 生产事故根因之二：ClawHub 纯技能插件（holo-wechat-mp）目录存在但只有
// openclaw.plugin.json + skills/，内核每轮 "Repaired missing configured plugin"
// 写入不持久 → convergence refusal 死循环，gateway 永不 ready。

test("2026.8: 纯技能插件（目录在但无 package.json 无 dist/）降级为禁用", async () => {
  writeKernelVersion("2026.8.2");
  const holoDir = path.join(mockState.userStateDir, "extensions", "holo-wechat-mp");
  fs.mkdirSync(path.join(holoDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(holoDir, "openclaw.plugin.json"), "{}");
  mockState.currentConfig = {
    plugins: { entries: { "holo-wechat-mp": { enabled: true, config: { keep: 1 } } } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.plugins.entries["holo-wechat-mp"].enabled).toBe(false);
  expect(mockState.currentConfig.plugins.entries["holo-wechat-mp"].config.keep).toBe(1); // 配置本体保留
  expect(mockState.writeCount).toBe(1);
});

test("2026.8: 有 package.json 的已安装插件不动", async () => {
  writeKernelVersion("2026.8.2");
  const dir = path.join(mockState.userStateDir, "extensions", "openclaw-weixin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  mockState.currentConfig = {
    plugins: { entries: { "openclaw-weixin": { enabled: true } } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.plugins.entries["openclaw-weixin"].enabled).toBe(true);
  expect(mockState.writeCount).toBe(0);
});

test("2026.8: 有 dist/ 无 package.json 的已安装插件不动", async () => {
  writeKernelVersion("2026.8.2");
  fs.mkdirSync(path.join(mockState.userStateDir, "extensions", "wecom-openclaw-plugin", "dist"), { recursive: true });
  mockState.currentConfig = {
    plugins: { entries: { "wecom-openclaw-plugin": { enabled: true } } },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.plugins.entries["wecom-openclaw-plugin"].enabled).toBe(true);
  expect(mockState.writeCount).toBe(0);
});

test("2026.8: slots 引用无载荷插件同样摘除", async () => {
  writeKernelVersion("2026.8.2");
  const holoDir = path.join(mockState.userStateDir, "extensions", "holo-wechat-mp");
  fs.mkdirSync(holoDir, { recursive: true });
  fs.writeFileSync(path.join(holoDir, "openclaw.plugin.json"), "{}");
  mockState.currentConfig = {
    plugins: {
      entries: { "holo-wechat-mp": { enabled: false } },
      slots: { context: "holo-wechat-mp" },
    },
    tools: { updatePlan: true },
  };
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  migrateOpenclawConfigForKernelUpgrade();
  expect(mockState.currentConfig.plugins.slots.context).toBeUndefined();
  expect(mockState.writeCount).toBe(1);
});

test("迁移抛错时记 log.error（不再静默吞错）", async () => {
  writeKernelVersion("2026.7.1-2");
  mockState.currentConfig = { agents: { defaults: { llm: "x" } } };
  mockState.writeShouldThrow = true;
  const logger = await import("./logger");
  const { migrateOpenclawConfigForKernelUpgrade } = await import("./openclaw-config-migration");
  expect(() => migrateOpenclawConfigForKernelUpgrade()).not.toThrow();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("迁移失败"));
});
