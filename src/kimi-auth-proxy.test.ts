import test from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import {
  startAuthProxy,
  stopAuthProxy,
  setProxyAccessToken,
  getProxyPort,
} from "./kimi-auth-proxy";

// 不用全局 keepAlive agent：同端口快速重bind 时会复用已被 closeAllConnections
// 掐掉的池化 socket，非幂等请求不复试直接 ECONNRESET
const noKeepAlive = new http.Agent({ keepAlive: false });

function request(port: number, path: string, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, agent: noKeepAlive },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("auth proxy 路由：/coding/* 放行，未知路径 404", async (t) => {
  const port = await startAuthProxy(0);
  t.after(() => stopAuthProxy());
  setProxyAccessToken("test-token");

  // 无回环鉴权：任意路径直接进路由层（R49 移除 path secret）
  assert.equal(await request(port, "/nope"), 404, "未知路径 → 404");
  assert.equal(await request(port, "/other/v1/messages"), 404, "非 /coding/ 前缀 → 404");
});

test("auth proxy 无 token 时对 /coding 请求返回 401", async (t) => {
  const port = await startAuthProxy(0);
  t.after(() => stopAuthProxy());
  setProxyAccessToken("");

  const status = await request(port, "/coding/v1/messages", "POST");
  assert.equal(status, 401, "无 access token → 401（代理自身 token 缺失，非回环鉴权）");
});

test("代理重启后端口重新分配且可再次启动", async (t) => {
  const port = await startAuthProxy(0);
  assert.ok(port > 0);
  assert.equal(getProxyPort(), port);
  await stopAuthProxy();
  assert.equal(getProxyPort(), -1);
  const port2 = await startAuthProxy(0);
  t.after(() => stopAuthProxy());
  assert.ok(port2 > 0);
});
