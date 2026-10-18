import test from "node:test";
import assert from "node:assert/strict";
import { trapDialogTab } from "./dialog-a11y.ts";

test("modal Tab wraps in both directions and excludes disabled or hidden controls", () => {
  let focused: unknown;
  const control = (disabled = false, visible = true) => ({
    tabIndex: 0,
    matches: () => disabled,
    closest: () => null,
    getClientRects: () => visible ? [{}] : [],
    focus() { focused = this; },
  });
  const first = control();
  const last = control();
  const dialog = {
    getClientRects: () => [{}],
    querySelectorAll: () => [control(true), first, last, control(false, false)],
    focus() { focused = this; },
  };
  const doc = {
    querySelectorAll: () => [dialog],
    activeElement: last,
    defaultView: { getComputedStyle: () => ({ visibility: "visible" }) },
  };
  const event = (shiftKey = false) => ({ key: "Tab", shiftKey, preventDefault() {} }) as KeyboardEvent;
  assert.equal(trapDialogTab(event(), doc as unknown as Document), true);
  assert.equal(focused, first);
  doc.activeElement = first;
  assert.equal(trapDialogTab(event(true), doc as unknown as Document), true);
  assert.equal(focused, last);
  assert.equal(trapDialogTab(event(), doc as unknown as Document), false);
  doc.activeElement = control();
  assert.equal(trapDialogTab(event(), doc as unknown as Document), true);
  assert.equal(focused, first);
});

test("modal without controls retains focus; non-modal Tab is unchanged", () => {
  let focused = false;
  const dialog = {
    getClientRects: () => [{}], querySelectorAll: () => [],
    focus() { focused = true; },
  };
  const event = { key: "Tab", preventDefault() {} } as KeyboardEvent;
  assert.equal(trapDialogTab(event, {
    querySelectorAll: () => [dialog],
  } as unknown as Document), true);
  assert.equal(focused, true);
  assert.equal(trapDialogTab(event, {
    querySelectorAll: () => [],
  } as unknown as Document), false);
});
