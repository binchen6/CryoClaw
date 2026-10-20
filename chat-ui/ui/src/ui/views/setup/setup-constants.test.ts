import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROVIDERS, STATIC_MODEL_FALLBACKS, staticModelsFor, CUSTOM_MODEL_SENTINEL, KIMI_PRICING_URL } from "./setup-constants.ts";

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

// 定价页链接回归锁：setup 与 settings 两处「无会员」提示必须共用同一常量，
// 不允许再回到各自硬编码字面量（否则改链接要同步两处，易漂移）。
test("Kimi 定价页链接唯一出处：两处视图共享 KIMI_PRICING_URL 常量", () => {
  assert.equal(KIMI_PRICING_URL, "https://kimi.com/pricing?utm_source=oneclaw");
  for (const rel of ["views/settings/tab-provider.ts", "views/setup/setup-step2-provider.ts"]) {
    const src = readFileSync(new URL(`../../../../../../src/ui/${rel}`, import.meta.url), "utf8");
    assert.ok(src.includes("KIMI_PRICING_URL"), `${rel} 应使用共享常量 KIMI_PRICING_URL`);
    assert.ok(!src.includes("https://kimi.com/pricing"), `${rel} 不应再硬编码定价链接字面量`);
  }
});

// 键盘可达性回归锁：外链锚点必须带真实 href（原生可聚焦、Enter 激活即触发既有
// @click 的 preventDefault + openExternal），不得退回无 href 的纯 @click 锚点
// （键盘完全不可达，与第 23 轮 git 链接同类）。中键/新窗口由窗口层
// setWindowOpenHandler deny 兜底，href 不会造成应用内导航。
test("oc-provider-link / oc-setup-link 外链锚点均带真实 href（键盘可达）", () => {
  for (const rel of ["views/settings/tab-provider.ts", "views/setup/setup-step2-provider.ts"]) {
    const src = readFileSync(new URL(`../../../../../../src/ui/${rel}`, import.meta.url), "utf8");
    const anchors = src.match(/<a class="oc-(?:provider|setup)-link"[^>\n]*>/g) ?? [];
    assert.ok(anchors.length > 0, `${rel} 应至少存在一个外链锚点`);
    for (const a of anchors) {
      assert.ok(a.includes("href="), `${rel} 的外链锚点缺少 href：${a}`);
    }
  }
});
