/**
 * CI 门：内核 RPC 面审计。
 * 规则：仓库调用但内核未注册的方法/事件（gap）必须全部登记在 docs/kernel-recon/rpc-baseline.json；
 * 基线 kernelVersion 必须与当前 asar 内核一致（内核升级后须重新审计并更新基线）。
 * 运行：npm run test:scripts（node --test "scripts/*.test.mjs"）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runAudit, DEFAULT_ASAR_PATH } from "./kernel-method-audit.mjs";

// gateway.asar 是 gitignored 的本地产物：CI 新检出不存在（tests.yml 不构建资源）。
// 缺席时跳过完整审计（本地/发版机运行），存在时零容忍（0 方法解析即失败）。
const hasAsar = fs.existsSync(DEFAULT_ASAR_PATH);

test("kernel-method-audit: gap 全部登记且内核版本与基线一致", { skip: hasAsar ? false : "gateway.asar 未构建（CI 新检出），跳过全量审计" }, () => {
  const { surface, gaps, baseline } = runAudit();

  assert.ok(surface.methods.size >= 300, `方法表解析过少: ${surface.methods.size}`);
  assert.ok(surface.events.size >= 10, `事件表解析过少: ${surface.events.size}`);
  assert.equal(
    baseline.kernelVersion,
    surface.version,
    `基线 kernelVersion(${baseline.kernelVersion}) 与 asar 内核(${surface.version}) 不一致：请重跑 node scripts/kernel-method-audit.mjs --write-baseline 并人工 review`,
  );

  const unregisteredMethods = Object.keys(gaps.methods).filter((n) => !baseline.methods?.[n]);
  const unregisteredEvents = Object.keys(gaps.events).filter((n) => !baseline.events?.[n]);
  assert.deepEqual(
    unregisteredMethods,
    [],
    `发现未登记的方法 gap（内核移除/改名？）：${unregisteredMethods.join(", ")} —— 确认门控/回退后登记进 rpc-baseline.json`,
  );
  assert.deepEqual(
    unregisteredEvents,
    [],
    `发现未登记的事件 gap：${unregisteredEvents.join(", ")} —— 确认门控/回退后登记进 rpc-baseline.json`,
  );
});

test("kernel-method-audit: computeGaps 纯逻辑", async () => {
  const { computeGaps } = await import("./kernel-method-audit.mjs");
  const surface = { methods: new Set(["a.b"]), events: new Set(["e1"]) };
  const usages = {
    methods: new Map([["a.b", ["x.ts"]], ["a.gone", ["y.ts"]]]),
    events: new Map([["e1", ["x.ts"]], ["e.gone", ["y.ts"]]]),
  };
  const gaps = computeGaps(surface, usages);
  assert.deepEqual(Object.keys(gaps.methods), ["a.gone"]);
  assert.deepEqual(Object.keys(gaps.events), ["e.gone"]);
});
