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
