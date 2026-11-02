// 守护回归（源码审计）：终态改动卡片与 Dock 共用 oc-turn-diff-card，
// 结构、降级、折叠、事件委托复用等不变量钉在这里。组件依赖 lit + customElements，
// node 下直接导入意义不大，故读源断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
const globals = globalThis as Record<string, unknown>;
globals.customElements ??= { define() {}, get() { return undefined; } };
globals.window ??= { document: { nodeType: 9, currentScript: null, createElement: () => ({}) }, Element: class {} };
const { OcTurnDiffCard } = await import("./oc-turn-diff-card.ts");
const { nothing } = await import("lit");

async function settleStats() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
function card(workspace: string): any {
  const component = new OcTurnDiffCard();
  component.requestUpdate = () => {};
  component.workspacePath = workspace;
  component.gitAvailable = true;
  component.files = [{ path: "a.ts", kind: "modified" }];
  return component;
}
function refreshCard(component: any) { component.willUpdate(new Map([["files", undefined]])); }

test("same paths refresh after the short cache lifetime, including a remounted card", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const component = card("ttl-fixture");
  let calls = 0;
  component.statsLoader = async () => ({ byPath: { "a.ts": { path: "a.ts", additions: ++calls === 1 ? 1 : 10, deletions: 0 } }, complete: true });
  let remounted: any;
  try {
    refreshCard(component); mock.timers.tick(250); await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 1);
    mock.timers.tick(1500);
    refreshCard(component); mock.timers.tick(250); await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 10);
    mock.timers.tick(1500);
    remounted = card("ttl-fixture");
    remounted.statsLoader = component.statsLoader;
    refreshCard(remounted); mock.timers.tick(250); await settleStats();
    assert.equal(calls, 3, "remount must not reuse an expired module cache entry");
  } finally { component.disconnectedCallback(); remounted?.disconnectedCallback(); mock.timers.reset(); }
});

test("failed stats retry and undo invalidates same-path stats immediately", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const component = card("retry-fixture");
  let calls = 0;
  component.statsLoader = async () => {
    calls += 1;
    if (calls === 1) return { byPath: {}, complete: false };
    return { byPath: { "a.ts": { path: "a.ts", additions: calls === 2 ? 10 : 0, deletions: 0 } }, complete: true };
  };
  component.onDiscard = async () => {};
  try {
    refreshCard(component); mock.timers.tick(250); await settleStats();
    assert.equal(component.statsLookup.complete, false);
    mock.timers.tick(1500);
    refreshCard(component); mock.timers.tick(250); await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 10);
    await component.onUndoClick();
    mock.timers.tick(250); await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 0);
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});

test("same-path edit inside the cache window revalidates when that window expires", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const component = card("within-ttl-fixture");
  let additions = 1;
  component.statsLoader = async () => ({ byPath: { "a.ts": { path: "a.ts", additions, deletions: 0 } }, complete: true });
  try {
    refreshCard(component); mock.timers.tick(250); await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 1);
    additions = 10;
    component.files = [{ path: "a.ts", kind: "modified" }];
    refreshCard(component);
    mock.timers.tick(1000);
    mock.timers.tick(250);
    await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 10);
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});

test("same-path edits during a pending stats request queue one follow-up without another render", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const component = card("edit-inflight-fixture");
  let calls = 0;
  let resolveOld!: (lookup: unknown) => void;
  component.statsLoader = () => {
    calls += 1;
    return calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) :
      Promise.resolve({ byPath: { "a.ts": { path: "a.ts", additions: 10, deletions: 0 } }, complete: true });
  };
  try {
    refreshCard(component); mock.timers.tick(250);
    for (let i = 0; i < 60; i += 1) {
      component.files = [{ path: "a.ts", kind: "modified" }];
      refreshCard(component);
    }
    assert.equal(calls, 1);
    resolveOld({ byPath: { "a.ts": { path: "a.ts", additions: 1, deletions: 0 } }, complete: true });
    await settleStats();
    mock.timers.tick(15000); await settleStats();
    assert.equal(calls, 2, "updates during the active request must coalesce into one trailing request");
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 10);
  } finally { component.disconnectedCallback(); mock.timers.reset(); }
});

test("a stale request cannot block revalidation after switching to cached workspace stats", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const seed = card("cached-target-fixture");
  const component = card("pending-source-fixture");
  let resolveOld!: (lookup: unknown) => void;
  try {
    seed.statsLoader = async () => ({ byPath: { "a.ts": { path: "a.ts", additions: 1, deletions: 0 } }, complete: true });
    refreshCard(seed); mock.timers.tick(250); await settleStats();
    component.statsLoader = () => new Promise(resolve => { resolveOld = resolve; });
    refreshCard(component); mock.timers.tick(250);
    component.workspacePath = "cached-target-fixture";
    component.statsLoader = async () => ({ byPath: { "a.ts": { path: "a.ts", additions: 10, deletions: 0 } }, complete: true });
    refreshCard(component);
    mock.timers.tick(1000); mock.timers.tick(250); await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 10);
    resolveOld({ byPath: { "a.ts": { path: "a.ts", additions: 99, deletions: 0 } }, complete: true });
    await settleStats();
    assert.equal(component.statsLookup.byPath["a.ts"].additions, 10, "old workspace stats must not replace current stats");
  } finally { seed.disconnectedCallback(); component.disconnectedCallback(); mock.timers.reset(); }
});

const src = readFileSync(
  new URL("../../../../../src/ui/components/oc-turn-diff-card.ts", import.meta.url),
  "utf8",
);

test("diff-card：无 shadow DOM + 注册为 oc-turn-diff-card", () => {
  assert.match(src, /createRenderRoot\(\)\s*\{\s*return this;/, "必须复用全局样式与线程事件委托");
  assert.match(src, /customElement\("oc-turn-diff-card"\)/, "必须以 oc-turn-diff-card 标签名注册");
});

test("diff-card：历史空文件列表不渲染卡片；Dock 保留工具栏；统计防抖缓存与过期丢弃", () => {
  const empty = new OcTurnDiffCard();
  assert.equal(empty.render(), nothing, "历史空文件列表不应渲染卡片");
  empty.dockMode = true;
  assert.notEqual(empty.render(), nothing, "Dock 空列表保留真实分支及视图工具栏");
  assert.match(src, /STATS_DEBOUNCE_MS = 250/, "统计拉取应 250ms 防抖");
  assert.match(src, /turnStatsSignature\(this\.workspacePath, paths\)/, "应按签名缓存");
  assert.match(src, /seq !== this\.statsSeq \|\| signature !== this\.statsSignature/, "过期响应应丢弃");
  // 统计不可用时不打 git：无工作区 / 无 git / 空文件列表直接空结果
  assert.match(src, /fetchTurnFileStats\(\s*statsBridge\(\)\?\.gitChangeStats,/, "应复用 turn-file-stats 拉取通道");
});

test("diff-card：头部「已编辑 N 个文件」+ 总 +x −y，行数不可用时降级文件数", () => {
  assert.match(src, /t\("chat\.editedFiles"\)\.replace\("\{n\}", String\(files\.length\)\)/);
  assert.match(src, /chat-turn-files__stat chat-turn-files__stat--added/, "总增行数复用胶囊统计配色类");
  assert.match(src, /chat-turn-files__stat chat-turn-files__stat--deleted/);
  assert.match(src, /lineStats \? summary\.additions : summary\.addedFiles/, "行数不可用时降级新增文件数");
  assert.match(src, /chat\.fileChange\.linesUnavailable/, "降级时 title 须说明原因");
});

test("diff-card：操作按钮仅 git 可用时渲染（撤销回调 + 查看变更委托）", () => {
  assert.match(src, /this\.gitAvailable[\s\S]*?chat\.undoChanges[\s\S]*?chat\.viewChanges/, "撤销/查看变更应在 git 可用分支内");
  assert.match(src, /this\.onDiscard\(this\.files\)/, "撤销应携带本组 files 调回调");
  assert.match(src, /\?disabled=\$\{this\.undoing\}/, "撤销在途应禁用按钮（busy 惯例）");
  assert.match(src, /class="chat-git-view-link" tabindex="0" role="button"/, "查看变更应复用线程委托链接结构");
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{3}){1,2}\b/, "渲染层不得硬编码 hex");
});

test("diff-card：文件行 basename + 完整路径 title + 每文件 +/−；超出折叠「再显示 N 个」", () => {
  assert.match(src, /fileChangeBaseName\(file\.path\)/, "文件行应显示 basename");
  assert.match(src, /data-path=\$\{file\.path\}[\s\S]{0,80}title=\$\{file\.path\}/, "完整路径放 title + data-path（线程委托打开）");
  assert.match(src, /class="chat-path-link chat-turn-diff-card__path"/, "路径点击应复用 .chat-path-link 委托");
  assert.match(src, /files\.slice\(0, COLLAPSED_FILE_ROWS\)/, "默认只显示前 3 个文件");
  assert.match(src, /t\("chat\.showMoreFiles"\)\.replace\("\{n\}", String\(hiddenCount\)\)/, "超出行应可展开");
  // 二进制/无统计文件不显示行内数字（沿用胶囊语义）
  assert.match(src, /if \(!stat \|\| stat\.binary\) return nothing;/);
});

test("diff-card：shouldUpdate 放行视觉属性、拦回调新闭包", () => {
  assert.match(src, /shouldUpdate\(changed[^)]*\)[\s\S]{0,120}key !== "onDiscard"/, "回调属性不得触发重渲染");
});
