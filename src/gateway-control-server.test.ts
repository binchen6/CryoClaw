import test from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {EventEmitter} from "node:events";
import {
  createGatewayControlRequestHandler,
  ensureGatewayControlToken,
  issueWebuiHandoffCode,
  listenWithPortRetry,
  WEBUI_HANDOFF_PATH,
  GatewayControlDeps,
} from "./gateway-control-server";

const TEST_TOKEN = "test-token-0123456789abcdef";

interface TestResponse {
  statusCode: number;
  body: any;
  /** 302 跳转的 Location 头（非跳转响应为 null） */
  location: string | null;
}

function request(
  port: number,
  opts: { method?: string; path?: string; token?: string;body?:unknown;timeoutMs?:number } = {},
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
          resolve({
            statusCode: res.statusCode ?? 0,
            body,
            location: res.headers.location ?? null,
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(opts.timeoutMs??3000,()=>req.destroy(new Error("Test HTTP request timed out")));
    req.end(opts.body===undefined?undefined:JSON.stringify(opts.body));
  });
}

test("theme API requires authentication and bounds both action and request size",async()=>{
  let calls=0;
  const server=await startTestServer({getStatus:()=>({running:true,pid:1,port:18789,uptimeMs:1}),restart:async()=>{},themeUi:async payload=>{calls++;return {preview:(payload as any).action==="preview"};}});
  try {
    assert.equal((await request(server.port,{method:"POST",path:"/ui/theme",body:{action:"inspect"}})).statusCode,401);
    assert.equal(calls,0);
    assert.equal((await request(server.port,{method:"POST",path:"/ui/theme",token:TEST_TOKEN,body:{action:"execute",script:"bad"}})).statusCode,400);
    assert.equal((await request(server.port,{method:"POST",path:"/ui/theme",token:TEST_TOKEN,body:{action:"preview",theme:"x".repeat(65536)}})).statusCode,413);
    const result=await request(server.port,{method:"POST",path:"/ui/theme",token:TEST_TOKEN,body:{action:"preview",theme:{}}});
    assert.equal(result.statusCode,200);assert.deepEqual(result.body,{ok:true,result:{preview:true}});assert.equal(calls,1);
  } finally {await server.close();}
});

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
    close: () => new Promise<void>((resolve) => {server.closeAllConnections();server.close(() => resolve());}),
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

// ── webui 一次性 handoff（F5）──

const HANDOFF_DEPS = { getWebuiHandoffTarget: () => ({ token: "gw-token-abc", port: 18789 }) };

test("webui handoff：合法 code 免 Bearer 直接 302 到带 token 的落地 URL，code 用后作废", async () => {
  const { port, close } = await startTestServer(makeDeps(HANDOFF_DEPS));
  try {
    const code = issueWebuiHandoffCode();
    // 模拟浏览器地址栏导航：不携带 Authorization 头
    const first = await request(port, { path: `${WEBUI_HANDOFF_PATH}${code}` });
    assert.equal(first.statusCode, 302);
    assert.equal(
      first.location,
      `http://127.0.0.1:18789/#token=${encodeURIComponent("gw-token-abc")}`,
    );

    // 重放同一个 code：已作废
    const replay = await request(port, { path: `${WEBUI_HANDOFF_PATH}${code}` });
    assert.equal(replay.statusCode, 410);
    assert.equal(replay.body.ok, false);
  } finally {
    await close();
  }
});

test("webui handoff：过期 code 返回 410，未知/格式非法 code 返回 404", async () => {
  const { port, close } = await startTestServer(makeDeps(HANDOFF_DEPS));
  try {
    // ttlMs 为负：签发即过期（等价于用户放置超过 60s 后才打开）
    const expired = issueWebuiHandoffCode(-1);
    const expiredRes = await request(port, { path: `${WEBUI_HANDOFF_PATH}${expired}` });
    assert.equal(expiredRes.statusCode, 410);
    assert.equal(expiredRes.body.error, "handoff expired");

    const malformed = await request(port, { path: `${WEBUI_HANDOFF_PATH}not-a-code` });
    assert.equal(malformed.statusCode, 404);

    const unknown = await request(port, { path: `${WEBUI_HANDOFF_PATH}${"0".repeat(32)}` });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await close();
  }
});

test("webui handoff：落地目标不可用时 503，且该 code 不可重放", async () => {
  const { port, close } = await startTestServer(makeDeps({ getWebuiHandoffTarget: () => null }));
  try {
    const code = issueWebuiHandoffCode();
    const res = await request(port, { path: `${WEBUI_HANDOFF_PATH}${code}` });
    assert.equal(res.statusCode, 503);

    const replay = await request(port, { path: `${WEBUI_HANDOFF_PATH}${code}` });
    assert.equal(replay.statusCode, 410, "拿不到落地目标也必须作废 code");
  } finally {
    await close();
  }
});

test("webui handoff：非 GET 方法 404 且不消费 code", async () => {
  const { port, close } = await startTestServer(makeDeps(HANDOFF_DEPS));
  try {
    const code = issueWebuiHandoffCode();
    const post = await request(port, { method: "POST", path: `${WEBUI_HANDOFF_PATH}${code}` });
    assert.equal(post.statusCode, 404);

    // code 未被 POST 分支消费，GET 仍可正常兑换
    const get = await request(port, { path: `${WEBUI_HANDOFF_PATH}${code}` });
    assert.equal(get.statusCode, 302);
  } finally {
    await close();
  }
});

// 占住一个随机端口作为测试用 basePort（两个端口重试用例共用）。
async function occupyRandomPort(): Promise<{ blocker: http.Server; port: number }> {
  const blocker = http.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  return { blocker, port: (blocker.address() as { port: number }).port };
}

test("端口被占用时递增重试到下一个端口", async () => {
  // OS-assigned ports do not guarantee that the adjacent port is available on Windows.
  const server=new EventEmitter() as EventEmitter & {listen:(port:number)=>void;address:()=>{port:number}};
  const calls:number[]=[];let port=0;
  server.listen=next=>{calls.push(next);port=next;queueMicrotask(()=>calls.length<3?server.emit("error",Object.assign(new Error("occupied"),{code:"EADDRINUSE"})):server.emit("listening"));};
  server.address=()=>({port});
  assert.equal(await listenWithPortRetry(server as unknown as http.Server,22000,10),22002);
  assert.deepEqual(calls,[22000,22001,22002]);
  assert.equal(server.listenerCount("error"),0);assert.equal(server.listenerCount("listening"),0);
});

test("权限失败不会被端口重试掩盖，监听器始终清理",async()=>{
  const server=new EventEmitter() as EventEmitter & {listen:()=>void};let calls=0;
  server.listen=()=>{calls++;queueMicrotask(()=>server.emit("error",Object.assign(new Error("denied"),{code:"EACCES"})));};
  await assert.rejects(listenWithPortRetry(server as unknown as http.Server,22000,10),{code:"EACCES"});
  assert.equal(calls,1);assert.equal(server.listenerCount("error"),0);assert.equal(server.listenerCount("listening"),0);
});

test("无响应的测试 HTTP 请求有明确截止时间",async()=>{
  const server=http.createServer(()=>{});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{await assert.rejects(request((server.address() as {port:number}).port,{timeoutMs:50}),/timed out/);}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("全部候选端口被占用时 listen 失败", async () => {
  const { blocker, port: basePort } = await occupyRandomPort();

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
