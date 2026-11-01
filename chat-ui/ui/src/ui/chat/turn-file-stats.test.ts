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

test("签名：工作区 + 路径列表决定缓存键", () => {
  const a = turnStatsSignature("/ws", ["src/a.ts", "src/b.ts"]);
  assert.equal(a, turnStatsSignature("/ws", ["src/a.ts", "src/b.ts"]));
  assert.notEqual(a, turnStatsSignature("/ws", ["src/b.ts", "src/a.ts"]));
  assert.notEqual(a, turnStatsSignature("/other", ["src/a.ts", "src/b.ts"]));
  assert.notEqual(a, turnStatsSignature("/ws", ["src/a.ts"]));
});

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
  assert.deepEqual(lookup.byPath["logo.png"], { path: "logo.png", additions: 0, deletions: 0, binary: true });
  assert.deepEqual(lookup.byPath["bad"], { path: "bad", additions: 0, deletions: 0 });
  assert.equal(lookup.complete, true);
});

test("整形：未知/畸形行跳过，不产生幽灵统计", () => {
  const lookup = buildTurnStatsLookup([null, "x", { path: "" }, { path: 42 }, { additions: 3 }], ["src/a.ts"], false);
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

test("拉取：成功响应 → 全匹配的行数可用", async () => {
  const calls: Array<{ cwd: string; paths: string[] }> = [];
  const fetchStats = async (cwd: string, paths: string[]): Promise<TurnStatsBridgeResponse> => {
    calls.push({ cwd, paths });
    return { success: true, data: { stats: [
      { path: "src/a.ts", additions: 10, deletions: 4 },
      { path: "new.txt", additions: 3, deletions: 0 },
    ] } };
  };
  const lookup = await fetchTurnFileStats(fetchStats, "/ws", ["src/a.ts", "new.txt"]);
  assert.deepEqual(calls, [{ cwd: "/ws", paths: ["src/a.ts", "new.txt"] }]);
  assert.equal(lookup.complete, true);
  assert.equal(lookup.byPath["new.txt"]?.additions, 3);
});

test("拉取：失败 / 抛错 / 无桥接 / 无工作区 → 静默降级为空结果", async () => {
  const failing = async (): Promise<TurnStatsBridgeResponse> => ({ success: false, error: "git-error" });
  const throwing = async (): Promise<TurnStatsBridgeResponse> => { throw new Error("boom"); };
  for (const fetcher of [failing, throwing]) {
    assert.deepEqual(await fetchTurnFileStats(fetcher, "/ws", ["src/a.ts"]), { byPath: {}, complete: false });
  }
  assert.deepEqual(await fetchTurnFileStats(undefined, "/ws", ["src/a.ts"]), { byPath: {}, complete: false });
  assert.deepEqual(await fetchTurnFileStats(failing, "", ["src/a.ts"]), { byPath: {}, complete: false });
});

test("拉取：truncated 响应 → 行数不可用（退回文件数）", async () => {
  const fetcher = async (): Promise<TurnStatsBridgeResponse> => ({
    success: true,
    data: { stats: [{ path: "src/a.ts", additions: 5, deletions: 0 }], truncated: true },
  });
  assert.equal((await fetchTurnFileStats(fetcher, "/ws", ["src/a.ts"])).complete, false);
});

test("汇总：行数可用时把各文件 +/− 相加（二进制计 0）", () => {
  const files = [file("src/a.ts"), file("new.txt", "added"), file("logo.png", "added")];
  const lookup = buildTurnStatsLookup([
    { path: "src/a.ts", additions: 7, deletions: 2 },
    { path: "new.txt", additions: 90, deletions: 0 },
    { path: "logo.png", additions: 0, deletions: 0, binary: true },
  ], ["src/a.ts", "new.txt", "logo.png"]);
  assert.deepEqual(summarizeTurnStats(files, lookup), {
    lineStatsAvailable: true, additions: 97, deletions: 2, addedFiles: 2, deletedFiles: 0,
  });
});

test("汇总：行数不可用时退回新增/删除文件数", () => {
  const files = [file("src/a.ts", "modified"), file("new.txt", "added"), file("gone.txt", "deleted")];
  assert.deepEqual(summarizeTurnStats(files, { byPath: {}, complete: false }), {
    lineStatsAvailable: false, additions: 0, deletions: 0, addedFiles: 1, deletedFiles: 1,
  });
});

test("汇总：空列表不宣称行数可用", () => {
  assert.equal(summarizeTurnStats([], { byPath: {}, complete: true }).lineStatsAvailable, false);
});

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("当前接线：会话改动进入右侧 Dock 和终态卡片，不再渲染旧悬浮窗", () => {
  const chat = source("../../../../../src/ui/views/chat.ts");
  const props = source("../../../../../src/ui/app-chat-props.ts");
  const card = source("../../../../../src/ui/components/oc-turn-diff-card.ts");
  assert.match(chat, /<oc-context-dock/);
  assert.doesNotMatch(chat, /<oc-turn-files/);
  assert.match(props, /dockChangesContent: renderSessionChanges\(state\)/);
  assert.match(props, /fetchSessionChangeStats\(state, files\)/);
  assert.match(card, /chat\.fileChange\.addedLines/);
  assert.match(card, /chat\.fileChange\.deletedLines/);
});
