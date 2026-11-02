import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { TurnStatsLookup } from "../chat/turn-file-stats.ts";
const globals = globalThis as Record<string, unknown>;
globals.customElements ??= { define() {}, get() { return undefined; } };
globals.window ??= { document: { nodeType: 9, currentScript: null, createElement: () => ({}) }, Element: class {} };
const { OcSessionChangeSummary } = await import("./oc-session-change-summary.ts");

function summary(): any {
  const component = new OcSessionChangeSummary();
  component.requestUpdate = () => {};
  return component;
}
function update(component: any, keys = ["files", "statsLoader"]) {
  component.willUpdate(new Map(keys.map(key => [key, undefined])));
}
const stats = (additions: number): TurnStatsLookup => ({ byPath: { "a.ts": { path: "a.ts", additions, deletions: 0 } }, complete: true });
async function settle() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }

test("60 equal-content renders issue one in-flight Git request", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const component = summary();
  let calls = 0;
  let resolve!: (lookup: TurnStatsLookup) => void;
  const historyMessage = { role: "user", content: "same history" };
  const toolMessage = { role: "assistant", content: "same tool" };
  try {
    for (let i = 0; i < 60; i += 1) {
      component.files = [{ path: "a.ts", kind: "modified" }];
      component.statsLoader = () => { calls += 1; return new Promise<TurnStatsLookup>(done => { resolve = done; }); };
      component.historyRevision = [historyMessage];
      component.changeRevision = [toolMessage];
      update(component, ["files", "statsLoader", "historyRevision", "changeRevision"]);
      mock.timers.tick(250);
    }
    assert.equal(calls, 1);
    resolve(stats(1));
    await settle();
    assert.equal(component.added, 1);
    mock.timers.tick(250);
    assert.equal(calls, 1, "equal history projections must not enqueue a trailing refresh");
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});

test("same-path edits and run completion coalesce behind an active request", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const component = summary();
  let calls = 0;
  const resolvers: Array<(lookup: TurnStatsLookup) => void> = [];
  try {
    component.files = [{ path: "a.ts", kind: "modified" }];
    component.runId = "run-a";
    component.statsLoader = () => { calls += 1; return new Promise<TurnStatsLookup>(resolve => resolvers.push(resolve)); };
    update(component, ["files", "statsLoader", "runId"]);
    mock.timers.tick(250);
    component.changeRevision = [];
    update(component, ["changeRevision"]);
    component.runId = null;
    update(component, ["runId"]);
    mock.timers.tick(250);
    assert.equal(calls, 1, "only one request may be active");
    resolvers[0]!(stats(1));
    await settle();
    mock.timers.tick(250);
    assert.equal(calls, 2, "latest edit/run completion must refresh even with the same paths");
    resolvers[1]!(stats(10));
    await settle();
    assert.equal(component.added, 10);
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});

test("new file signature refreshes and failures remain retryable", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const component = summary();
  let calls = 0;
  try {
    component.files = [{ path: "a.ts", kind: "modified" }];
    component.statsLoader = async () => { calls += 1; if (calls === 1) throw new Error("temporary"); return stats(10); };
    update(component);
    mock.timers.tick(250);
    await settle();
    mock.timers.tick(1500);
    component.statsLoader = component.statsLoader.bind(null);
    update(component);
    mock.timers.tick(250);
    await settle();
    assert.equal(calls, 2);
    assert.equal(component.added, 10);
    component.files = [{ path: "a.ts", kind: "modified" }, { path: "b.ts", kind: "added" }];
    update(component, ["files"]);
    mock.timers.tick(250);
    await settle();
    assert.equal(calls, 3);
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});

test("a loader becoming available refreshes an unchanged file signature", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const component = summary();
  try {
    component.files = [{ path: "a.ts", kind: "modified" }];
    update(component, ["files"]); mock.timers.tick(250); await settle();
    component.statsLoader = async () => stats(10);
    update(component, ["statsLoader"]); mock.timers.tick(250); await settle();
    assert.equal(component.added, 10);
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});

test("same-path tool updates refresh independently of run completion", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const component = summary();
  let additions = 1;
  try {
    component.files = [{ path: "a.ts", kind: "modified" }];
    component.changeRevision = [{ toolCallId: "write-1" }];
    component.statsLoader = async () => stats(additions);
    update(component, ["files", "statsLoader", "changeRevision"]); mock.timers.tick(250); await settle();
    assert.equal(component.added, 1);
    additions = 10;
    component.changeRevision = [{ toolCallId: "write-2" }];
    update(component, ["changeRevision"]); mock.timers.tick(250); await settle();
    assert.equal(component.added, 10);
    additions = 20;
    component.runId = "next-run";
    update(component, ["runId"]); mock.timers.tick(250); await settle();
    component.runId = null;
    additions = 30;
    update(component, ["runId"]); mock.timers.tick(250); await settle();
    assert.equal(component.added, 30);
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});
