/**
 * commands.ts — 官方 / 命令目录（commands.list）加载与缓存。
 * 失败静默降级（返回 null），不阻塞聊天。
 */
import type { GatewayBrowserClient } from "../gateway.ts";
import { getLocale } from "../i18n.ts";
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

// 常见官方命令的中文描述（commands.list 返回英文 description，此处按 name 汉化；
// 未收录的命令回退内核英文描述）。
const COMMAND_DESCRIPTION_ZH: Record<string, string> = {
  goal: "设置/管理会话目标（开始、暂停、恢复、清除）",
  think: "调整思考强度（think hard / think harder 等）",
  fast: "切换快速模式（fast on/off/auto）",
  new: "新建会话",
  compact: "压缩会话历史",
  exec: "执行命令并调整执行策略（host/security/ask）",
  plan: "进入计划模式（先规划后执行）",
  elevated: "切换提权执行（elevated on/full）",
  sandbox: "查看/管理沙箱容器",
  help: "显示帮助",
  status: "查看当前状态",
  usage: "查看用量统计",
  memory: "管理长期记忆",
  skills: "管理技能",
  doctor: "运行环境诊断与修复",
  config: "查看/修改配置",
  sessions: "管理会话列表",
  channels: "查看渠道状态",
  cron: "管理定时任务",
  tasks: "查看后台任务",
  node: "管理节点设备",
};

/** 命令显示描述：中文界面优先中文映射；英文界面与未收录命令回退内核英文描述。 */
export function resolveCommandDescription(cmd: CommandEntry): string {
  if (getLocale() === "zh") {
    return COMMAND_DESCRIPTION_ZH[cmd.name] ?? cmd.description ?? "";
  }
  return cmd.description ?? COMMAND_DESCRIPTION_ZH[cmd.name] ?? "";
}