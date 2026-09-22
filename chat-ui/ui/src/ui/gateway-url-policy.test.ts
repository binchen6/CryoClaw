// F8：gatewayUrl scheme 白名单（纯函数）。非法输入（javascript:、http:、
// 畸形串、空）在配置入口即被拒绝，回退默认地址 / 不进确认流程，避免流进
// new WebSocket 后同步抛异常打断启动初始化。
import test from "node:test";
import assert from "node:assert/strict";
import { isAcceptableGatewayUrl } from "./gateway-url-policy.ts";

test("isAcceptableGatewayUrl：接受 ws:// 与 wss://", () => {
  assert.equal(isAcceptableGatewayUrl("ws://127.0.0.1:18789"), true);
  assert.equal(isAcceptableGatewayUrl("wss://gw.example.com/ws"), true);
  assert.equal(isAcceptableGatewayUrl("  ws://127.0.0.1:18789  "), true, "首尾空白应被容忍");
});

test("isAcceptableGatewayUrl：拒绝非 ws(s) scheme 与畸形输入", () => {
  assert.equal(isAcceptableGatewayUrl("javascript:alert(1)"), false);
  assert.equal(isAcceptableGatewayUrl("http://127.0.0.1:18789"), false);
  assert.equal(isAcceptableGatewayUrl("https://gw.example.com"), false);
  assert.equal(isAcceptableGatewayUrl("file:///etc/passwd"), false);
  assert.equal(isAcceptableGatewayUrl("data:text/html,<script>1</script>"), false);
  assert.equal(isAcceptableGatewayUrl("ws://"), false, "缺 host 应拒绝");
  assert.equal(isAcceptableGatewayUrl("not a url"), false);
  assert.equal(isAcceptableGatewayUrl(""), false);
  assert.equal(isAcceptableGatewayUrl(null), false);
  assert.equal(isAcceptableGatewayUrl(undefined), false);
});
