import test from "node:test";
import assert from "node:assert/strict";
import {
  GATEWAY_PROGRESS_STEPS,
  gatewayStepIndex,
  gatewayStepKey,
  mapCloseCodeToPhase,
} from "./gateway-connection.ts";

// ── 关闭码 → 连接阶段映射 ──────────────────────────────────────────────
// 1012/1013 是内核启动/重启窗口的正常信号（信息态 starting）；
// 1006 异常断开等 → reconnecting（自动退避重连，不是错误终态）。

test("mapCloseCodeToPhase：1012/1013 → starting（服务重启，信息态）", () => {
  assert.equal(mapCloseCodeToPhase(1012), "starting");
  assert.equal(mapCloseCodeToPhase(1013), "starting");
});

test("mapCloseCodeToPhase：1006 等异常关闭 → reconnecting", () => {
  assert.equal(mapCloseCodeToPhase(1006), "reconnecting");
  assert.equal(mapCloseCodeToPhase(1001), "reconnecting");
  assert.equal(mapCloseCodeToPhase(4000), "reconnecting");
  assert.equal(mapCloseCodeToPhase(1015), "reconnecting");
});

// ── 启动步骤序列 ────────────────────────────────────────────────────────

test("gatewayStepIndex：六个已知步骤按启动顺序排序，未知步骤 -1", () => {
  assert.deepEqual(
    GATEWAY_PROGRESS_STEPS.map((s) => gatewayStepIndex(s)),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(gatewayStepIndex("nope"), -1);
  assert.equal(gatewayStepIndex(""), -1);
});

test("gatewayStepKey：已知步骤映射到本地化 key，未知步骤走兜底", () => {
  assert.equal(gatewayStepKey("cleanup"), "gateway.starting.step.cleanup");
  assert.equal(gatewayStepKey("ready"), "gateway.starting.step.ready");
  assert.equal(gatewayStepKey("unknown-step"), "gateway.starting.step.unknown");
});
