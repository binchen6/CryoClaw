import test from "node:test";
import assert from "node:assert/strict";
const globals = globalThis as Record<string, unknown>;
globals.customElements ??= { define() {}, get() { return undefined; } };
globals.window ??= { document: { nodeType: 9, currentScript: null, createElement: () => ({}) }, Element: class {} };
const { commandHistory, filterCommandHistory, COMMAND_PAGE_SIZE } = await import("./command-history.ts");
function message(id: string, command: string, pending = false, exitCode?: number) {
  return { role: "assistant", runId: "r", pending, content: [{ type: "toolCall", id, name: "exec", arguments: { command }, ...(pending ? {} : { text: "received", exitCode }) }] };
}
test("history is newest first and filters tool pending, not OS liveness", () => {
  const entries = commandHistory([message("a", "background &", false, 0), message("b", "pwd", true), message("c", "false", false, 1)]);
  assert.deepEqual(entries.map(entry => entry.command), ["false", "pwd", "background &"]);
  assert.deepEqual(filterCommandHistory(entries, "running").map(entry => entry.command), ["pwd"]);
  assert.deepEqual(filterCommandHistory(entries, "finished").map(entry => entry.command), ["false", "background &"]);
  assert.equal(entries[0].failed, true);
  assert.equal(entries[2].failed, false);
});
test("stable tool ids survive newer messages and immutable completion replacement", () => {
  const first = message("a", "pwd", true);
  const key = commandHistory([first])[0].key;
  assert.equal(commandHistory([message("a", "pwd"), message("b", "ls")])[1].key, key);
});
test("script/cmd aliases and malformed/non-command messages are handled", () => {
  const entries = commandHistory([null, "text", {}, { content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
    { content: [{ type: "toolCall", name: "bash", arguments: { script: "echo script" } }] },
    { content: [{ type: "toolCall", name: "shell", arguments: { cmd: "echo cmd" } }] }]);
  assert.deepEqual(entries.map(entry => entry.command), ["echo cmd", "echo script"]);
});
test("recent is bounded and other filters preserve full data for paginated rendering", () => {
  const entries = commandHistory(Array.from({ length: 100 }, (_, index) => message(String(index), `echo ${index}`)));
  assert.equal(filterCommandHistory(entries, "recent").length, 8);
  assert.equal(filterCommandHistory(entries, "all").length, 100);
  assert.equal(COMMAND_PAGE_SIZE, 40);
  assert.equal(entries.length, 100);
});
