import test from "node:test";
import assert from "node:assert/strict";
import { toolCodeSections, visibleToolCode } from "./tool-presentation.ts";

test("read exposes only received source, retaining its path and language", () => {
  const card = { kind: "call" as const, name: "read", args: { path: "src/main.ts" }, text: "const x = '<script>';" };
  assert.deepEqual(toolCodeSections(card, "typescript"), [{ kind: "read", title: "src/main.ts", text: card.text, language: "typescript" }]);
  assert.deepEqual(toolCodeSections({ ...card, pending: true }), []);
});
test("requested edit preserves real multiline additions/deletions without claiming success", () => {
  const sections = toolCodeSections({ kind: "call", name: "edit", pending: true, args: { file_path: "a.ts", old_string: "a\r\nb", new_string: "c\nd" } });
  assert.equal(sections[0].text, "- a\n- b\n+ c\n+ d");
  assert.equal(sections[0].kind, "diff");
  assert.equal(sections[0].title, "a.ts");
  assert.deepEqual(toolCodeSections({ kind: "call", name: "edit", args: { old_string: "x", new_string: "" } })[0].text, "- x\n+ ");
});
test("exec command and received output are separate; pending is not a completed process", () => {
  const card = { kind: "call" as const, name: "exec", args: { script: "sleep 3 &", cwd: "/tmp" }, text: "background job accepted" };
  assert.deepEqual(toolCodeSections({ ...card, pending: true }).map(section => section.kind), ["command"]);
  assert.deepEqual(toolCodeSections(card).map(section => section.kind), ["command", "output"]);
  assert.equal(toolCodeSections(card)[0].title, "/tmp");
});
test("render cap never changes the source used for copy", () => {
  const source = "0123456789";
  assert.equal(visibleToolCode(source, 5), "01234\n…");
  assert.equal(source, "0123456789");
  assert.equal(visibleToolCode("short"), "short");
});
test("unknown tools retain the existing generic rendering fallback", () => {
  assert.deepEqual(toolCodeSections({ kind: "result", name: "browser", text: "hello" }), []);
});
