import test from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createGatewayControlRequestHandler,
  ensureGatewayControlToken,
  listenWithPortRetry,
  GatewayControlDeps,
} from "./gateway-control-server";

const TEST_TOKEN = "test-token-0123456789abcdef";

interface TestResponse {
  statusCode: number;
  body: any;
}

function request(
  port: number,
  opts: { method?: string; path?: string; token?: string } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: opts.path ?? "/gateway/status",
        method: opts.method ?? "GET",
        headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let body: any = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {}
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// 起测试服务器：随机空闲端口，返回端口与关闭函数
async function startTestServer(
  deps: GatewayControlDeps,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(createGatewayControlRequestHandler(deps, TEST_TOKEN));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeDeps(overrides: Partial<GatewayControlDeps> = {}): GatewayControlDeps {
  return {
    getStatus: () => ({ running: true, pid: 1234, port: 18789, uptimeMs: 5000 }),
    restart: async () => {},
    ...overrides,
  };
}

test("未携带或错误 token 的请求返回 401", async () => {
  const { port, close } = await startTestServer(makeDeps());
  try {
    const noAuth = await request(port);
    assert.equal(noAuth.statusCode, 401);
    assert.equal(noAuth.body.ok, false);

    const wrongAuth = await request(port, { token: "wrong-token" });
    assert.equal(wrongAuth.statusCode, 401);
  } finally {
    await close();
  }
});

test("GET /gateway/status 返回托管状态结构", async () => {
  const { port, close } = await startTestServer(makeDeps());
  try {
    const res = await request(port, { token: TEST_TOKEN });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      ok: true,
      running: true,
      pid: 1234,
      port: 18789,
      uptimeMs: 5000,
    });
  } finally {
    await close();
  }
});

test("POST /gateway/restart 调用托管停启并返回结果", async () => {
  let restartCalls = 0;
  const okDeps = makeDeps({
    restart: async () => {
      restartCalls += 1;
    },
  });
  const { port, close } = await startTestServer(okDeps);
  try {
    const res = await request(port, { method: "POST", path: "/gateway/restart", token: TEST_TOKEN });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(restartCalls, 1);
  } finally {
    await close();
  }

  const failDeps = makeDeps({
    restart: async () => {
      throw new Error("Gateway 重启后未通过健康检查");
    },
  });
  const fail = await startTestServer(failDeps);
  try {
    const res = await request(fail.port, { method: "POST", path: "/gateway/restart", token: TEST_TOKEN });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /健康检查/);
  } finally {
    await fail.close();
  }
});

test("并发 restart 共享同一个在途停启，不重复调用", async () => {
  let restartCalls = 0;
  const deps = makeDeps({
    restart: async () => {
      restartCalls += 1;
      await new Promise((r) => setTimeout(r, 100));
    },
  });
  const { port, close } = await startTestServer(deps);
  try {
    const [a, b] = await Promise.all([
      request(port, { method: "POST", path: "/gateway/restart", token: TEST_TOKEN }),
      request(port, { method: "POST", path: "/gateway/restart", token: TEST_TOKEN }),
    ]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(restartCalls, 1, "并发 restart 应串行化为一次托管停启");
  } finally {
    await close();
  }
});

test("未知路径返回 404，GET restart 返回 404", async () => {
  const { port, close } = await startTestServer(makeDeps());
  try {
    const unknown = await request(port, { path: "/nope", token: TEST_TOKEN });
    assert.equal(unknown.statusCode, 404);

    const wrongMethod = await request(port, { path: "/gateway/restart", token: TEST_TOKEN });
    assert.equal(wrongMethod.statusCode, 404);
  } finally {
    await close();
  }
});

test("端口被占用时递增重试到下一个端口", async () => {
  // 先占住一个随机端口作为 basePort
  const blocker = http.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const basePort = (blocker.address() as { port: number }).port;

  const server = http.createServer(createGatewayControlRequestHandler(makeDeps(), TEST_TOKEN));
  try {
    const port = await listenWithPortRetry(server, basePort, 10);
    assert.equal(port, basePort + 1, "应跳过被占用端口绑定到下一个");
    const res = await request(port, { token: TEST_TOKEN });
    assert.equal(res.statusCode, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("全部候选端口被占用时 listen 失败", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const basePort = (blocker.address() as { port: number }).port;

  const server = http.createServer();
  try {
    await assert.rejects(listenWithPortRetry(server, basePort, 1), (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, "EADDRINUSE");
      return true;
    });
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("ensureGatewayControlToken 首次生成 32 位 hex 并持久化，再次调用复用", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-gwctl-"));
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  try {
    const token1 = ensureGatewayControlToken();
    assert.match(token1, /^[0-9a-f]{32}$/);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "cryoclaw.config.json"), "utf-8"),
    );
    assert.equal(onDisk.gatewayControl.token, token1);

    const token2 = ensureGatewayControlToken();
    assert.equal(token2, token1, "已持久化的 token 不应重新生成");
  } finally {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
