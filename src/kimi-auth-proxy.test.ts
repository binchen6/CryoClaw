import test from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import {
  generateProxySecret,
  extractSecuredPath,
  startAuthProxy,
  stopAuthProxy,
  getProxySecret,
} from "./kimi-auth-proxy";

test("generateProxySecret 生成 URL 安全的随机 secret", () => {
  const a = generateProxySecret();
  const b = generateProxySecret();
  assert.notEqual(a, b, "两次生成应不同");
  assert.ok(a.length >= 24, "secret 长度应足够");
  assert.match(a, /^[A-Za-z0-9_-]+$/, "base64url 无需 percent-encoding");
});

test("extractSecuredPath 校验并剥离 secret 路径段", () => {
  const secret = "s3cr3t-xyz_123";
  assert.equal(extractSecuredPath(`/${secret}/coding/v1/messages`, secret), "/coding/v1/messages");
  assert.equal(extractSecuredPath(`/${secret}`, secret), "/");
  // 无 secret / 错 secret / 部分匹配 一律拒绝
  assert.equal(extractSecuredPath("/coding/v1/messages", secret), null);
  assert.equal(extractSecuredPath("/wrong/coding/v1/messages", secret), null);
  assert.equal(extractSecuredPath(`/${secret}x/coding`, secret), null, "前缀部分匹配不得放行");
  // secret 为空（代理未启动）时拒绝一切
  assert.equal(extractSecuredPath("/coding", ""), null);
});

test("auth proxy 对无/错 secret 的请求返回 401", async (t) => {
  const port = await startAuthProxy(0);
  t.after(() => stopAuthProxy());
  const secret = getProxySecret();
  assert.ok(secret, "startAuthProxy 应生成 secret");

  const request = (path: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

  assert.equal(await request("/coding/v1/messages"), 401, "无 secret → 401");
  assert.equal(await request("/wrong-secret/coding/v1/messages"), 401, "错 secret → 401");
  // 带对 secret 但路径不在路由表 → 404（说明通过了鉴权进入路由层）
  assert.equal(await request(`/${secret}/nope`), 404, "对 secret + 未知路径 → 404");
});

test("代理重启不复位 secret（同会话内 ensureProxyConfig 幂等）", async (t) => {
  const port = await startAuthProxy(0);
  const first = getProxySecret();
  await stopAuthProxy();
  const port2 = await startAuthProxy(0);
  t.after(() => stopAuthProxy());
  assert.equal(getProxySecret(), first, "重启后 secret 应保持不变");
  assert.notEqual(port2, 0);
});
