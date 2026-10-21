import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildTurnStatsLookup,
  fetchTurnFileStats,
  summarizeTurnStats,
  turnStatsSignature,
  type TurnStatsBridgeResponse,
} from "./turn-file-stats.ts";
import type { FileChange } from "./file-changes.ts";

function file(path: string, kind: FileChange["kind"] = "modified"): FileChange {
  return { path, kind };
}

// ── 签名 ───────────────────────────────────────────────────────────

test("签名：工作区 + 路径列表决定缓存键", () => {
  const a = turnStatsSignature("/ws", ["src/a.ts", "src/b.ts"]);
  assert.equal(a, turnStatsSignature("/ws", ["src/a.ts", "src/b.ts"]));
  assert.notEqual(a, turnStatsSignature("/ws", ["src/b.ts", "src/a.ts"]));
  assert.notEqual(a, turnStatsSignature("/other", ["src/a.ts", "src/b.ts"]));
  assert.notEqual(a, turnStatsSignature("/ws", ["src/a.ts"]));
});

// ── 响应整形 ───────────────────────────────────────────────────────

test("整形：合法 stats 建路径索引，binary 标记保留", () => {
  const lookup = buildTurnStatsLookup(
    [
      { path: "src/a.ts", additions: 7, deletions: 2 },
      { path: "logo.png", additions: 0, deletions: 0, binary: true },
      { path: "bad", additions: -3, deletions: "9" },
    ],
    ["src/a.ts", "logo.png", "bad"],
    false,
  );
  assert.deepEqual(lookup.byPath["src/a.ts"], { path: "src/a.ts", additions: 7, deletions: 2 });
  assert.deepEqual(lookup.byPath["logo.png"], {
    path: "logo.png",
    additions: 0,
    deletions: 0,
    binary: true,
  });
  // 非法数字按 0 处理，避免 NaN 破坏汇总
  assert.deepEqual(lookup.byPath["bad"], { path: "bad", additions: 0, deletions: 0 });
  assert.equal(lookup.complete, true);
});

test("整形：未知/畸形行跳过，不产生幽灵统计", () => {
  const lookup = buildTurnStatsLookup(
    [null, "x", { path: "" }, { path: 42 }, { additions: 3 }],
    ["src/a.ts"],
    false,
  );
  assert.deepEqual(lookup.byPath, {});
  assert.equal(lookup.complete, false);
});

test("整形：有文件缺行数 / truncated / 空路径列表 → 行数不可用", () => {
  const stats = [{ path: "src/a.ts", additions: 3, deletions: 1 }];
  assert.equal(buildTurnStatsLookup(stats, ["src/a.ts"]).complete, true);
  assert.equal(buildTurnStatsLookup(stats, ["src/a.ts", "src/b.ts"]).complete, false);
  assert.equal(buildTurnStatsLookup(stats, ["src/a.ts"], true).complete, false);
  assert.equal(buildTurnStatsLookup(stats, []).complete, false);
  assert.equal(buildTurnStatsLookup(undefined, ["src/a.ts"]).complete, false);
});

// ── 拉取 ───────────────────────────────────────────────────────────

test("拉取：成功响应 → 全匹配的行数可用", async () => {
  const calls: Array<{ cwd: string; paths: string[] }> = [];
  const fetchStats = async (cwd: string, paths: string[]): Promise<TurnStatsBridgeResponse> => {
    calls.push({ cwd, paths });
    return {
      success: true,
      data: {
        stats: [
          { path: "src/a.ts", additions: 10, deletions: 4 },
          { path: "new.txt", additions: 3, deletions: 0 },
        ],
      },
    };
  };
  const lookup = await fetchTurnFileStats(fetchStats, "/ws", ["src/a.ts", "new.txt"]);
  assert.deepEqual(calls, [{ cwd: "/ws", paths: ["src/a.ts", "new.txt"] }]);
  assert.equal(lookup.complete, true);
  assert.equal(lookup.byPath["new.txt"]?.additions, 3);
});

test("拉取：失败 / 抛错 / 无桥接 / 无工作区 → 静默降级为空结果", async () => {
  const failing = async (): Promise<TurnStatsBridgeResponse> => ({
    success: false,
    error: "git-error",
  });
  const throwing = async (): Promise<TurnStatsBridgeResponse> => {
    throw new Error("boom");
  };
  for (const fetcher of [failing, throwing]) {
    const lookup = await fetchTurnFileStats(fetcher, "/ws", ["src/a.ts"]);
    assert.deepEqual(lookup, { byPath: {}, complete: false });
  }
  assert.deepEqual(await fetchTurnFileStats(undefined, "/ws", ["src/a.ts"]), {
    byPath: {},
    complete: false,
  });
  assert.deepEqual(await fetchTurnFileStats(failing, "", ["src/a.ts"]), {
    byPath: {},
    complete: false,
  });
});

test("拉取：truncated 响应 → 行数不可用（退回文件数）", async () => {
  const fetcher = async (): Promise<TurnStatsBridgeResponse> => ({
    success: true,
    data: { stats: [{ path: "src/a.ts", additions: 5, deletions: 0 }], truncated: true },
  });
  const lookup = await fetchTurnFileStats(fetcher, "/ws", ["src/a.ts"]);
  assert.equal(lookup.complete, false);
});

// ── 汇总 ───────────────────────────────────────────────────────────

test("汇总：行数可用时把各文件 +/− 相加（二进制计 0）", () => {
  const files = [file("src/a.ts"), file("new.txt", "added"), file("logo.png", "added")];
  const lookup = buildTurnStatsLookup(
    [
      { path: "src/a.ts", additions: 7, deletions: 2 },
      { path: "new.txt", additions: 90, deletions: 0 },
      { path: "logo.png", additions: 0, deletions: 0, binary: true },
    ],
    ["src/a.ts", "new.txt", "logo.png"],
  );
  const summary = summarizeTurnStats(files, lookup);
  assert.deepEqual(summary, {
    lineStatsAvailable: true,
    additions: 97,
    deletions: 2,
    addedFiles: 2,
    deletedFiles: 0,
  });
});

test("汇总：行数不可用时退回新增/删除文件数", () => {
  const files = [
    file("src/a.ts", "modified"),
    file("new.txt", "added"),
    file("gone.txt", "deleted"),
  ];
  const summary = summarizeTurnStats(files, { byPath: {}, complete: false });
  assert.deepEqual(summary, {
    lineStatsAvailable: false,
    additions: 0,
    deletions: 0,
    addedFiles: 1,
    deletedFiles: 1,
  });
});

test("汇总：空列表不宣称行数可用", () => {
  assert.equal(summarizeTurnStats([], { byPath: {}, complete: true }).lineStatsAvailable, false);
});

// ── DOM / 接线守护（源码审计，与 workspace-ui.test.ts 同模式） ─────

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("组件：胶囊无左右图标、含绿色 +N / 红色 −M 统计节点", () => {
  const src = source("../../../../../src/ui/components/oc-turn-files.ts");
  const summary = src.slice(src.indexOf("<summary"), src.indexOf("</summary>"));
  assert.match(summary, /class="chat-turn-files__stat chat-turn-files__stat--added"/);
  assert.match(summary, /class="chat-turn-files__stat chat-turn-files__stat--deleted"/);
  // 去掉左右两个图标：summary 内不得再出现 icons.*
  assert.doesNotMatch(summary, /\$\{icons\./);
  assert.doesNotMatch(src, /chevronDown/);
  // 浮层每行保留 文件名(basename) + 行内 +/−（二进制不显示数字）；badge 已移除
  assert.match(src, /chat-turn-files__row-stat/);
  assert.match(src, /fileChangeBaseName\(file\.path\)/);
  assert.match(src, /chat\.fileChange\.linesUnavailable/);
  assert.doesNotMatch(src, /chat-file-change__badge/, "浮层 badge 应已移除");
});

test("组件：runActive 门控（终态后胶囊消失，由组底部卡片接力）", () => {
  const src = source("../../../../../src/ui/components/oc-turn-files.ts");
  assert.match(src, /runActive: \{ attribute: false \}/, "应声明 runActive 属性");
  assert.match(src, /if \(!this\.runActive\) return nothing;/, "runActive=false 应渲染 nothing");
});

test("组件：按 workspacePath + 消息变化防抖拉取，过期响应丢弃", () => {
  const src = source("../../../../../src/ui/components/oc-turn-files.ts");
  assert.match(src, /gitChangeStats/);
  assert.match(src, /STATS_DEBOUNCE_MS = 250/);
  assert.match(src, /signature !== this\.statsSignature/);
  assert.match(src, /this\.statsCache/);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{3}){1,2}\b/, "渲染层不得硬编码 hex");
});

test("接线：views/chat.ts 向 oc-turn-files 透传 workspacePath，向 oc-chat-history 透传卡片链路", () => {
  const src = source("../../../../../src/ui/views/chat.ts");
  assert.match(src, /\.workspacePath=\$\{props\.workspacePath \?\? ""\}/);
  assert.match(src, /\.runActive=\$\{isBusy\}/, "胶囊与历史卡片都应以 isBusy 做执行中门控");
  assert.match(src, /\.onDiscard=\$\{/, "历史组件缺少 onDiscard（卡片撤销回调）");
});

// ── 与任务进度卡的堆叠顺序 / 层级 ─────────────────────────────────

test("堆叠顺序：胶囊在任务进度卡上方，进度卡贴近输入框", () => {
  const src = source("../../../../../src/ui/views/chat.ts");
  const turnIdx = src.indexOf("<oc-turn-files");
  const cardIdx = src.indexOf("renderProgressCard(");
  const composeIdx = src.indexOf("renderCompose(props");
  assert.ok(turnIdx > 0, "views/chat.ts 应装配 <oc-turn-files>");
  assert.ok(cardIdx > turnIdx, "任务进度卡应在胶囊之后（DOM 靠下 = 更靠近输入框）");
  assert.ok(composeIdx > cardIdx, "输入框应在进度卡之后（进度卡是最贴近输入框的浮卡）");
});

function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `缺少选择器：${selector}`);
  const end = css.indexOf("}", start);
  assert.ok(end > start, `${selector} 规则缺少收尾`);
  return css.slice(start, end);
}

function zIndexIn(css: string, selector: string): number {
  const match = /z-index:\s*(-?\d+)/.exec(ruleBlock(css, selector));
  return match ? Number(match[1]) : Number.NaN;
}

test("层级：胶囊宿主去掉 stacking context，浮层落消息内容层且低于其他浮层/模态", () => {
  const css = source("../../../../../src/styles/chat.css");
  // 宿主不再建 stacking context（原 z-index:20），只保留居中列
  const host = ruleBlock(css, "oc-turn-files {");
  assert.doesNotMatch(host, /z-index/, "oc-turn-files 宿主不应再有 z-index");
  assert.doesNotMatch(host, /position:/, "oc-turn-files 宿主不需要定位/stacking context");
  assert.match(host, /max-width:var\(--chat-column\)/, "宿主应与进度卡/输入卡同用 --chat-column");
  // 胶囊本体（details）同样不抬层
  assert.doesNotMatch(ruleBlock(css, ".chat-turn-files {"), /z-index/);
  // 浮层=消息内容层：高于消息操作按钮（2），低于对话信息浮层（35）、菜单与模态
  const popoverZ = zIndexIn(css, ".chat-turn-files__popover {");
  assert.equal(popoverZ, 5);
  assert.ok(popoverZ > zIndexIn(css, ".chat-message-actions > * {"), "浮层需高于消息操作按钮");
  assert.ok(popoverZ < zIndexIn(css, ".chat-conversation-info {"), "浮层需低于对话信息浮层");
  const tokens = source("../../../../../src/styles/tokens-ext.css");
  const dialogZ = Number(/--z-dialog:\s*(\d+)/.exec(tokens)?.[1] ?? NaN);
  const toastZ = Number(/--z-toast:\s*(\d+)/.exec(tokens)?.[1] ?? NaN);
  assert.ok(popoverZ < dialogZ, "浮层需低于模态遮罩");
  assert.ok(popoverZ < toastZ, "浮层需低于 toast");
  const settingsCss = source("../../../../../src/styles/settings.css");
  assert.ok(popoverZ < zIndexIn(settingsCss, ".theme-editor {"), "浮层需低于主题编辑器");
});

test("宽度节奏：胶囊与任务进度卡同用 --chat-column 居中列（窄窗自适应无重叠）", () => {
  const css = source("../../../../../src/styles/chat.css");
  const progress = ruleBlock(css, ".chat-progress-card {");
  assert.match(progress, /width:\s*100%/, "进度卡应占满可用宽度");
  assert.match(progress, /max-width:\s*var\(--chat-column\)/, "进度卡应与输入卡同列");
  assert.match(progress, /margin-left:\s*auto/);
  assert.match(progress, /margin-right:\s*auto/);
  const turnHost = ruleBlock(css, "oc-turn-files {");
  assert.match(turnHost, /max-width:var\(--chat-column\)/);
  assert.match(turnHost, /margin:0 auto/);
});

test("样式：胶囊居中 + 统计色走语义 token（无硬编码 hex）", () => {
  const css = source("../../../../../src/styles/chat.css");
  assert.match(css, /\.chat-turn-files \{ position:relative; width:fit-content; margin:0 auto var\(--spacer-8\);/);
  assert.match(css, /\.chat-turn-files__stat--added \{ color:var\(--ok\); \}/);
  assert.match(css, /\.chat-turn-files__stat--deleted \{ color:var\(--destructive\); \}/);
  const block = css.slice(css.indexOf(".chat-turn-files__stat {"), css.indexOf(".chat-turn-files__popover {"));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}/, "统计样式不得硬编码 hex");
});
