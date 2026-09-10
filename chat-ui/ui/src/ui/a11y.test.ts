import test from "node:test";
import assert from "node:assert/strict";
import { activateOnKeydown } from "./a11y.ts";
import { isEscapeKey } from "./dialog-a11y.ts";

function key(k: string, repeat = false): KeyboardEvent {
  return { key: k, repeat, preventDefault() { (this as any).prevented = true; } } as unknown as KeyboardEvent;
}

test("activateOnKeydown：Enter/Space 触发且拦截默认行为，其他键不触发", () => {
  let hits = 0;
  const handler = activateOnKeydown(() => hits++);
  const enter = key("Enter"); handler(enter);
  const space = key(" "); handler(space);
  const tab = key("Tab"); handler(tab);
  const esc = key("Escape"); handler(esc);
  assert.equal(hits, 2, "仅 Enter 与 Space 触发");
  assert.equal((enter as any).prevented, true, "Space 默认滚动需拦截");
  assert.equal((tab as any).prevented, undefined, "Tab 不拦截");
  assert.equal((esc as any).prevented, undefined, "Escape 不拦截（交给弹窗层）");
});

test("activateOnKeydown：长按 repeat 不重复触发", () => {
  let hits = 0;
  const handler = activateOnKeydown(() => hits++);
  handler(key("Enter", true));
  handler(key(" ", true));
  assert.equal(hits, 0);
});

test("isEscapeKey：识别 Escape/Esc 与旧式 keyCode 27，其他键为 false", () => {
  assert.equal(isEscapeKey({ key: "Escape" }), true);
  assert.equal(isEscapeKey({ key: "Esc" }), true);
  assert.equal(isEscapeKey({ keyCode: 27 }), true);
  assert.equal(isEscapeKey({ key: "Enter" }), false);
  assert.equal(isEscapeKey({}), false);
});
