import test from "node:test";
import assert from "node:assert/strict";
import { parseSnooze, isSnoozeActive, writeSnooze } from "./update-snooze";

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

test("isSnoozeActive：until 落在未来过远（时钟回拨/文件被改）视为无效", () => {
  const now = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  // 正常区间（自定义暂缓最长数月）照常生效
  assert.equal(isSnoozeActive({ until: now + 30 * DAY, setAt: now }, now), true);
  // 边界：正好 now + 3650d 仍生效，超出即视为无效（否则暂缓会一直静默到那个日期）
  assert.equal(isSnoozeActive({ until: now + 3650 * DAY, setAt: now }, now), true);
  assert.equal(isSnoozeActive({ until: now + 3650 * DAY + 1, setAt: now }, now), false);
  assert.equal(isSnoozeActive({ until: now + 5000 * DAY, setAt: now }, now), false);
});

test("writeSnooze：写盘失败只记日志不抛（对齐 clearSnooze / 退避记录）", () => {
  // node:test 下 electron 不可用（require("electron") 得到的是二进制路径字符串），
  // snoozeFilePath() 里的 app.getPath 必然抛错——正好覆盖「持久化失败不抛」分支；
  // 去掉 try/catch 时该 TypeError 会逃出 writeSnooze 让本用例失败
  assert.doesNotThrow(() => writeSnooze(Date.now() + 7 * 24 * 60 * 60 * 1000));
});
