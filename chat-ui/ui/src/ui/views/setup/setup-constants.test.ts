import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDERS, STATIC_MODEL_FALLBACKS, staticModelsFor, CUSTOM_MODEL_SENTINEL } from "./setup-constants.ts";

// R67 P0 回归锁：全新安装时 gateway 未启动、动态目录为空，任何 provider 都必须有
// 非空候选清单，否则模型控件整体消失、用户无法完成安装。
test("每个非 custom provider 都有非空静态模型兜底（P0 回归锁）", () => {
  for (const key of Object.keys(PROVIDERS)) {
    if (key === "custom") continue;
    const models = staticModelsFor(key);
    assert.ok(models.length > 0, `${key} 缺少静态模型兜底`);
    for (const m of models) {
      assert.equal(typeof m, "string");
      assert.ok(m.trim().length > 0, `${key} 的候选模型不能为空串`);
      assert.notEqual(m, CUSTOM_MODEL_SENTINEL, "候选清单不应包含自定义哨兵");
    }
  }
});

test("moonshot 子平台（含 kimi-code）都有兜底；未知 provider 返回空数组而非抛错", () => {
  assert.ok(STATIC_MODEL_FALLBACKS["kimi-coding"]?.length > 0);
  assert.ok(STATIC_MODEL_FALLBACKS["moonshot-cn"]?.length > 0);
  assert.ok(STATIC_MODEL_FALLBACKS["moonshot-ai"]?.length > 0);
  assert.deepEqual(staticModelsFor("does-not-exist"), []);
});
