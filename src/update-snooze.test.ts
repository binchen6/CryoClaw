import test from "node:test";
import assert from "node:assert/strict";
import { parseSnooze, isSnoozeActive } from "./update-snooze";

// update-snooze 纯逻辑：存储内容容错解析 + 暂缓生效判定。
// 背景：更新弹窗「暂缓」（7天/1月/3月/永久/自定义）期内启动不再自动检查更新。

test("parseSnooze：合法时间戳与 forever", () => {
  assert.deepEqual(parseSnooze({ until: 1788520000000, setAt: 1 }), { until: 1788520000000, setAt: 1 });
  assert.deepEqual(parseSnooze({ until: "forever" }), { until: "forever", setAt: 0 });
});

test("parseSnooze：非法输入一律 null", () => {
  for (const raw of [null, undefined, {}, "forever", 42, { until: 0 }, { until: -1 }, { until: NaN }, { until: "2026-09-11" }, { until: Infinity }]) {
    assert.equal(parseSnooze(raw), null, `应拒绝: ${JSON.stringify(raw)}`);
  }
});

test("isSnoozeActive：未到期/已过期/forever", () => {
  const now = 1_000_000;
  assert.equal(isSnoozeActive(null, now), false);
  assert.equal(isSnoozeActive({ until: now + 1, setAt: 0 }, now), true);
  assert.equal(isSnoozeActive({ until: now, setAt: 0 }, now), false); // 到期即恢复
  assert.equal(isSnoozeActive({ until: "forever", setAt: 0 }, now), true);
});
