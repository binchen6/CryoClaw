import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_KERNEL_UPGRADE_BACKOFF_MS,
  isBackoffActive,
  parseBackoffState,
} from "./auto-kernel-upgrade-backoff";

// auto-kernel-upgrade-backoff 纯逻辑：存储内容容错解析 + 退避生效判定。
// 背景：自动内核升级失败后 24h 内启动不再自动重试（手动升级不受影响）。

test("parseBackoffState：合法记录", () => {
  assert.deepEqual(
    parseBackoffState({ lastFailedAt: 1788520000000, lastFailedFromVersion: "2026.7.1-2" }),
    { lastFailedAt: 1788520000000, lastFailedFromVersion: "2026.7.1-2" },
  );
  // 版本字段缺失/非字符串时归一为 null
  assert.deepEqual(parseBackoffState({ lastFailedAt: 1788520000000 }), {
    lastFailedAt: 1788520000000,
    lastFailedFromVersion: null,
  });
  assert.deepEqual(
    parseBackoffState({ lastFailedAt: 1788520000000, lastFailedFromVersion: 42 }),
    { lastFailedAt: 1788520000000, lastFailedFromVersion: null },
  );
});

test("parseBackoffState：非法输入一律 null", () => {
  for (const raw of [
    null,
    undefined,
    {},
    "2026.7.1-2",
    42,
    { lastFailedAt: 0 },
    { lastFailedAt: -1 },
    { lastFailedAt: NaN },
    { lastFailedAt: "1788520000000" },
    { lastFailedAt: Infinity },
  ]) {
    assert.equal(parseBackoffState(raw), null, `应拒绝: ${JSON.stringify(raw)}`);
  }
});

test("isBackoffActive：窗口内生效，窗口外/无记录不生效", () => {
  const now = 10_000_000_000;
  assert.equal(isBackoffActive(null, now), false);
  assert.equal(isBackoffActive({ lastFailedAt: now - 1000, lastFailedFromVersion: null }, now), true);
  // 正好到达窗口边界即恢复
  assert.equal(
    isBackoffActive({ lastFailedAt: now - AUTO_KERNEL_UPGRADE_BACKOFF_MS, lastFailedFromVersion: null }, now),
    false,
  );
  assert.equal(
    isBackoffActive({ lastFailedAt: now - AUTO_KERNEL_UPGRADE_BACKOFF_MS - 1, lastFailedFromVersion: null }, now),
    false,
  );
});

test("isBackoffActive：lastFailedAt 落在未来（时钟被回拨）视为无效记录", () => {
  const now = 10_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  // 未来 1 分钟：旧逻辑下 now - lastFailedAt 为负 → 退避窗口被拉长到「时钟追上 + 24h」
  assert.equal(isBackoffActive({ lastFailedAt: now + 60_000, lastFailedFromVersion: null }, now), false);
  // 未来数天：自动内核升级静默停摆数天
  assert.equal(isBackoffActive({ lastFailedAt: now + 5 * DAY, lastFailedFromVersion: null }, now), false);
  // 边界：正好等于 now（非未来）仍按退避窗口判定
  assert.equal(isBackoffActive({ lastFailedAt: now, lastFailedFromVersion: null }, now), true);
});
