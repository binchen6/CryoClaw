import test from "node:test";
import assert from "node:assert/strict";
import { reduceChatStreamDelta } from "./chat-stream-reducer.ts";

test("protocol v4 append with consistent full snapshot appends the delta", () => {
  // 内核 broadcastChatDelta：同一帧的 message 全量与 deltaText 恒一致（同源构造），
  // 一致时走纯追加（官方 DT 合并行为）。
  const result = reduceChatStreamDelta({
    currentText: "Hello",
    deltaText: " world",
    message: { content: [{ type: "text", text: "Hello world" }] },
  });
  assert.deepEqual(result, {
    text: "Hello world",
    accepted: true,
    source: "deltaText",
    replaced: false,
    mismatchCount: 0,
  });
});

test("self-heal: append frame after a lost frame resyncs from the full snapshot", () => {
  // R88 对齐官方 DT：丢帧（seq gap / 重连收养后基线为空）时 current+delta 与全量
  // 不再对齐，下一帧以 message 全量自纠，而不是把增量追加在坏基线上。
  const result = reduceChatStreamDelta({
    currentText: "",
    deltaText: " world",
    message: { content: [{ type: "text", text: "Hello big world" }] },
  });
  assert.equal(result?.text, "Hello big world");
  assert.equal(result?.accepted, true);
  assert.equal(result?.source, "snapshot");
});

test("self-heal: stale (behind) snapshot on an append frame keeps the local stream", () => {
  // 全量比本地可见文本还短（滞后读/异常帧）：不能倒退，保守追加增量等下一帧对齐
  const result = reduceChatStreamDelta({
    currentText: "Hello",
    deltaText: " world",
    message: { content: [{ type: "text", text: "stale snapshot" }] },
  });
  assert.deepEqual(result, {
    text: "Hello world",
    accepted: true,
    source: "deltaText",
    replaced: false,
    mismatchCount: 1,
  });
});

test("replace accepts a shorter frame instead of treating it as out of order", () => {
  const result = reduceChatStreamDelta({
    currentText: "old long text",
    deltaText: "new",
    replace: true,
  });
  assert.equal(result?.text, "new");
  assert.equal(result?.accepted, true);
  assert.equal(result?.replaced, true);
});

test("legacy cumulative snapshots still remove the frozen tool prefix", () => {
  const result = reduceChatStreamDelta({
    currentText: "trailing",
    message: { content: [{ type: "text", text: "before tooltrailing next" }] },
    frozenPrefix: "before tool",
  });
  assert.equal(result?.text, "trailing next");
  assert.equal(result?.accepted, true);
});

test("legacy snapshots reject backwards movement without replace", () => {
  const result = reduceChatStreamDelta({
    currentText: "a longer visible segment",
    message: { content: [{ type: "text", text: "short" }] },
  });
  assert.equal(result?.accepted, false);
  assert.equal(result?.text, "a longer visible segment");
});

test("provider fallback rewind arrives as a replace frame carrying the full text", () => {
  // 内核 resolveBroadcastDelta：文本不再以前次广播为前缀时发 { deltaText: 全文, replace: true }
  const result = reduceChatStreamDelta({
    currentText: "answer from primary provider that failed midway",
    deltaText: "regenerated answer from the fallback provider",
    replace: true,
  });
  assert.equal(result?.text, "regenerated answer from the fallback provider");
  assert.equal(result?.accepted, true);
  assert.equal(result?.replaced, true);
});

test("replace frame strips the frozen tool prefix like the legacy snapshot path", () => {
  // 工具调用冻结了 "before tool" 前缀后，replace 帧的 deltaText 是整轮全文（含前缀），
  // 直接整段采用会把工具前文本在气泡里重复显示一次。
  const result = reduceChatStreamDelta({
    currentText: "trail",
    deltaText: "before toolregenerated trail next",
    replace: true,
    frozenPrefix: "before tool",
  });
  assert.equal(result?.text, "regenerated trail next");
});

test("R3: replace frame that no longer starts with the frozen prefix invalidates it", () => {
  // provider 越过 tool 边界整体重生成：全文不含已冻结前缀 → 旧 leadingSegment 已被
  // 改写，reducer 整段采用新文本并发出作废信号（消费方清掉被重写的冻结段）。
  const result = reduceChatStreamDelta({
    currentText: "trail",
    deltaText: "regenerated from scratch",
    replace: true,
    frozenPrefix: "before tool",
  });
  assert.deepEqual(result, {
    text: "regenerated from scratch",
    accepted: true,
    source: "deltaText",
    replaced: true,
    invalidatesFrozenPrefix: true,
    mismatchCount: 0,
  });
});

test("R3: replace frame without a frozen prefix does not invalidate anything", () => {
  const result = reduceChatStreamDelta({
    currentText: "old",
    deltaText: "regenerated",
    replace: true,
  });
  assert.equal(result?.invalidatesFrozenPrefix, undefined);
  assert.equal(result?.text, "regenerated");
});

test("R5: conservative append for the first mismatching frames, forced snapshot resync at the 3rd", () => {
  // 基线彻底偏离内核（如连续丢帧 + 收养错基线）：第 1、2 帧保守追加并累计计数，
  // 第 3 帧强制以 message 快照 resync（按 frozenPrefix 切片），文本重新收敛。
  const mk = (mismatchCount?: number) => ({
    currentText: "corrupted local text",
    deltaText: " more",
    message: { content: [{ type: "text", text: "kernel truth more" }] },
    frozenPrefix: "pre",
    ...(mismatchCount === undefined ? {} : { mismatchCount }),
  });
  const r1 = reduceChatStreamDelta(mk());
  assert.equal(r1?.text, "corrupted local text more");
  assert.equal(r1?.source, "deltaText");
  assert.equal(r1?.mismatchCount, 1);

  const r2 = reduceChatStreamDelta(mk(r1?.mismatchCount));
  assert.equal(r2?.text, "corrupted local text more");
  assert.equal(r2?.mismatchCount, 2);

  const r3 = reduceChatStreamDelta(mk(r2?.mismatchCount));
  // 第 3 帧：fullText "kernel truth more" 不以 base("pre" + current) 开头 →
  // 计数达到阈值 → 强制 resync：fullText 不以 frozenPrefix 开头 → 整段采用，
  // 且与 R3 同形态发出 frozenPrefix 作废信号（冻结段已被内核改写，防旧段双份）
  assert.deepEqual(r3, {
    text: "kernel truth more",
    accepted: true,
    source: "snapshot",
    replaced: true,
    invalidatesFrozenPrefix: true,
    mismatchCount: 0,
  });
});

test("R5: forced resync keeps the frozen prefix when the snapshot still contains it", () => {
  // 快照仍含 frozenPrefix（普通漂移，非前缀重写）：resync 按前缀切片，
  // 不作废冻结段（无 invalidatesFrozenPrefix 信号）。
  const r = reduceChatStreamDelta({
    currentText: "corrupted",
    deltaText: " x",
    message: { content: [{ type: "text", text: "prekernel truth x" }] },
    frozenPrefix: "pre",
    mismatchCount: 2,
  });
  assert.equal(r?.text, "kernel truth x");
  assert.equal(r?.invalidatesFrozenPrefix, undefined);
  assert.equal(r?.mismatchCount, 0);
});

test("R5: mismatch counter resets as soon as a frame cross-checks cleanly", () => {
  const bad = reduceChatStreamDelta({
    currentText: "Hello",
    deltaText: " world",
    message: { content: [{ type: "text", text: "unrelated snapshot" }] },
  });
  assert.equal(bad?.mismatchCount, 1);
  const good = reduceChatStreamDelta({
    currentText: "Hello world",
    deltaText: "!",
    message: { content: [{ type: "text", text: "Hello world!" }] },
    mismatchCount: bad?.mismatchCount,
  });
  assert.equal(good?.mismatchCount, 0);
  assert.equal(good?.text, "Hello world!");
});

test("append frames are never prefix-stripped (they are post-tool suffixes)", () => {
  const result = reduceChatStreamDelta({
    currentText: "hello",
    deltaText: " world",
    frozenPrefix: "hello",
  });
  assert.equal(result?.text, "hello world");
});

test("stress: 2000 mixed deltas with tool freezes and one mid-stream replace stay exact", () => {
  let current = "";
  let frozen = "";
  const expected0 = [];
  // 段 1：500 帧 append
  for (let i = 0; i < 500; i++) {
    const chunk = "a" + i + " ";
    const r = reduceChatStreamDelta({ currentText: current, deltaText: chunk });
    assert.equal(r?.accepted, true);
    current = r?.text ?? "";
  }
  // 工具边界：冻结当前段
  frozen = current;
  // 段 2：300 帧 append（工具后新段）
  for (let i = 0; i < 300; i++) {
    const r = reduceChatStreamDelta({
      currentText: current,
      deltaText: "b" + i + " ",
      frozenPrefix: frozen,
    });
    current = r?.text ?? "";
  }
  // 段 3：provider fallback —— replace 帧带全文（含冻结前缀）
  const fullAfterFallback = frozen + "regenerated tail ";
  const r = reduceChatStreamDelta({
    currentText: current,
    deltaText: fullAfterFallback,
    replace: true,
    frozenPrefix: frozen,
  });
  assert.equal(r?.text, "regenerated tail ");
  current = r?.text ?? "";
  // 段 4：1200 帧 append 续流
  for (let i = 0; i < 1200; i++) {
    const r2 = reduceChatStreamDelta({
      currentText: current,
      deltaText: "c" + i + " ",
      frozenPrefix: frozen,
    });
    current = r2?.text ?? "";
  }
  assert.ok(current.startsWith("regenerated tail c0 c1 "));
  assert.ok(current.endsWith("c1199 "));
  const cCount = (current.match(/c\d+ /g) || []).length;
  assert.equal(cCount, 1200, "no append frame may be dropped or duplicated");
});
