import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const globals = globalThis as Record<string, unknown>;
globals.customElements ??= { define() {}, get() { return undefined; } };
globals.window ??= { document: { nodeType: 9, currentScript: null, createElement: () => ({}) }, Element: class {} };
const { OcCommandJobs } = await import("./oc-command-jobs.ts");

test("visual property gate admits locale/messages/filter, not unrelated draft renders", () => {
  const host = { hasUpdated: true } as unknown as InstanceType<typeof OcCommandJobs>;
  for (const key of ["messages", "sessionKey", "locale", "filter", "limit"]) {
    assert.equal(OcCommandJobs.prototype.shouldUpdate.call(host, new Map([[key, undefined]])), true);
  }
  assert.equal(OcCommandJobs.prototype.shouldUpdate.call(host, new Map([["draft", ""]])), false);
});
test("projection is reused for locale/filter changes, rebuilt for a new message array", () => {
  const host = { messages: [], querySelectorAll: () => [] } as unknown as InstanceType<typeof OcCommandJobs>;
  const state = host as unknown as Record<string, unknown>;
  OcCommandJobs.prototype.willUpdate.call(host, new Map([["messages", undefined]]));
  const first = state.entries;
  OcCommandJobs.prototype.willUpdate.call(host, new Map([["locale", "zh"]]));
  assert.equal(state.entries, first);
  host.messages = [{ content: [{ type: "toolCall", name: "exec", arguments: { command: "pwd" } }] }];
  OcCommandJobs.prototype.willUpdate.call(host, new Map([["messages", []]]));
  assert.notEqual(state.entries, first);
  assert.equal((state.entries as unknown[]).length, 1);
});
test("session switch resets filter/page and closes native disclosures", () => {
  const details = { open: true };
  const host = { messages: [], filter: "all", limit: 120, querySelectorAll: () => [details] } as unknown as InstanceType<typeof OcCommandJobs>;
  OcCommandJobs.prototype.willUpdate.call(host, new Map([["sessionKey", "previous"]]));
  const state = host as unknown as Record<string, unknown>;
  assert.equal(state.filter, "recent");
  assert.equal(state.limit, 40);
  assert.equal(details.open, false);
});
test("rendering uses stable keyed pages, bounded strings and exact source copy without RPC", () => {
  const src = readFileSync(new URL("../../../../../src/ui/components/oc-command-jobs.ts", import.meta.url), "utf8");
  assert.ok(src.includes("repeat(shown, entry => entry.key"));
  assert.ok(src.includes("filtered.slice(0, this.limit)"));
  assert.ok(src.includes("visibleToolCode(entry.command)"));
  assert.ok(src.includes("visibleToolCode(entry.output)"));
  assert.ok(src.includes("entry.command.slice(0, 160)"));
  assert.ok(src.includes("clipboard.writeText(entry.command)"));
  assert.ok(src.includes('t("chat.commandRunning")'));
  assert.ok(!src.includes(".request("));
});
