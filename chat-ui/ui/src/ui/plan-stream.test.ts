import test from "node:test";
import assert from "node:assert/strict";

import {
  dismissPlan,
  extractPlanPayload,
  handlePlanToolEvent,
  parsePlanSteps,
  type PlanStreamHost,
} from "./plan-stream.ts";

function makeHost(): PlanStreamHost {
  return { planState: null };
}

test("parsePlanSteps：合法数组原样归一", () => {
  const steps = parsePlanSteps([
    { step: "读文件", status: "completed" },
    { step: "改代码", status: "in_progress" },
    { step: "跑测试", status: "pending" },
  ]);
  assert.deepEqual(steps, [
    { step: "读文件", status: "completed" },
    { step: "改代码", status: "in_progress" },
    { step: "跑测试", status: "pending" },
  ]);
});

test("parsePlanSteps：容错——跳过非对象/空 step，未知 status 归一为 pending", () => {
  const steps = parsePlanSteps([
    "not-an-object",
    { step: "  ", status: "completed" },
    { step: "有效步骤", status: "weird" },
    { step: "无状态" },
  ]);
  assert.deepEqual(steps, [
    { step: "有效步骤", status: "pending" },
    { step: "无状态", status: "pending" },
  ]);
});

test("parsePlanSteps：非数组或全非法返回 null", () => {
  assert.equal(parsePlanSteps("x"), null);
  assert.equal(parsePlanSteps([]), null);
  assert.equal(parsePlanSteps([{ step: "" }]), null);
});

test("extractPlanPayload：start 阶段 args 顶层直取", () => {
  const payload = extractPlanPayload({
    explanation: "先做调研",
    plan: [{ step: "搜资料", status: "in_progress" }],
  });
  assert.deepEqual(payload, {
    steps: [{ step: "搜资料", status: "in_progress" }],
    explanation: "先做调研",
  });
});

test("extractPlanPayload：result 阶段从 details 取", () => {
  const payload = extractPlanPayload({
    details: {
      status: "updated",
      plan: [{ step: "完成", status: "completed" }],
    },
  });
  assert.deepEqual(payload, {
    steps: [{ step: "完成", status: "completed" }],
    explanation: null,
  });
});

test("extractPlanPayload：兜底解析 content 文本里的 JSON", () => {
  const payload = extractPlanPayload({
    content: [
      {
        type: "text",
        text: JSON.stringify({ plan: [{ step: "x", status: "pending" }] }),
      },
    ],
  });
  assert.deepEqual(payload, {
    steps: [{ step: "x", status: "pending" }],
    explanation: null,
  });
});

test("handlePlanToolEvent：start 上屏、result 校正、dismissed 重置", () => {
  const host = makeHost();
  handlePlanToolEvent(host, {
    runId: "r1",
    phase: "start",
    data: { args: { plan: [{ step: "a", status: "in_progress" }] } },
  });
  assert.equal(host.planState?.steps.length, 1);
  assert.equal(host.planState?.dismissed, false);

  dismissPlan(host);
  assert.equal(host.planState?.dismissed, true);

  handlePlanToolEvent(host, {
    runId: "r1",
    phase: "result",
    data: {
      result: {
        details: {
          plan: [
            { step: "a", status: "completed" },
            { step: "b", status: "in_progress" },
          ],
        },
      },
    },
  });
  assert.equal(host.planState?.steps.length, 2);
  assert.equal(host.planState?.steps[0]?.status, "completed");
  // 新事件到达 → 面板重新出现
  assert.equal(host.planState?.dismissed, false);
});

test("handlePlanToolEvent：解析失败保留旧状态", () => {
  const host = makeHost();
  handlePlanToolEvent(host, {
    runId: "r1",
    phase: "start",
    data: { args: { plan: [{ step: "a", status: "pending" }] } },
  });
  const before = host.planState;
  handlePlanToolEvent(host, {
    runId: "r1",
    phase: "result",
    data: { result: { details: { status: "updated" } } },
  });
  assert.equal(host.planState, before);
});
