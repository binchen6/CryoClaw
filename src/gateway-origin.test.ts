import test from "node:test";
import assert from "node:assert/strict";
import { rewriteLoopbackWsOrigin } from "./gateway-origin";

// 2026.8 起 gateway 强制 Origin 校验：file:// 渲染进程的 ws 握手被拒。
// 改写只作用于环回 ws(s) 握手，把 Origin 改成同 host 的 http origin。

test("ws 环回握手 Origin 改写为同 host http origin", () => {
  const out = rewriteLoopbackWsOrigin("ws://127.0.0.1:19554", { Origin: "file://" });
  assert.equal(out.Origin, "http://127.0.0.1:19554");
});

test("localhost 与 IPv6 环回同样改写", () => {
  assert.equal(rewriteLoopbackWsOrigin("ws://localhost:8080", {}).Origin, "http://localhost:8080");
  assert.equal(rewriteLoopbackWsOrigin("ws://[::1]:9000", {}).Origin, "http://[::1]:9000");
});

test("wss 改写为 https origin", () => {
  const out = rewriteLoopbackWsOrigin("wss://127.0.0.1:4443", {});
  assert.equal(out.Origin, "https://127.0.0.1:4443");
});

test("已有 origin 键大小写不敏感地被替换", () => {
  const out = rewriteLoopbackWsOrigin("ws://127.0.0.1:1", { origin: "null", "X-Other": "keep" });
  assert.equal(out.Origin, "http://127.0.0.1:1");
  assert.equal(out.origin, undefined);
  assert.equal(out["X-Other"], "keep");
});

test("非环回 ws 与原 scheme 非 ws 的请求不动", () => {
  const headers = { Origin: "https://example.com" };
  assert.deepEqual(rewriteLoopbackWsOrigin("ws://192.168.1.10:9000", headers), headers);
  assert.deepEqual(rewriteLoopbackWsOrigin("http://127.0.0.1:19554/api", headers), headers);
  assert.deepEqual(rewriteLoopbackWsOrigin("not a url", headers), headers);
});
