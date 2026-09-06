import test from "node:test";
import assert from "node:assert/strict";
import { reduceChatStreamDelta } from "./chat-stream-reducer.ts";

test("protocol v4 deltaText appends without re-reading cumulative message", () => {
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
