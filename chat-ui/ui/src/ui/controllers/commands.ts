/**
 * commands.ts — 官方 / 命令目录（commands.list）加载与缓存。
 * 失败静默降级（返回 null），不阻塞聊天。
 */
import type { GatewayBrowserClient } from "../gateway.ts";
import { getLocale, t } from "../i18n.ts";
import type { CommandEntry } from "../types.ts";

const COMMANDS_CACHE_TTL_MS = 5 * 60_000;
const COMMANDS_RETRY_AFTER_FAILURE_MS = 30_000;

let cache: { at: number; commands: CommandEntry[] } | null = null;
let lastFailureAt = 0;
let inflight: Promise<CommandEntry[] | null> | null = null;

export function getCachedCommands(): CommandEntry[] | null {
  if (cache && Date.now() - cache.at < COMMANDS_CACHE_TTL_MS) {
    return cache.commands;
  }
  return null;
}

export async function loadCommands(
  client: GatewayBrowserClient,
  opts?: { force?: boolean },
): Promise<CommandEntry[] | null> {
  const cached = getCachedCommands();
  if (cached && !opts?.force) {
    return cached;
  }
  if (Date.now() - lastFailureAt < COMMANDS_RETRY_AFTER_FAILURE_MS && !opts?.force) {
    return null;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const res = await client.request<{ commands?: CommandEntry[] }>("commands.list", {
        includeArgs: true,
      });
      const commands = Array.isArray(res?.commands) ? res.commands : [];
      if (commands.length > 0) {
        cache = { at: Date.now(), commands };
        return commands;
      }
      lastFailureAt = Date.now();
      return getCachedCommands();
    } catch {
      lastFailureAt = Date.now();
      return getCachedCommands();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 按输入过滤命令：匹配 name / textAliases（大小写不敏感，前缀优先） */
export function filterCommands(
  commands: CommandEntry[],
  query: string,
  limit = 8,
): CommandEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return commands.slice(0, limit);
  }
  const prefix: CommandEntry[] = [];
  const contains: CommandEntry[] = [];
  for (const cmd of commands) {
    const names = [cmd.name, ...(cmd.textAliases ?? [])];
    const matched = names.some((n) => n.toLowerCase().startsWith(q));
    if (matched) {
      prefix.push(cmd);
    } else if (names.some((n) => n.toLowerCase().includes(q))) {
      contains.push(cmd);
    }
  }
  return [...prefix, ...contains].slice(0, limit);
}

// 常见官方命令的词典化描述（commands.<name>，en/zh 双侧）。
// commands.list 返回内核英文 description——zh 界面优先词典汉化，
// en 界面优先内核描述（随内核版本演进，防词典漂移），词典值兜底内核缺失。

/** 命令显示描述：zh 界面优先词典；en 界面优先内核英文描述，未收录/缺失回退词典。 */
export function resolveCommandDescription(cmd: CommandEntry): string {
  const dictKey = `commands.${cmd.name}`;
  const hasDict = t(dictKey) !== dictKey;
  if (getLocale() === "zh") {
    return (hasDict ? t(dictKey) : "") || cmd.description || "";
  }
  return cmd.description || (hasDict ? t(dictKey) : "");
}