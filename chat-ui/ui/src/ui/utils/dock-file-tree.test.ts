import test from "node:test";
import assert from "node:assert/strict";
import {DockFileTree, dockRelativePath} from "./dock-file-tree.ts";

test("dock tree only admits direct children inside its authorized root", async () => {
  assert.equal(dockRelativePath("C:\\work", "c:\\work\\docs\\a.md"), "docs/a.md");
  assert.equal(dockRelativePath("/work", "/work-other/a"), null);
  assert.equal(dockRelativePath("/work", "/work/../private/a"), null);
  const tree = new DockFileTree(async () => ({items: [
    {name: "docs", path: "/work/docs", isDir: true},
    {name: "private", path: "/private", isDir: true},
    {name: "nested", path: "/work/docs/nested", isDir: false},
  ]}));
  tree.configure("/work", false);
  await tree.load("/work");
  assert.deepEqual(tree.directories.get("/work")?.items.map(item => item.name), ["docs"]);
});

test("root changes and cancellation reject late directory responses", async () => {
  let finish!: (value: {items: {name: string; path: string; isDir: boolean}[]}) => void;
  const tree = new DockFileTree(() => new Promise(resolve => { finish = resolve; }));
  tree.configure("/old", false);
  const pending = tree.load("/old");
  tree.configure("/new", false);
  finish({items: [{name: "old", path: "/old/old", isDir: false}]});
  await pending;
  assert.equal(tree.directories.has("/old"), false);
  const next = tree.load("/new");
  tree.cancel();
  finish({items: [{name: "late", path: "/new/late", isDir: false}]});
  await next;
  assert.equal(tree.directories.get("/new")?.items.length ?? 0, 0);
});

test("requests coalesce, hidden changes reset state, and nodes and depth remain bounded", async () => {
  const calls: string[] = [];
  const tree = new DockFileTree(async (path, showHidden) => {
    calls.push(`${path}:${showHidden}`);
    return {items: [0, 1, 2, 3].map(index => ({name: `d${index}`, path: `${path}/d${index}`, isDir: true}))};
  }, () => {}, {maxNodes: 5, maxDepth: 1});
  tree.configure("/work", false);
  await Promise.all([tree.load("/work"), tree.load("/work")]);
  assert.equal(calls.length, 1);
  await tree.load("/work/d0");
  assert.equal(calls.length, 1);
  assert.equal(tree.canExpand("/work/d0"), false);
  tree.configure("/work", true);
  await tree.load("/work");
  assert.deepEqual(calls, ["/work:false", "/work:true"]);
  const bounded = new DockFileTree(async path => ({items: [0, 1, 2, 3].map(index => ({name: `d${index}`, path: `${path}/d${index}`, isDir: true}))}), () => {}, {maxNodes: 5});
  bounded.configure("/work", false);
  await bounded.load("/work");
  await bounded.load("/work/d0");
  assert.equal(bounded.directories.get("/work/d0")?.items.length, 1);
  assert.equal(bounded.directories.get("/work/d0")?.truncated, true);
});

test("directories remain lazy, failed requests retry, and refresh rejects an older result", async () => {
  let calls = 0;
  let fail = true;
  const tree = new DockFileTree(async path => {
    calls++;
    if (fail) throw Error("/outside/private/error");
    return {items: [{name: "child", path: `${path}/child`, isDir: true}]};
  });
  tree.configure("/root", false);
  await tree.load("/root");
  assert.equal(tree.directories.get("/root")?.error, "unavailable", "native error paths are not displayed");
  fail = false;
  await tree.load("/root");
  assert.equal(calls, 2);
  assert.equal(tree.directories.has("/root/child"), false, "listing a root cannot preload its directories");
  await tree.load("/root");
  assert.equal(calls, 2, "the component does not poll a loaded snapshot");
  await tree.load("/outside");
  assert.equal(calls, 2, "no out-of-root directory request reaches the bridge");

  const finishes: Array<(value: {items: []}) => void> = [];
  const delayed = new DockFileTree(() => new Promise(resolve => finishes.push(resolve)));
  delayed.configure("/root", false);
  const older = delayed.load("/root");
  delayed.configure("/root", false, true);
  const newer = delayed.load("/root");
  finishes[1]({items: []});
  await newer;
  const snapshot = delayed.directories.get("/root");
  finishes[0]({items: []});
  await older;
  assert.equal(delayed.directories.get("/root"), snapshot);
  assert.equal(snapshot?.loaded, true);
});

test("hidden names follow the current preference and untrusted labels never expose outside paths", async () => {
  const tree = new DockFileTree(async () => ({items: [
    {name: ".env", path: "/root/.env", isDir: false},
    {name: "/outside/private", path: "/root/public.md", isDir: false},
  ]}));
  tree.configure("/root", false);
  await tree.load("/root");
  assert.deepEqual(tree.directories.get("/root")?.items.map(item => item.name), ["public.md"]);
  tree.configure("/root", true);
  await tree.load("/root");
  assert.deepEqual(tree.directories.get("/root")?.items.map(item => item.name).sort(), [".env", "public.md"]);
});
