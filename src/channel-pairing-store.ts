import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "./atomic-write";

const DEFAULT_PAIRING_ACCOUNT_ID = "default";

// 统一规整 allowFrom 条目，过滤空值并去重。
function normalizeAllowFromEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean),
    ),
  );
}

// 当前 openclaw 的默认账号会写进 `<channel>-default-allowFrom.json`，旧版本则写 legacy 文件名。
function resolveAllowFromStorePaths(credentialsDir: string, channel: string): string[] {
  const safeChannel = String(channel ?? "").trim().toLowerCase();
  return [
    path.join(credentialsDir, `${safeChannel}-${DEFAULT_PAIRING_ACCOUNT_ID}-allowFrom.json`),
    path.join(credentialsDir, `${safeChannel}-allowFrom.json`),
  ];
}

// 读取单个 allowFrom store 文件，失败时按空数组处理，避免把 UI 直接打爆。
function readSingleAllowFromStore(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return normalizeAllowFromEntries(parsed?.allowFrom);
  } catch {
    return [];
  }
}

// 统一读取某个渠道的 allowFrom store，并兼容 default 账号作用域与旧路径。
export function readChannelAllowFromStoreEntries(credentialsDir: string, channel: string): string[] {
  const collected: string[] = [];
  for (const filePath of resolveAllowFromStorePaths(credentialsDir, channel)) {
    collected.push(...readSingleAllowFromStore(filePath));
  }
  return Array.from(new Set(collected));
}

// 写入 allowFrom store 时优先落到 default 账号作用域文件，同时清理 legacy 重复状态。
export function writeChannelAllowFromStoreEntries(
  credentialsDir: string,
  channel: string,
  entries: string[],
): void {
  const normalized = normalizeAllowFromEntries(entries);
  const [defaultPath, legacyPath] = resolveAllowFromStorePaths(credentialsDir, channel);

  if (normalized.length === 0) {
    for (const filePath of [defaultPath, legacyPath]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    return;
  }

  fs.mkdirSync(credentialsDir, { recursive: true });
  const payload = {
    channel: String(channel ?? "").trim().toLowerCase(),
    allowFrom: normalized,
  };
  // 授权类配置不走半截 JSON：tmp + fsync + rename 原子写，掉电/崩溃不留中间态
  // （读侧对半截 JSON 容错为 []，静默丢失已批准用户，不可取）。
  writeFileAtomicSync(defaultPath, JSON.stringify(payload, null, 2));
  if (fs.existsSync(legacyPath)) {
    fs.unlinkSync(legacyPath);
  }
}

// 纯函数：从 allowFrom 条目中移除指定 id（remove 流程与单测共用）。
export function applyRemoveAllowFromEntries(entries: string[], removeIds: string[]): string[] {
  const removeSet = new Set(
    removeIds.map((id) => String(id ?? "").trim()).filter(Boolean),
  );
  if (removeSet.size === 0) return normalizeAllowFromEntries(entries);
  return normalizeAllowFromEntries(entries).filter((entry) => !removeSet.has(entry));
}

// remove 授权的「读-改-写」：写前重读一次磁盘，在最新内容基础上应用删除。
// 该文件同时被 gateway `openclaw pairing approve` 写入，基于旧快照覆盖会把并发
// 批准的条目静默抹掉；重读把 lost-update 窗口缩到最小（跨进程竞态无法完全消除，
// 这里不加锁文件——那要动 gateway 侧）。注意 remove 是删除语义，不能做并集合并，
// 否则被移除的条目会复活。
export function removeChannelAllowFromStoreEntries(
  credentialsDir: string,
  channel: string,
  removeIds: string[],
): void {
  const latest = readChannelAllowFromStoreEntries(credentialsDir, channel);
  const next = applyRemoveAllowFromEntries(latest, removeIds);
  writeChannelAllowFromStoreEntries(credentialsDir, channel, next);
}
