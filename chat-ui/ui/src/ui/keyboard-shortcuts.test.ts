import {test} from "node:test";
import assert from "node:assert/strict";
import {BUILTIN_SHORTCUTS, configureShortcuts, filterShortcuts, formatShortcut, getShortcutBinding, matchesShortcut, resolveChatShortcut, shortcutFromKeyboardEvent} from "./keyboard-shortcuts.ts";

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

test("custom bindings apply immediately and unassigned shortcuts stay inert", () => {
  configureShortcuts({newSession: "Ctrl+Shift+X", focusComposer: ""});
  assert.equal(resolveChatShortcut(key({key: "x", shiftKey: true})), "new-session");
  assert.equal(resolveChatShortcut(key()), null);
  assert.equal(matchesShortcut(key({key: "l"}), "focusComposer"), false);
  assert.equal(getShortcutBinding("focusComposer"), "");
  configureShortcuts({});
  assert.equal(resolveChatShortcut(key()), "new-session");
});

test("Ctrl and Mod have distinct matching semantics", () => {
  assert.equal(resolveChatShortcut(key({metaKey: true})), null);
  assert.equal(matchesShortcut(key({key: "Enter"}), "send"), true);
  assert.equal(matchesShortcut(key({key: "Enter", metaKey: true, ctrlKey: false}), "send"), true);
  assert.equal(matchesShortcut(key({key: "Enter", shiftKey: true}), "send"), false);
});

test("shortcut capture supports modifiers, single action keys and rejects plain letters", () => {
  const capture = (overrides: Partial<KeyboardEvent>) => shortcutFromKeyboardEvent({
    key: "g", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true,
    isComposing: false, keyCode: 71, ...overrides,
  } as KeyboardEvent);
  assert.equal(capture({}), "Mod+Shift+G");
  assert.equal(capture({key: "Enter", ctrlKey: false, shiftKey: false, keyCode: 13}), "Enter");
  assert.equal(capture({key: "a", ctrlKey: false, shiftKey: false, keyCode: 65}), null);
  assert.equal(capture({key: "Shift", ctrlKey: false, shiftKey: true}), null);
  assert.deepEqual(formatShortcut("Mod+Shift+G"), ["Ctrl / ⌘", "Shift", "G"]);
});
