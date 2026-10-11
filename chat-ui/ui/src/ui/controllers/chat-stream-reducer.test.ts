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

test("legacy snapshot path emits invalidatesFrozenPrefix when full text dropped the prefix", () => {
  // Bug1-C：旧版快照路径（无 deltaText）此前只切片不发作废信号——工具前文本被
  // 内核改写后（全文不再以 frozenPrefix 开头），冻结段留在时间线上与新正文双份。
  // 现与 deltaText-replace 分支同契约发作废信号。
  const result = reduceChatStreamDelta({
    currentText: "trail",
    message: { content: [{ type: "text", text: "regenerated from scratch" }] },
    frozenPrefix: "before tool",
  });
  assert.deepEqual(result, {
    text: "regenerated from scratch",
    accepted: true,
    source: "snapshot",
    replaced: false,
    invalidatesFrozenPrefix: true,
  });
});

test("legacy replace snapshot beyond the frozen prefix invalidates it", () => {
  const result = reduceChatStreamDelta({
    currentText: "trail",
    replace: true,
    message: { content: [{ type: "text", text: "rewritten body" }] },
    frozenPrefix: "before tool",
  });
  assert.equal(result?.invalidatesFrozenPrefix, true);
  assert.equal(result?.text, "rewritten body");
});

test("legacy snapshot within the frozen prefix keeps frozen segments intact", () => {
  const result = reduceChatStreamDelta({
    currentText: "trail",
    message: { content: [{ type: "text", text: "before tooltrail" }] },
    frozenPrefix: "before tool",
  });
  assert.equal(result?.invalidatesFrozenPrefix, undefined);
  assert.equal(result?.text, "trail");
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

test("R5: mismatched snapshots that are not forward extensions keep appending conservatively", () => {
  // Bug1-D 前置条件：连续失配第 3 帧的强制 resync 只允许在「fullText 是 base
  // （frozenPrefix+current）的前向延伸」时发生。滞后/分叉快照（如此处 fullText
  // 与 base 完全无关）resync 会把已上屏文本回跳、冻结段留在时间线上 → 双份闪现。
  // 新语义：不满足前向条件则继续保守追加（计数仍累计），等后续帧重新对齐。
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

  // 第 3 帧达到阈值，但快照不是前向延伸 → 不回跳、不作废冻结段
  const r3 = reduceChatStreamDelta(mk(r2?.mismatchCount));
  assert.deepEqual(r3, {
    text: "corrupted local text more",
    accepted: true,
    source: "deltaText",
    replaced: false,
    mismatchCount: 3,
  });
});

test("R5: a forward-extension snapshot self-heals immediately (mismatch counter resets)", () => {
  // 基线漂移后内核快照是 base 的前向延伸（丢帧形态）→ R88 self-heal 首帧即收敛，
  // 无需等 R5 阈值；计数清零。
  const bad = reduceChatStreamDelta({
    currentText: "local",
    deltaText: " x",
    message: { content: [{ type: "text", text: "unrelated snapshot" }] },
    frozenPrefix: "pre",
  });
  assert.equal(bad?.mismatchCount, 1);
  const healed = reduceChatStreamDelta({
    currentText: "local x",
    deltaText: " y",
    message: { content: [{ type: "text", text: "prelocal x gap y" }] },
    frozenPrefix: "pre",
    mismatchCount: bad?.mismatchCount,
  });
  // base = "pre" + "local x" = "prelocal x"；fullText "prelocal x gap y" 是其前向
  // 延伸（基线漏了 " gap"）且与追加结果不对齐 → self-heal：切片 frozenPrefix 后整段采用
  assert.equal(healed?.text, "local x gap y");
  assert.equal(healed?.source, "snapshot");
  assert.equal(healed?.replaced, true);
  assert.equal(healed?.mismatchCount, 0);
});

test("R5: regressed snapshot at the threshold never moves the stream backwards", () => {
  // Bug1-D：阈值到达时快照仍含 frozenPrefix 但全文比本地基线短/回退（滞后读）——
  // 旧行为强制 resync 会把可见文本从 "corrupted" 回跳成更短文本并重复闪现；
  // 新行为保守追加，冻结段保持有效。
  const r = reduceChatStreamDelta({
    currentText: "corrupted",
    deltaText: " x",
    message: { content: [{ type: "text", text: "prekernel truth x" }] },
    frozenPrefix: "pre",
    mismatchCount: 2,
  });
  assert.equal(r?.text, "corrupted x");
  assert.equal(r?.invalidatesFrozenPrefix, undefined, "冻结段未被改写，不得发作废信号");
  assert.equal(r?.mismatchCount, 3, "前向条件不满足：计数继续累计");
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
