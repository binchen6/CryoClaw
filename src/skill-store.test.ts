// skill-store jsonGet 的 Promise 落定守卫 + 错误形态回归。
// P0-13：非 2xx 错误体超 64KB 时旧实现 res.destroy() 后未 reject，Promise 永久
// 悬挂（skill-store:list 等 IPC 死转）。本文件用本地 http server 复现该形态。
// electron 依赖 mock（对齐 skill-store-registry.test.ts），OPENCLAW_STATE_DIR 指临时目录。
import { test, expect, vi, beforeAll, afterAll } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { useTempStateDir } from "./test-support/vitest-state-dir";

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "0.0.0",
    getAppPath: () => "/app",
  },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("./build-config", () => ({
  readBuildConfigClawhubRegistry: () => null,
}));

useTempStateDir("skill-store-test-");

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/big-error") {
      // 非 2xx + 超 64KB 错误体：旧实现累计超限后 res.destroy() 无 reject，Promise 悬挂
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(Buffer.alloc(128 * 1024, "x"));
      return;
    }
    if (req.url === "/small-error") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "AMBIGUOUS_SKILL_SLUG", matches: [{ ownerHandle: "a" }] }));
      return;
    }
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [1, 2, 3] }));
      return;
    }
    if (req.url === "/bad-json") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not-a-json{");
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  // big-error 用例客户端中途 destroy 连接，先清空连接再 close，避免 afterAll 悬挂
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("jsonGet: 非 2xx 错误体超 64KB 时在有限时间内 reject（不悬挂，P0-13）", async () => {
  const { jsonGet } = await import("./skill-store");
  // race 5s 兜底：若 Promise 悬挂（旧实现），race 以 timeout 胜出 → 断言失败；
  // vitest 用例超时 15s，给 race 留足余量
  const outcome = await Promise.race([
    jsonGet<unknown>(`http://127.0.0.1:${port}/big-error`).then(
      () => ({ kind: "resolved" as const }),
      (err) => ({ kind: "rejected" as const, err: err as Error & { statusCode?: number } }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 5000)),
  ]);
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind === "rejected") {
    expect(outcome.err.message).toBe("HTTP 500");
    expect(outcome.err.statusCode).toBe(500);
  }
}, 15000);

test("jsonGet: 非 2xx 保留 statusCode + bodyText（409 消歧信息透传）", async () => {
  const { jsonGet } = await import("./skill-store");
  const err = await jsonGet<unknown>(`http://127.0.0.1:${port}/small-error`).then(
    () => null,
    (e) => e as Error & { statusCode?: number; bodyText?: string },
  );
  expect(err).not.toBeNull();
  expect(err?.statusCode).toBe(409);
  expect(err?.bodyText).toContain("AMBIGUOUS_SKILL_SLUG");
});

test("jsonGet: 2xx 正常解析 JSON", async () => {
  const { jsonGet } = await import("./skill-store");
  await expect(jsonGet<{ items: number[] }>(`http://127.0.0.1:${port}/ok`)).resolves.toEqual({
    items: [1, 2, 3],
  });
});

test("jsonGet: 2xx 非法 JSON 走 parse error reject", async () => {
  const { jsonGet } = await import("./skill-store");
  await expect(jsonGet<unknown>(`http://127.0.0.1:${port}/bad-json`)).rejects.toThrow();
});
