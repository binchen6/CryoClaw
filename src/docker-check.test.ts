// docker-check 单元测试
//
// 关键不变量：
//   1. spawn 抛错 / error 事件（ENOENT：docker 不在 PATH）→ false
//   2. close code === 0 → true（docker version --format Server.Version 成功 = 客户端+守护进程都可用）
//   3. close code !== 0 → false（客户端在但 daemon 未运行）
//   4. 60s 内重复调用命中缓存（不再 spawn）；force 强制复检
import { test, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

const mockState: {
  spawnImpl: () => any;
  spawnCount: number;
} = {
  spawnImpl: () => {
    throw new Error("not configured");
  },
  spawnCount: 0,
};

vi.mock("child_process", () => ({
  spawn: (...args: any[]) => {
    mockState.spawnCount++;
    return mockState.spawnImpl();
  },
}));

function makeChild(behavior: "ok" | "fail" | "error"): any {
  const emitter = new EventEmitter();
  process.nextTick(() => {
    if (behavior === "ok") emitter.emit("close", 0);
    else if (behavior === "fail") emitter.emit("close", 1);
    else emitter.emit("error", new Error("spawn docker ENOENT"));
  });
  return emitter;
}

beforeEach(async () => {
  mockState.spawnCount = 0;
  mockState.spawnImpl = () => {
    throw new Error("not configured");
  };
  const { resetDockerCheckCache } = await import("./docker-check");
  resetDockerCheckCache();
});

test("spawn 触发 error 事件（ENOENT）时返回 false", async () => {
  mockState.spawnImpl = () => makeChild("error");
  const { checkDockerAvailable } = await import("./docker-check");
  expect(await checkDockerAvailable()).toBe(false);
  expect(mockState.spawnCount).toBe(1);
});

test("spawn 同步抛错时返回 false", async () => {
  mockState.spawnImpl = () => {
    throw new Error("spawn docker ENOENT");
  };
  const { checkDockerAvailable } = await import("./docker-check");
  expect(await checkDockerAvailable()).toBe(false);
});

test("close code 0 时返回 true", async () => {
  mockState.spawnImpl = () => makeChild("ok");
  const { checkDockerAvailable } = await import("./docker-check");
  expect(await checkDockerAvailable()).toBe(true);
});

test("close code 非 0（daemon 未运行）时返回 false", async () => {
  mockState.spawnImpl = () => makeChild("fail");
  const { checkDockerAvailable } = await import("./docker-check");
  expect(await checkDockerAvailable()).toBe(false);
});

test("60s 缓存内重复调用不再 spawn；force 强制复检", async () => {
  mockState.spawnImpl = () => makeChild("ok");
  const { checkDockerAvailable } = await import("./docker-check");
  expect(await checkDockerAvailable()).toBe(true);
  expect(await checkDockerAvailable()).toBe(true);
  expect(mockState.spawnCount).toBe(1); // 第二次命中缓存

  mockState.spawnImpl = () => makeChild("fail");
  expect(await checkDockerAvailable({ force: true })).toBe(false); // 强制复检
  expect(mockState.spawnCount).toBe(2);
  expect(await checkDockerAvailable()).toBe(false); // 新结果已缓存
  expect(mockState.spawnCount).toBe(2);
});
