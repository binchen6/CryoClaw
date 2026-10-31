import {test} from "node:test";
import assert from "node:assert/strict";
import {BUILTIN_SHORTCUTS, filterShortcuts, resolveChatShortcut} from "./keyboard-shortcuts.ts";

function key(overrides: Partial<KeyboardEvent> = {}) {
  return {key: "n", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, keyCode: 78, defaultPrevented: false, ...overrides};
}

test("chat shortcuts match exact existing Ctrl combinations", () => {
  assert.equal(resolveChatShortcut(key()), "new-session");
  assert.equal(resolveChatShortcut(key({key: "L"})), "focus-composer");
  assert.equal(resolveChatShortcut(key({key: "x"})), null);
});

test("IME, held keys, consumed input, modal dialogs and modified combinations do not fire", () => {
  for (const overrides of [{repeat: true}, {isComposing: true}, {keyCode: 229}, {defaultPrevented: true},
    {ctrlKey: false}, {metaKey: true}, {altKey: true}, {shiftKey: true}]) {
    assert.equal(resolveChatShortcut(key(overrides)), null);
  }
  assert.equal(resolveChatShortcut(key(), true), null);
});

test("shortcut search matches all terms across labels, descriptions and keycaps", () => {
  const rows = [{label: "保存文件", description: "Workspace editor", keys: ["Ctrl", "S"]},
    {label: "New chat", description: "Conversation", keys: ["Ctrl", "N"]}];
  assert.deepEqual(filterShortcuts(rows, " ctrl  workspace "), [rows[0]]);
  assert.deepEqual(filterShortcuts(rows, "CHAT"), [rows[1]]);
  assert.deepEqual(filterShortcuts(rows, "保存"), [rows[0]]);
  assert.deepEqual(filterShortcuts(rows, ""), rows);
  assert.deepEqual(filterShortcuts(rows, "missing"), []);
  assert.equal(new Set(BUILTIN_SHORTCUTS.map(row => row.id)).size, BUILTIN_SHORTCUTS.length);
});
