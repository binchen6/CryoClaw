// kernel-updater 单元测试
//
// 重点验证编排逻辑（orchestrate）：
//   - 停 gateway → 跑 updater → 配置迁移 → 启 gateway → 健康检查失败自动回滚
//   - swap 之后失败时 best-effort 回滚
//   - wasRunning 决定 catch 中是否恢复启动 gateway
//   - 单任务并发护栏
//   - checkKernelUpdate 解析 state 事件缓存到 lastCheck
//
// 不验证 updater 脚本本身（那是 scripts/updater/kernel-update.mjs 的责任），
// 也不验证 IPC 通道连接（main.ts 集成层）。
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import type { Deps, KernelUpdateState } from "./kernel-updater";

// ── Mocks ──
// vi.mock 工厂闭包延迟执行：模块被 import 时才调用，此时外层 const 容器已初始化。
const mockState: {
  resourcesDir: string;
  spawnImpl: (args: string[]) => ChildLike;
  kernelVersionParts: { year: number; month: number } | null;
} = {
  resourcesDir: "",
  spawnImpl: () => makeChild([]),
  kernelVersionParts: null,
};

vi.mock("child_process", () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => mockState.spawnImpl(args)),
}));

vi.mock("./constants", () => ({
  resolveResourcesPath: () => mockState.resourcesDir,
  resolveNodeBin: () => "/fake/node",
  resolveNodeExtraEnv: () => ({ ELECTRON_RUN_AS_NODE: "1" }),
  resolveCliExe: () => null,
}));

vi.mock("./logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./openclaw-config-migration", () => ({
  migrateOpenclawConfigForKernelUpgrade: vi.fn(),
  // 版本判定由测试直接喂 parts（真实实现读 gateway 包 package.json）
  readKernelVersionParts: () => mockState.kernelVersionParts,
  versionAtLeast: (v: { year: number; month: number }, s: { year: number; month: number }) =>
    v.year > s.year || (v.year === s.year && v.month >= s.month),
}));

// ── Helpers ──

// 模拟 child_process.spawn 返回的子进程对象。
type ChildLike = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
};

interface UpdaterEvent {
  type: string;
  [k: string]: any;
}

function makeChild(events: UpdaterEvent[], exitCode = 0): ChildLike {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as ChildLike;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  setImmediate(() => {
    for (const e of events) {
      stdout.emit("data", Buffer.from(JSON.stringify(e) + "\n", "utf-8"));
    }
    child.emit("close", exitCode);
  });
  return child;
}

// 阻塞式 child：不立即 close，调用 release() 后才发事件并 close。
function makeBlockingChild(): ChildLike & { release: (events: UpdaterEvent[], exitCode?: number) => void } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as ChildLike;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  let released = false;
  const release = (events: UpdaterEvent[], exitCode = 0) => {
    if (released) return;
    released = true;
    for (const e of events) {
      stdout.emit("data", Buffer.from(JSON.stringify(e) + "\n", "utf-8"));
    }
    child.emit("close", exitCode);
  };
  return Object.assign(child, { release });
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    stopGateway: vi.fn().mockResolvedValue(undefined),
    startGateway: vi.fn().mockResolvedValue(true),
    getGatewayState: vi.fn().mockReturnValue("running"),
    push: vi.fn(),
    ...overrides,
  };
}

function makeProgressEvents(): UpdaterEvent[] {
  return [
    { type: "progress", step: "staging", pct: 10, msg: "下载" },
    { type: "progress", step: "swap", pct: 50, msg: "换装" },
    { type: "progress", step: "smoke", pct: 90, msg: "冒烟" },
    { type: "done", action: "update", from: "2026.7.1-2", to: "2026.7.2" },
  ];
}

function makeRollbackEvents(): UpdaterEvent[] {
  return [
    { type: "progress", step: "swap", pct: 50, msg: "回滚换装" },
    { type: "done", action: "rollback", from: "2026.7.2", to: "2026.7.1-2" },
  ];
}

function makeStateEvents(over: Partial<KernelUpdateState> = {}): UpdaterEvent[] {
  return [{
    type: "state",
    current: over.current ?? "2026.7.1-2",
    latest: over.latest ?? "2026.7.2",
    updateAvailable: over.updateAvailable ?? true,
    rollbackAvailable: over.rollbackAvailable ?? true,
    checkError: over.checkError ?? null,
  }];
}

// ── State ──

let tmpDir: string;
let updaterScriptPath: string;

beforeEach(() => {
  // 重置模块缓存，让 kernel-updater 的内部状态（deps / running / lastCheck）重新初始化
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-updater-test-"));
  mockState.resourcesDir = path.join(tmpDir, "resources");
  const updaterDir = path.join(mockState.resourcesDir, "updater");
  fs.mkdirSync(updaterDir, { recursive: true });
  updaterScriptPath = path.join(updaterDir, "kernel-update.mjs");
  fs.writeFileSync(updaterScriptPath, "// mock");
  // 默认 spawn 行为：空事件、退出 0
  mockState.spawnImpl = () => makeChild([]);
  mockState.kernelVersionParts = null;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── isKernelUpdaterAvailable / getKernelUpdateState ──

test("isKernelUpdaterAvailable：脚本存在时返回 true", async () => {
  const { isKernelUpdaterAvailable } = await import("./kernel-updater");
  expect(isKernelUpdaterAvailable()).toBe(true);
});

test("isKernelUpdaterAvailable：脚本不存在时返回 false", async () => {
  fs.unlinkSync(updaterScriptPath);
  const { isKernelUpdaterAvailable } = await import("./kernel-updater");
  expect(isKernelUpdaterAvailable()).toBe(false);
});

test("getKernelUpdateState：初始默认值", async () => {
  const { getKernelUpdateState } = await import("./kernel-updater");
  const s = getKernelUpdateState();
  expect(s.available).toBe(true);
  expect(s.current).toBeNull();
  expect(s.latest).toBeNull();
  expect(s.updateAvailable).toBe(false);
  expect(s.rollbackAvailable).toBe(false);
  expect(s.running).toBe(false);
  expect(s.checkError).toBeNull();
});

// ── checkKernelUpdate ──

test("checkKernelUpdate：updater 不可用时直接返回当前状态", async () => {
  fs.unlinkSync(updaterScriptPath);
  const { checkKernelUpdate } = await import("./kernel-updater");
  const state = await checkKernelUpdate();
  expect(state.available).toBe(false);
  expect(state.current).toBeNull();
});

test("checkKernelUpdate：解析 state 事件并缓存到 lastCheck", async () => {
  mockState.spawnImpl = () => makeChild(makeStateEvents());
  const { checkKernelUpdate, getKernelUpdateState } = await import("./kernel-updater");
  const state = await checkKernelUpdate();
  expect(state.current).toBe("2026.7.1-2");
  expect(state.latest).toBe("2026.7.2");
  expect(state.updateAvailable).toBe(true);
  expect(state.rollbackAvailable).toBe(true);
  expect(state.checkError).toBeNull();
  // 缓存到 getKernelUpdateState
  expect(getKernelUpdateState().current).toBe("2026.7.1-2");
});

test("checkKernelUpdate：state 事件携带 checkError 时缓存错误", async () => {
  mockState.spawnImpl = () => makeChild([{
    type: "state",
    current: "2026.7.1-2",
    latest: null,
    updateAvailable: false,
    rollbackAvailable: false,
    checkError: "registry unreachable",
  }]);
  const { checkKernelUpdate } = await import("./kernel-updater");
  const state = await checkKernelUpdate();
  expect(state.checkError).toBe("registry unreachable");
});

test("checkKernelUpdate：updater 子进程退出非 0 时抛错", async () => {
  mockState.spawnImpl = () => makeChild([], 1);
  const { checkKernelUpdate } = await import("./kernel-updater");
  await expect(checkKernelUpdate()).rejects.toThrow();
});

test("checkKernelUpdate：updater 输出 error 事件时退出非 0 抛错带 message", async () => {
  mockState.spawnImpl = () => makeChild(
    [{ type: "error", message: "asar 校验失败" }],
    1,
  );
  const { checkKernelUpdate } = await import("./kernel-updater");
  await expect(checkKernelUpdate()).rejects.toThrow("asar 校验失败");
});

// ── initKernelUpdater / runKernelUpdate / runKernelRollback ──

test("runKernelUpdate：未初始化 deps 时返回错误", async () => {
  const { runKernelUpdate } = await import("./kernel-updater");
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("未初始化");
});

test("runKernelUpdate：updater 不可用时返回错误", async () => {
  fs.unlinkSync(updaterScriptPath);
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("缺少内核升级器资源");
});

test("runKernelUpdate：成功路径", async () => {
  mockState.spawnImpl = () => makeChild(makeProgressEvents());
  const { initKernelUpdater, runKernelUpdate, getKernelUpdateState } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  const result = await runKernelUpdate("2026.7.2");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.action).toBe("update");
    expect(result.from).toBe("2026.7.1-2");
    expect(result.to).toBe("2026.7.2");
    expect(result.rolledBack).toBeUndefined();
  }
  expect(deps.stopGateway).toHaveBeenCalledTimes(1);
  expect(deps.startGateway).toHaveBeenCalledTimes(1);
  expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ step: "gateway-stop" }));
  expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ step: "gateway-start" }));
  // 成功后 lastCheck 更新：current=to、updateAvailable=false、rollbackAvailable=true
  const state = getKernelUpdateState();
  expect(state.current).toBe("2026.7.2");
  expect(state.updateAvailable).toBe(false);
  expect(state.rollbackAvailable).toBe(true);
});

test("runKernelUpdate：成功路径触发 migrateOpenclawConfigForKernelUpgrade", async () => {
  mockState.spawnImpl = () => makeChild(makeProgressEvents());
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  await runKernelUpdate();
  const migration = await import("./openclaw-config-migration");
  expect(migration.migrateOpenclawConfigForKernelUpgrade).toHaveBeenCalledTimes(1);
});

test("runKernelUpdate：tag 参数透传给 updater", async () => {
  let observedArgs: string[] = [];
  mockState.spawnImpl = (allArgs) => {
    // spawn 调用形如 [script, ...userArgs]，剥掉首元素（脚本路径）
    observedArgs = allArgs.slice(1);
    return makeChild(makeProgressEvents());
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  await runKernelUpdate("2026.7.5");
  expect(observedArgs).toEqual(["--tag", "2026.7.5"]);
});

test("runKernelUpdate：tag 缺省时不传 --tag", async () => {
  let observedArgs: string[] = [];
  mockState.spawnImpl = (allArgs) => {
    observedArgs = allArgs.slice(1);
    return makeChild(makeProgressEvents());
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  await runKernelUpdate();
  expect(observedArgs).toEqual([]);
});

test("runKernelUpdate：update 后 gateway 健康失败 → 自动 rollback 后恢复", async () => {
  let callCount = 0;
  mockState.spawnImpl = (args) => {
    callCount++;
    if (args.includes("--rollback")) {
      return makeChild(makeRollbackEvents());
    }
    return makeChild(makeProgressEvents());
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps({
    startGateway: vi.fn()
      // 第一次：update 后健康检查失败
      .mockResolvedValueOnce(false)
      // 第二次：rollback 后恢复成功
      .mockResolvedValueOnce(true),
  });
  initKernelUpdater(deps);
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("启动失败");
    expect(result.error).toContain("自动回滚");
  }
  // update → stopGateway（1次）→ swap done → startGateway 失败
  // → stopGateway（rollback 前，2次） → rollback → startGateway 成功（2次）
  expect(deps.stopGateway).toHaveBeenCalledTimes(2);
  expect(deps.startGateway).toHaveBeenCalledTimes(2);
  expect(callCount).toBe(2); // update + rollback
  expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ step: "auto-rollback" }));
});

test("runKernelUpdate：update 后健康失败 → 自动 rollback 后仍失败 → 错误提示手动检查", async () => {
  mockState.spawnImpl = (args) => {
    if (args.includes("--rollback")) {
      return makeChild(makeRollbackEvents());
    }
    return makeChild(makeProgressEvents());
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps({
    startGateway: vi.fn().mockResolvedValue(false),
  });
  initKernelUpdater(deps);
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("自动回滚后仍无法启动");
    expect(result.error).toContain("手动检查");
  }
});

test("runKernelUpdate：swap 后脚本抛错 → catch 触发 best-effort rollback", async () => {
  let callCount = 0;
  mockState.spawnImpl = (args) => {
    callCount++;
    if (args.includes("--rollback")) {
      return makeChild(makeRollbackEvents());
    }
    // update 路径：发出 swap progress 后退出非 0
    return makeChild(
      [
        { type: "progress", step: "swap", pct: 50, msg: "换装" },
        { type: "error", message: "asar 校验失败" },
      ],
      1,
    );
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("asar 校验失败");
  }
  // sawSwap=true → 触发 best-effort rollback（第二次 spawn 调用）
  expect(callCount).toBe(2);
  // wasRunning=true → catch 中尝试 startGateway 恢复
  expect(deps.startGateway).toHaveBeenCalledTimes(1);
});

test("runKernelUpdate：swap 之前抛错 → 不触发 rollback", async () => {
  let callCount = 0;
  mockState.spawnImpl = (args) => {
    callCount++;
    if (args.includes("--rollback")) {
      return makeChild(makeRollbackEvents());
    }
    // update 路径：未到 swap 就失败（progress step 是 staging 不是 swap）
    return makeChild(
      [{ type: "progress", step: "staging", pct: 5, msg: "下载" }],
      1,
    );
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  // sawSwap=false → 不触发 rollback
  expect(callCount).toBe(1);
  // wasRunning=true → catch 中尝试 startGateway 恢复
  expect(deps.startGateway).toHaveBeenCalledTimes(1);
});

test("runKernelUpdate：wasRunning=false 时 catch 中不恢复 gateway", async () => {
  mockState.spawnImpl = () => makeChild(
    [{ type: "progress", step: "staging", pct: 5, msg: "下载" }],
    1,
  );
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps({
    getGatewayState: vi.fn().mockReturnValue("stopped"),
  });
  initKernelUpdater(deps);
  await runKernelUpdate();
  expect(deps.startGateway).not.toHaveBeenCalled();
});

test("runKernelUpdate：done 事件缺失时抛 'updater 未返回完成事件'", async () => {
  mockState.spawnImpl = () => makeChild([
    { type: "progress", step: "swap", pct: 50, msg: "换装" },
    // 没有 done 事件
  ]);
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("updater 未返回完成事件");
  }
});

test("runKernelUpdate：并发任务返回 '已有任务进行中'", async () => {
  // 用阻塞式 child 让第一个任务挂起
  const blocker = makeBlockingChild();
  mockState.spawnImpl = () => blocker as any;
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  // 启动第一个任务（不 await）
  const firstPromise = runKernelUpdate();
  // 让事件循环跑一下让 spawn 被调用、running=true
  await new Promise((r) => setImmediate(r));
  // 第二次调用：应立即返回 '已有任务进行中'
  const secondResult = await runKernelUpdate();
  expect(secondResult.ok).toBe(false);
  if (!secondResult.ok) {
    expect(secondResult.error).toContain("已有内核升级任务进行中");
  }
  // 释放第一个任务让其完成
  blocker.release(makeProgressEvents());
  const firstResult = await firstPromise;
  expect(firstResult.ok).toBe(true);
});

test("runKernelRollback：成功路径", async () => {
  mockState.spawnImpl = (args) => {
    if (args.includes("--rollback")) {
      return makeChild(makeRollbackEvents());
    }
    return makeChild([]);
  };
  const { initKernelUpdater, runKernelRollback } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  const result = await runKernelRollback();
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.action).toBe("rollback");
    expect(result.from).toBe("2026.7.2");
    expect(result.to).toBe("2026.7.1-2");
  }
  expect(deps.stopGateway).toHaveBeenCalledTimes(1);
  expect(deps.startGateway).toHaveBeenCalledTimes(1);
});

test("runKernelRollback：回退后 gateway 启动失败时返回错误（不自动 rollback）", async () => {
  let rollbackCallCount = 0;
  mockState.spawnImpl = (args) => {
    if (args.includes("--rollback")) {
      rollbackCallCount++;
      return makeChild(makeRollbackEvents());
    }
    return makeChild([]);
  };
  const { initKernelUpdater, runKernelRollback } = await import("./kernel-updater");
  const deps = makeDeps({
    startGateway: vi.fn().mockResolvedValue(false),
  });
  initKernelUpdater(deps);
  const result = await runKernelRollback();
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("启动失败");
    expect(result.error).toContain("查看日志");
  }
  // rollback 场景：失败时不自动再次 rollback
  expect(rollbackCallCount).toBe(1);
});

test("runKernelRollback：失败后 best-effort rollback 不向上抛错", async () => {
  let rollbackCallCount = 0;
  mockState.spawnImpl = (args) => {
    if (args.includes("--rollback")) {
      rollbackCallCount++;
      // 第一次 rollback 就失败：swap 后 error
      return makeChild(
        [
          { type: "progress", step: "swap", pct: 50, msg: "回滚换装" },
          { type: "error", message: "rollback asar 校验失败" },
        ],
        1,
      );
    }
    return makeChild([]);
  };
  const { initKernelUpdater, runKernelRollback } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  const result = await runKernelRollback();
  expect(result.ok).toBe(false);
  // sawSwap=true → catch 中触发 best-effort rollback：会再调一次 --rollback
  // 但 best-effort rollback 失败也会被吞掉，最终返回原始 error
  expect(rollbackCallCount).toBe(2);
  if (!result.ok) {
    expect(result.error).toContain("rollback asar 校验失败");
  }
});

// ── 进度事件转发 ──

test("runKernelUpdate：progress 事件全部转发到 push", async () => {
  const events = makeProgressEvents();
  mockState.spawnImpl = () => makeChild(events);
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  await runKernelUpdate();
  const progressPushes = (deps.push as any).mock.calls
    .map((c: any[]) => c[0])
    .filter((p: any) => !["gateway-stop", "gateway-start", "auto-rollback", "done", "error"].includes(p.step));
  // 3 个 progress 事件（staging / swap / smoke），手动触发带 source: "manual"
  expect(progressPushes).toHaveLength(3);
  expect(progressPushes[0]).toEqual({ step: "staging", pct: 10, msg: "下载", source: "manual" });
  expect(progressPushes[1]).toEqual({ step: "swap", pct: 50, msg: "换装", source: "manual" });
  expect(progressPushes[2]).toEqual({ step: "smoke", pct: 90, msg: "冒烟", source: "manual" });
  // 成功补推 done 终态（自动升级的全局横幅靠它收敛）
  expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ step: "done", pct: 100, source: "manual" }));
});

// ── 最低支持版本判定（kernel-channel.json minSupported = 2026.7）──

test("isKernelBelowMinSupported：低于 2026.7 返回 true", async () => {
  mockState.kernelVersionParts = { year: 2026, month: 6 };
  const { isKernelBelowMinSupported } = await import("./kernel-updater");
  expect(isKernelBelowMinSupported()).toBe(true);
});

test("isKernelBelowMinSupported：等于/高于 2026.7 返回 false", async () => {
  const { isKernelBelowMinSupported } = await import("./kernel-updater");
  mockState.kernelVersionParts = { year: 2026, month: 7 };
  expect(isKernelBelowMinSupported()).toBe(false);
  mockState.kernelVersionParts = { year: 2026, month: 8 };
  expect(isKernelBelowMinSupported()).toBe(false);
  mockState.kernelVersionParts = { year: 2027, month: 1 };
  expect(isKernelBelowMinSupported()).toBe(false);
});

test("isKernelBelowMinSupported：版本读不到（null）保守返回 false", async () => {
  mockState.kernelVersionParts = null;
  const { isKernelBelowMinSupported } = await import("./kernel-updater");
  expect(isKernelBelowMinSupported()).toBe(false);
});

// ── 自动升级（source="auto"）透传 ──

test("runKernelUpdate(source=auto)：所有 push 带 source=auto，成功推 done 终态", async () => {
  const events = makeProgressEvents();
  mockState.spawnImpl = () => makeChild(events);
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  const result = await runKernelUpdate(undefined, "auto");
  expect(result.ok).toBe(true);
  const pushes = (deps.push as any).mock.calls.map((c: any[]) => c[0]);
  expect(pushes.length).toBeGreaterThan(0);
  for (const p of pushes) {
    expect(p.source).toBe("auto");
  }
  expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ step: "done", pct: 100, source: "auto" }));
});

test("runKernelUpdate(source=auto)：失败推 error 终态且带 source=auto", async () => {
  // 未到 swap 就失败：无回滚，直接 error 结论
  mockState.spawnImpl = () => makeChild([{ type: "progress", step: "staging", pct: 5, msg: "下载" }], 1);
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  const result = await runKernelUpdate(undefined, "auto");
  expect(result.ok).toBe(false);
  expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ step: "error", pct: 100, source: "auto" }));
});

// ── 回滚路径的配置迁移（K1）──

test("runKernelUpdate：自动回滚后、恢复启动前会再次执行配置迁移", async () => {
  mockState.spawnImpl = (args) =>
    args.includes("--rollback") ? makeChild(makeRollbackEvents()) : makeChild(makeProgressEvents());
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps({
    startGateway: vi.fn()
      .mockResolvedValueOnce(false) // update 后健康检查失败
      .mockResolvedValueOnce(true), // rollback 后恢复成功
  });
  initKernelUpdater(deps);
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  const migration = await import("./openclaw-config-migration");
  const migrateMock = migration.migrateOpenclawConfigForKernelUpgrade as any;
  // update 换装成功后 1 次 + 自动回滚后恢复启动前 1 次
  expect(migrateMock).toHaveBeenCalledTimes(2);
  // 第二次迁移必须发生在回滚后恢复启动（第 2 次 startGateway）之前
  const startOrder = (deps.startGateway as any).mock.invocationCallOrder;
  expect(migrateMock.mock.invocationCallOrder[1]).toBeLessThan(startOrder[1]);
});

test("runKernelUpdate：catch 兜底 best-effort 回滚成功后、恢复启动前执行配置迁移", async () => {
  mockState.spawnImpl = (args) => {
    if (args.includes("--rollback")) return makeChild(makeRollbackEvents());
    // update 路径：swap 之后失败
    return makeChild(
      [
        { type: "progress", step: "swap", pct: 50, msg: "换装" },
        { type: "error", message: "asar 校验失败" },
      ],
      1,
    );
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  const deps = makeDeps();
  initKernelUpdater(deps);
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  const migration = await import("./openclaw-config-migration");
  const migrateMock = migration.migrateOpenclawConfigForKernelUpgrade as any;
  // update 未走到换装成功 → 仅回滚后迁移 1 次，且在恢复启动之前
  expect(migrateMock).toHaveBeenCalledTimes(1);
  expect(migrateMock.mock.invocationCallOrder[0]).toBeLessThan(
    (deps.startGateway as any).mock.invocationCallOrder[0],
  );
});

test("runKernelUpdate：catch 兜底回滚失败时不执行配置迁移", async () => {
  mockState.spawnImpl = (args) => {
    if (args.includes("--rollback")) {
      // 回滚本身也失败
      return makeChild([{ type: "error", message: "rollback 失败" }], 1);
    }
    return makeChild(
      [
        { type: "progress", step: "swap", pct: 50, msg: "换装" },
        { type: "error", message: "asar 校验失败" },
      ],
      1,
    );
  };
  const { initKernelUpdater, runKernelUpdate } = await import("./kernel-updater");
  initKernelUpdater(makeDeps());
  const result = await runKernelUpdate();
  expect(result.ok).toBe(false);
  const migration = await import("./openclaw-config-migration");
  expect(migration.migrateOpenclawConfigForKernelUpgrade).not.toHaveBeenCalled();
});
