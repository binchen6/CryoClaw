// memory-workspace.test.ts — 记忆工作区纯函数（解析 / 手术 / CLI JSON 提取）
import { test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseMemorySections, listWorkspaceMemory, readWorkspaceMemoryEntry, appendMemorySection,
  parseDreamEntries, removeDreamEntry, deleteDreamEntryFile,
  extractCliJson, buildMemoryCliArgs, coerceRecallPayload, coerceIndexStatus,
} from "./memory-workspace";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-memws-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ── MEMORY.md 章节 ── */

test("parseMemorySections 按 ##/### 切分，导语单独成节（无标题）", () => {
  const md = `# MEMORY.md — 长期记忆\n\n> 说明文字\n\n## Active Projects\n\n项目 A 内容。\n\n### 子项\n\n子项内容。\n\n## Lessons\n\n教训内容。`;
  const sections = parseMemorySections(md);
  expect(sections.map((s) => s.title)).toEqual([
    "", // 一级标题 + 引语归入导语节
    "Active Projects",
    "子项",
    "Lessons",
  ]);
  expect(sections[0].body).toContain("说明文字");
  expect(sections[1].body).toContain("项目 A 内容。");
});

test("parseMemorySections 空串返回空数组", () => {
  expect(parseMemorySections("")).toEqual([]);
});

test("listWorkspaceMemory 合并长期章节 + 每日日志，目录缺失不抛", () => {
  const list = listWorkspaceMemory(tmp);
  expect(list.hasLongTermFile).toBe(false);
  expect(list.entries).toEqual([]);

  fs.writeFileSync(path.join(tmp, "MEMORY.md"), "# T\n\n## A\n\n内容 A。", "utf-8");
  fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "memory", "2026-09-12.md"), "日志内容", "utf-8");
  fs.writeFileSync(path.join(tmp, "memory", ".dreams"), "隐藏", "utf-8"); // 非入口被过滤（无 .md 后缀）
  const list2 = listWorkspaceMemory(tmp);
  expect(list2.hasLongTermFile).toBe(true);
  expect(list2.longTermCount).toBe(2); // 导语节 + A 节
  expect(list2.dailyCount).toBe(1);
  const ids = list2.entries.map((e) => e.id);
  expect(ids).toContain("lt:0");
  expect(ids).toContain("daily:2026-09-12.md");
});

test("readWorkspaceMemoryEntry daily id 带路径穿越被拒绝", () => {
  fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "memory", "a.md"), "x", "utf-8");
  expect(readWorkspaceMemoryEntry(tmp, "daily:../openclaw.json")).toBeNull();
  expect(readWorkspaceMemoryEntry(tmp, "daily:a.md")?.content).toBe("x");
  expect(readWorkspaceMemoryEntry(tmp, "lt:0")).toBeNull();
});

test("appendMemorySection 追加章节 + 备份；文件不存在则创建", () => {
  appendMemorySection(tmp, "常用联系人", "微信优先");
  const md = fs.readFileSync(path.join(tmp, "MEMORY.md"), "utf-8");
  expect(md).toContain("## 常用联系人");
  expect(md).toContain("微信优先");
  appendMemorySection(tmp, "第二条", "内容 B");
  expect(fs.readFileSync(path.join(tmp, "MEMORY.md"), "utf-8")).toContain("## 第二条");
  expect(fs.existsSync(path.join(tmp, "MEMORY.md.bak"))).toBe(true);
});

/* ── DREAMS.md ── */

const DREAMS = `# Dream Diary

<!-- openclaw:dreaming:diary:start -->
---

*September 6, 2026 at 12:13 PM GMT+8*

第一夜梦境。

---

*September 7, 2026 at 7:45 AM GMT+8*

第二夜梦境。

<!-- openclaw:dreaming:diary:end -->
`;

test("parseDreamEntries 最新在前，日期可解析", () => {
  const entries = parseDreamEntries(DREAMS);
  expect(entries).toHaveLength(2);
  expect(entries[0].index).toBe(0);
  expect(entries[0].body).toContain("第二夜梦境。");
  expect(entries[0].dateMs).not.toBeNull();
  expect(entries[1].dateText).toContain("September 6");
});

test("parseDreamEntries 无标记时解析全文", () => {
  const entries = parseDreamEntries("---\n\n*May 3, 2026 at 9:00 AM GMT+8*\n\n旧梦。\n");
  expect(entries).toHaveLength(1);
  expect(entries[0].body).toContain("旧梦。");
});

test("removeDreamEntry 删除最新一条，标记与剩余条目保留", () => {
  const next = removeDreamEntry(DREAMS, 0);
  expect(next).not.toBeNull();
  expect(next!).toContain("openclaw:dreaming:diary:start");
  expect(next!).toContain("第一夜梦境。");
  expect(next!).not.toContain("第二夜梦境。");
  // 删除后剩余条目仍可解析
  expect(parseDreamEntries(next!)).toHaveLength(1);
});

test("removeDreamEntry 越界 index 返回 null", () => {
  expect(removeDreamEntry(DREAMS, 9)).toBeNull();
});

test("deleteDreamEntryFile 写回 + .bak 备份", () => {
  const dreamsPath = path.join(tmp, "DREAMS.md");
  fs.writeFileSync(dreamsPath, DREAMS, "utf-8");
  expect(deleteDreamEntryFile(dreamsPath, 0)).toBe(true);
  const after = fs.readFileSync(dreamsPath, "utf-8");
  expect(after).not.toContain("第二夜梦境。");
  expect(fs.readFileSync(`${dreamsPath}.bak`, "utf-8")).toBe(DREAMS);
  expect(deleteDreamEntryFile(dreamsPath, 5)).toBe(false);
});

/* ── CLI 输出 ── */

test("extractCliJson 提取混有告警行的 JSON（对象/数组/嵌套字符串括号）", () => {
  expect(extractCliJson('{"results":[]}')).toEqual({ results: [] });
  expect(extractCliJson('[memory] warning line\n[{"a":1}]')).toEqual([{ a: 1 }]);
  expect(extractCliJson('noise {"a":"has } brace","b":[1,2]} tail')).toEqual({ a: "has } brace", b: [1, 2] });
  expect(extractCliJson("no json at all")).toBeNull();
  expect(extractCliJson('{"unterminated')).toBeNull();
});

test("buildMemoryCliArgs search/reindex 参数", () => {
  expect(buildMemoryCliArgs("search", { query: "我的密钥", maxResults: 5 })).toEqual(
    ["memory", "search", "--json", "--query", "我的密钥", "--max-results", "5"],
  );
  expect(buildMemoryCliArgs("search", { query: "  " })).toEqual(["memory", "search", "--json"]);
  expect(buildMemoryCliArgs("search", { query: "q", maxResults: 999 })).toEqual(["memory", "search", "--json", "--query", "q"]);
  expect(buildMemoryCliArgs("reindex", {})).toEqual(["memory", "status", "--index", "--json"]);
});

test("coerceRecallPayload / coerceIndexStatus 防御性形状", () => {
  expect(coerceRecallPayload({ results: [{ score: 0.9, content: "x" }], stale: true, warning: "w" })).toEqual({
    results: [{ score: 0.9, content: "x" }], stale: true, warning: "w", lastError: undefined,
  });
  expect(coerceRecallPayload(null)).toEqual({ results: [], stale: false, warning: undefined, lastError: undefined });
  expect(coerceRecallPayload({ results: "nope" }).results).toEqual([]);

  expect(coerceIndexStatus([{ status: { dirty: false, files: 37, chunks: 151 } }])).toEqual({
    ok: true, dirty: false, files: 37, chunks: 151, lastSyncError: undefined,
  });
  expect(coerceIndexStatus([])).toEqual({ ok: false });
  expect(coerceIndexStatus(null)).toEqual({ ok: false });
});
