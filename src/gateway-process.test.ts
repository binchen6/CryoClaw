// gateway-process 启动路径测试：预启动步骤并行化、干净退出后跳过崩溃冷却、
// 崩溃后冷却仍生效、进度事件顺序与 attempt 透传。
// electron/constants/child_process/http 等按仓库惯例 mock；spawn/HTTP 全部可控 fake，
// CRASH_COOLDOWN_MS / HEALTH_TIMEOUT_MS 缩小到毫秒级以保证测试时长可控。
import { EventEmitter } from "events";
import { describe, expect, test, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({
  stateDir: "",
  nodeBin: "",
  entry: "",
  // spawn 出的 fake gateway 是否对 HTTP 健康探测响应 200
  healthServing: false,
  // spawn 成功后是否自动开始提供健康响应（健康超时场景关闭）
  spawnServesHealth: true,
  spawnTimes: [] as number[],
  latestChild: null as any,
}));

vi.mock("electron", () => ({ app: { isPackaged: false } }));

vi.mock("./constants", () => ({
  DEFAULT_PORT: 18789,
  HEALTH_TIMEOUT_MS: 1000,
  HEALTH_POLL_INTERVAL_MS: 50,
  CRASH_COOLDOWN_MS: 300,
  IS_WIN: true,
  resolveGatewayLogPath: () => path.join(h.stateDir, "logs", "gateway.log"),
  resolveNodeBin: () => h.nodeBin,
  resolveNodeExtraEnv: () => ({ ELECTRON_RUN_AS_NODE: "1" }),
  resolveNpmBin: () => "npm",
  resolveGatewayEntry: () => h.entry,
  resolveGatewayCwd: () => h.stateDir,
  resolveResourcesPath: () => h.stateDir,
  resolveClawhubEntry: () => path.join(h.stateDir, "no-such-clawhub.js"),
  resolveUserBinDir: () => path.join(h.stateDir, "bin"),
  resolveUserStateDir: () => h.stateDir,
}));

vi.mock("./logger", () => ({
  endStreamWithTimeout: (stream: { end: (cb: () => void) => void }) =>
    new Promise<void>((resolve) => stream.end(resolve)),
}));

vi.mock("./install-detector", () => ({
  uninstallGatewayDaemon: vi.fn(async () => {}),
  getPortPid: vi.fn(async () => 0),
}));

vi.mock("./agent-db-migration", () => ({
  ensureAgentDbSchemaReady: vi.fn(async () => {}),
}));

vi.mock("http", () => ({
  get: vi.fn((_url: string, cb: (res: any) => void) => {
    const req: any = new EventEmitter();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    queueMicrotask(() => {
      if (h.healthServing) {
        cb({ statusCode: 200, resume: () => {} });
      } else {
        req.emit("error", new Error("connect ECONNREFUSED"));
      }
    });
    return req;
  }),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    h.spawnTimes.push(Date.now());
    const child: any = new EventEmitter();
    child.pid = 40000 + h.spawnTimes.length;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    h.latestChild = child;
    if (h.spawnServesHealth) h.healthServing = true;
    return child;
  }),
  execFile: vi.fn((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as
      | ((err: unknown, stdout: string, stderr: string) => void)
      | undefined;
    // IS_WIN 停止路径走 taskkill：视为成功并派发同代 exit（干净停止）
    if (cmd === "taskkill" && h.latestChild) {
      const child = h.latestChild;
      h.healthServing = false;
      child.exitCode = 0;
      setImmediate(() => child.emit("exit", 0, null));
    }
    callback?.(null, "", "");
  }),
}));

async function freshModule() {
  return import("./gateway-process");
}

beforeAll(() => {
  h.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-process-test-"));
  h.nodeBin = path.join(h.stateDir, "node");
  h.entry = path.join(h.stateDir, "openclaw.mjs");
  fs.writeFileSync(h.nodeBin, "");
  fs.writeFileSync(h.entry, "");
});

beforeEach(async () => {
  vi.resetModules();
  h.healthServing = false;
  h.spawnServesHealth = true;
  h.spawnTimes = [];
  h.latestChild = null;
  // mock 实现跨测试残留（工厂不会随 resetModules 重建），逐个恢复默认行为
  const { ensureAgentDbSchemaReady } = await import("./agent-db-migration");
  const { uninstallGatewayDaemon } = await import("./install-detector");
  vi.mocked(ensureAgentDbSchemaReady).mockReset().mockImplementation(async () => null);
  vi.mocked(uninstallGatewayDaemon).mockReset().mockImplementation(async () => {});
});

afterEach(async () => {
  const { closeDiagLogStream } = await freshModule();
  await closeDiagLogStream();
});

afterAll(() => {
  fs.rmSync(h.stateDir, { recursive: true, force: true });
});

describe("预启动步骤并行化", () => {
  test("ensureAgentDbSchemaReady 与 uninstallGatewayDaemon 并发执行（无相互等待）", async () => {
    const { ensureAgentDbSchemaReady } = await import("./agent-db-migration");
    const { uninstallGatewayDaemon } = await import("./install-detector");
    let dbStarted = false;
    let daemonStarted = false;
    let resolveDb!: () => void;
    vi.mocked(ensureAgentDbSchemaReady).mockImplementation(() => {
      dbStarted = true;
      return new Promise<null>((r) => {
        resolveDb = () => r(null);
      });
    });
    vi.mocked(uninstallGatewayDaemon).mockImplementation(async () => {
      daemonStarted = true;
    });

    const { GatewayProcess } = await freshModule();
    const gw = new GatewayProcess({ token: "t" });
    const startPromise = gw.start();

    // 串行实现会先等 DB 落定再跑 daemon；daemon 在 DB pending 时已启动即证明并行
    await vi.waitFor(() => {
      expect(dbStarted).toBe(true);
      expect(daemonStarted).toBe(true);
    });
    resolveDb();
    await startPromise;
    expect(gw.getState()).toBe("running");
    await gw.stop();
  });
});

describe("崩溃冷却", () => {
  test("干净停止后重启不等待 CRASH_COOLDOWN_MS", async () => {
    const { GatewayProcess } = await freshModule();
    const gw = new GatewayProcess({ token: "t" });
    await gw.start();
    expect(gw.getState()).toBe("running");
    await gw.stop();
    expect(gw.getState()).toBe("stopped");

    const t0 = Date.now();
    const restartPromise = gw.start();
    await vi.waitFor(() => expect(h.spawnTimes.length).toBe(2));
    // 干净退出不应触发冷却（冷却值 mock 为 300ms，留 50ms 余量）
    expect(h.spawnTimes[1] - t0).toBeLessThan(250);
    await restartPromise;
    expect(gw.getState()).toBe("running");
    await gw.stop();
  });

  test("异常退出（健康超时）后立即重启仍等待冷却", async () => {
    h.spawnServesHealth = false;
    const crashes: unknown[] = [];
    const { GatewayProcess } = await freshModule();
    const gw = new GatewayProcess({ token: "t", onCrash: (info) => crashes.push(info) });
    await gw.start();
    expect(gw.getState()).toBe("stopped");
    expect(crashes).toHaveLength(1);

    // 第二次启动让它健康，避免再拖一轮超时
    h.spawnServesHealth = true;
    const t0 = Date.now();
    const restartPromise = gw.start();
    await vi.waitFor(() => expect(h.spawnTimes.length).toBe(2));
    expect(h.spawnTimes[1] - t0).toBeGreaterThanOrEqual(200);
    await restartPromise;
    expect(gw.getState()).toBe("running");
    await gw.stop();
  });
});

describe("启动进度事件", () => {
  test("按 cleanup → database → port → spawn → health → ready 顺序发出，带 attempt", async () => {
    const events: Array<{ step: string; attempt: number; elapsedMs?: number }> = [];
    const { GatewayProcess } = await freshModule();
    const gw = new GatewayProcess({ token: "t", onProgress: (info) => events.push(info) });
    await gw.start({ attempt: 2 });
    expect(gw.getState()).toBe("running");

    const steps = events.map((e) => e.step);
    expect(steps[0]).toBe("cleanup");
    expect(steps[steps.length - 1]).toBe("ready");
    let prev = -1;
    for (const s of ["cleanup", "database", "port", "spawn", "health", "ready"]) {
      const idx = steps.indexOf(s);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
    expect(events.every((e) => e.attempt === 2)).toBe(true);
    const health = events.find((e) => e.step === "health");
    expect(health?.elapsedMs).toBe(0);
    expect(gw.getLastProgress()?.step).toBe("ready");
    await gw.stop();
    // 停止后进度快照清空：gateway:state 不得向晚加载的渲染层补过期进度
    expect(gw.getLastProgress()).toBeNull();
  });

  test("启动失败（健康超时）后进度快照清空", async () => {
    h.spawnServesHealth = false;
    const { GatewayProcess } = await freshModule();
    const gw = new GatewayProcess({ token: "t" });
    await gw.start();
    expect(gw.getState()).toBe("stopped");
    expect(gw.getLastProgress()).toBeNull();
  });
});
