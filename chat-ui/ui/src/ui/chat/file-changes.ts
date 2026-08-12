/**
 * 本轮改动文件列表（阶段 18）。
 *
 * 取证结论：内核 sessions.files.list 是全会话粒度且只有 read/modified 两档，
 * 无法区分「新增/删除」，也不按轮次（消息组）归属，故不采用。
 * 这里在渲染层按组扫描 tool cards 派生：
 * - write：同会话早先未触碰过的路径 → added，否则 modified
 * - edit：modified
 * - apply_patch：解析 args.input 文本补丁（*** Add/Delete/Update File:、*** Move to:）
 *   或结构化 args.changes[]（{path, kind}）→ added/deleted/modified
 * 同组内同路径合并：delete 优先，否则保留首个 kind。
 * 「触碰」= 本会话可见窗口内任意 read/write/edit/apply_patch 引用过该路径。
 * 注意：历史渲染窗口上限 200 条，窗口外的触碰不可知，此时 write 倾向判 added——可接受。
 */

import type { MessageGroup } from "../types/chat-types.ts";
import { extractToolCards } from "./tool-cards.ts";

export type FileChangeKind = "added" | "modified" | "deleted";
export type FileChange = { path: string; kind: FileChangeKind };

const PATH_ARG_KEYS = ["path", "file_path", "filePath", "file"];
// 产生文件改动的工具（内核命名，见 tool-display.ts 取证）
const WRITE_TOOLS = new Set(["write", "write_file", "create", "create_file"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "str_replace", "str_replace_editor", "apply_diff"]);
const PATCH_TOOLS = new Set(["apply_patch", "applypatch"]);
// 只读但算「触碰」的工具
const READ_TOOLS = new Set(["read", "read_file"]);

function extractPathArg(args: unknown): string | null {
  if (!args || typeof args !== "object") {
    return null;
  }
  const record = args as Record<string, unknown>;
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/^\.\//, "");
    }
  }
  return null;
}

/** 解析 apply_patch 文本补丁（V4A 格式） */
function parseTextPatch(input: string): FileChange[] {
  const changes: FileChange[] = [];
  let pendingUpdate: FileChange | null = null;
  const flush = () => {
    if (pendingUpdate) {
      changes.push(pendingUpdate);
      pendingUpdate = null;
    }
  };
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    let m = /^\*\*\* Add File:\s*(.+)$/.exec(trimmed);
    if (m) {
      flush();
      changes.push({ path: m[1].trim(), kind: "added" });
      continue;
    }
    m = /^\*\*\* Delete File:\s*(.+)$/.exec(trimmed);
    if (m) {
      flush();
      changes.push({ path: m[1].trim(), kind: "deleted" });
      continue;
    }
    m = /^\*\*\* Update File:\s*(.+)$/.exec(trimmed);
    if (m) {
      flush();
      pendingUpdate = { path: m[1].trim(), kind: "modified" };
      continue;
    }
    m = /^\*\*\* Move to:\s*(.+)$/.exec(trimmed);
    if (m && pendingUpdate) {
      // 移动 = 旧路径删除 + 新路径新增
      changes.push({ path: pendingUpdate.path, kind: "deleted" });
      changes.push({ path: m[1].trim(), kind: "added" });
      pendingUpdate = null;
    }
  }
  flush();
  return changes;
}

/** 解析 apply_patch 结构化 changes 参数 */
function parseStructuredPatch(changes: unknown[]): FileChange[] {
  const result: FileChange[] = [];
  for (const item of changes) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path) {
      continue;
    }
    const kindRaw = typeof record.kind === "string" ? record.kind.toLowerCase() : "";
    const kind: FileChangeKind = kindRaw.startsWith("add")
      ? "added"
      : kindRaw.startsWith("del")
        ? "deleted"
        : "modified";
    result.push({ path, kind });
  }
  return result;
}

function collectPatchChanges(args: unknown): FileChange[] {
  if (!args || typeof args !== "object") {
    return [];
  }
  const record = args as Record<string, unknown>;
  if (typeof record.input === "string" && record.input.trim()) {
    return parseTextPatch(record.input);
  }
  if (Array.isArray(record.changes)) {
    return parseStructuredPatch(record.changes);
  }
  return [];
}

/** 组内合并：同路径 delete 优先，否则保留首个 kind */
function mergeInto(list: FileChange[], change: FileChange) {
  const existing = list.find((c) => c.path === change.path);
  if (!existing) {
    list.push(change);
    return;
  }
  if (change.kind === "deleted" && existing.kind !== "deleted") {
    existing.kind = "deleted";
  }
}

/**
 * 扫描一组消息派生本轮文件改动；同时把引用过的路径记入 touched（跨组共享）。
 */
export function collectGroupFileChanges(
  messages: unknown[],
  touched: Set<string>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const message of messages) {
    for (const card of extractToolCards(message)) {
      if (card.kind !== "call") {
        continue;
      }
      const name = card.name.toLowerCase();
      if (PATCH_TOOLS.has(name)) {
        for (const change of collectPatchChanges(card.args)) {
          touched.add(change.path);
          mergeInto(changes, change);
        }
        continue;
      }
      const path = extractPathArg(card.args);
      if (!path) {
        continue;
      }
      if (WRITE_TOOLS.has(name)) {
        mergeInto(changes, { path, kind: touched.has(path) ? "modified" : "added" });
        touched.add(path);
      } else if (EDIT_TOOLS.has(name)) {
        mergeInto(changes, { path, kind: "modified" });
        touched.add(path);
      } else if (READ_TOOLS.has(name)) {
        touched.add(path);
      }
    }
  }
  return changes;
}

/**
 * 按时间序遍历所有消息组，返回 groupKey → 本轮改动列表（仅含有改动的组）。
 */
export function computeSessionFileChanges(
  groups: MessageGroup[],
): Map<string, FileChange[]> {
  const touched = new Set<string>();
  const byGroup = new Map<string, FileChange[]>();
  for (const group of groups) {
    const changes = collectGroupFileChanges(
      group.messages.map((item) => item.message),
      touched,
    );
    if (changes.length > 0) {
      byGroup.set(group.key, changes);
    }
  }
  return byGroup;
}
