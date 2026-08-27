/**
 * Settings: 飞书 / 企业微信 pairing（待审批列表、批准/拒绝、已授权列表、allowFrom 增删）。
 * pairing store / alias store / rejected store 均为 sidecar 文件，属主进程职责。
 */
import { ipcMain } from "electron";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import {
  resolveGatewayCwd,
  resolveGatewayEntry,
  resolveNodeBin,
  resolveNodeExtraEnv,
  resolveResourcesPath,
  resolveUserStateDir,
} from "../constants";
import { readUserConfig, writeUserConfig } from "../provider-config";
import {
  readChannelAllowFromStoreEntries as readChannelAllowFromStoreEntriesFromFs,
  writeChannelAllowFromStoreEntries as writeChannelAllowFromStoreEntriesFromFs,
} from "../channel-pairing-store";
import { WECOM_CHANNEL_ID } from "../wecom-config";
import { FEISHU_CHANNEL_ID } from "../feishu-config";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import type { SettingsIpcOptions } from "./types";

type CliRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type PairingRequestView = {
  code: string;
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
};

type FeishuPairingRequestView = PairingRequestView;

type FeishuRejectedPairingStore = {
  version: 1;
  codes: string[];
};

type FeishuAuthorizedEntryView = {
  kind: "user" | "group";
  id: string;
  name: string;
};

type FeishuAliasStore = {
  version: 1;
  users: Record<string, string>;
  groups: Record<string, string>;
};

const FEISHU_CHANNEL = FEISHU_CHANNEL_ID;
const WILDCARD_ALLOW_ENTRY = "*";
const FEISHU_ALIAS_STORE_FILE = "feishu-allowFrom-aliases.json";
const FEISHU_REJECTED_PAIRING_STORE_FILE = "feishu-rejected-pairing-codes.json";
const WECOM_REJECTED_PAIRING_STORE_FILE = "wecom-rejected-pairing-codes.json";
const FEISHU_OPEN_API_BASE = "https://open.feishu.cn/open-apis";
const FEISHU_TOKEN_SAFETY_MS = 60_000;
// 名称补全失败负缓存 TTL：失败 id 10 分钟内不再重试，避免每次打开配对页全量重打 OpenAPI
const FEISHU_NAME_FAILURE_TTL_MS = 10 * 60_000;

type FeishuTenantTokenCache = {
  appId: string;
  appSecret: string;
  token: string;
  expireAt: number;
};

let feishuTenantTokenCache: FeishuTenantTokenCache | null = null;

// 名称补全失败负缓存（纯内存不落盘）：openId/chatId → 最近失败时间戳。
// 查询成功或 approve 写入别名后删除条目；TTL 过期后允许重试。
const feishuNameFetchFailures = new Map<string, number>();

function isFeishuNameFetchRecentlyFailed(id: string): boolean {
  const failedAt = feishuNameFetchFailures.get(id);
  return failedAt !== undefined && Date.now() - failedAt < FEISHU_NAME_FAILURE_TTL_MS;
}

export function registerPairingIpc(opts: SettingsIpcOptions): void {
  // ── 列出企业微信已授权用户与群聊 ──
  // ── 列出企业微信待审批配对请求（按需 spawn `openclaw pairing list`） ──
  ipcMain.handle("settings:list-wecom-pairing", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:list-wecom-pairing")) throw new Error("IPC sender not trusted");
    const listed = await listWecomPairingRequests();
    return {
      success: listed.success,
      data: listed.success ? { requests: listed.requests } : undefined,
      message: listed.message,
    };
  });

  // ── 批准企业微信配对请求 ──
  ipcMain.handle("settings:approve-wecom-pairing", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:approve-wecom-pairing")) throw new Error("IPC sender not trusted");
    return approveWecomPairingRequest(params);
  });

  // ── 拒绝企业微信配对请求（本地 sidecar 忽略） ──
  ipcMain.handle("settings:reject-wecom-pairing", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:reject-wecom-pairing")) throw new Error("IPC sender not trusted");
    return rejectWecomPairingRequest(params);
  });

  ipcMain.handle("settings:list-wecom-approved", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:list-wecom-approved")) throw new Error("IPC sender not trusted");
    try {
      const config = readUserConfig();
      const wecomConfig = config?.channels?.[WECOM_CHANNEL_ID] ?? {};
      const userEntries = collectApprovedUserIds(
        WECOM_CHANNEL_ID,
        wecomConfig?.allowFrom,
      ).map((id) => ({ kind: "user" as const, id, name: id }));
      const groupEntries = normalizeAllowFromEntries(wecomConfig?.groupAllowFrom)
        .map((id) => ({ kind: "group" as const, id, name: id }));
      const entries: FeishuAuthorizedEntryView[] = [...userEntries, ...groupEntries];
      entries.sort(compareAuthorizedEntry);
      return { success: true, data: { entries } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 添加企业微信用户白名单条目 ──
  ipcMain.handle("settings:add-wecom-user-allow-from", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:add-wecom-user-allow-from")) throw new Error("IPC sender not trusted");
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    if (!id) {
      return { success: false, message: "用户 ID 不能为空。" };
    }

    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels[WECOM_CHANNEL_ID] ??= {};
      const currentAllowFrom = normalizeAllowFromEntries(config.channels[WECOM_CHANNEL_ID].allowFrom)
        .filter((entry) => entry !== WILDCARD_ALLOW_ENTRY);
      const nextAllowFrom = dedupeEntries([...currentAllowFrom, id]);
      if (nextAllowFrom.length > 0) {
        config.channels[WECOM_CHANNEL_ID].allowFrom = nextAllowFrom;
      }
      const nextStoreAllowFrom = dedupeEntries([
        ...readChannelAllowFromStore(WECOM_CHANNEL_ID),
        id,
      ]);
      writeChannelAllowFromStore(WECOM_CHANNEL_ID, nextStoreAllowFrom);
      writeUserConfig(config);
      opts.requestGatewayRestart?.();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 添加企业微信群白名单条目 ──
  ipcMain.handle("settings:add-wecom-group-allow-from", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:add-wecom-group-allow-from")) throw new Error("IPC sender not trusted");
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    if (!id) {
      return { success: false, message: "群 ID 不能为空。" };
    }

    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels[WECOM_CHANNEL_ID] ??= {};
      const nextGroupAllowFrom = dedupeEntries([
        ...normalizeAllowFromEntries(config.channels[WECOM_CHANNEL_ID].groupAllowFrom),
        id,
      ]);
      config.channels[WECOM_CHANNEL_ID].groupAllowFrom = nextGroupAllowFrom;
      writeUserConfig(config);
      opts.requestGatewayRestart?.();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 删除企业微信已授权用户/群聊 ──
  ipcMain.handle("settings:remove-wecom-approved", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:remove-wecom-approved")) throw new Error("IPC sender not trusted");
    const kind = params?.kind === "group" ? "group" : "user";
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    if (!id) {
      return { success: false, message: "授权 ID 不能为空。" };
    }
    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels[WECOM_CHANNEL_ID] ??= {};

      if (kind === "group") {
        const nextGroupAllowFrom = normalizeAllowFromEntries(config.channels[WECOM_CHANNEL_ID].groupAllowFrom)
          .filter((entry) => entry !== id);
        config.channels[WECOM_CHANNEL_ID].groupAllowFrom = nextGroupAllowFrom;
      } else {
        const nextAllowFrom = normalizeAllowFromEntries(config.channels[WECOM_CHANNEL_ID].allowFrom)
          .filter((entry) => entry !== id && entry !== WILDCARD_ALLOW_ENTRY);
        if (nextAllowFrom.length > 0) {
          config.channels[WECOM_CHANNEL_ID].allowFrom = nextAllowFrom;
        } else {
          delete config.channels[WECOM_CHANNEL_ID].allowFrom;
        }

        const nextStoreAllowFrom = readChannelAllowFromStore(WECOM_CHANNEL_ID).filter((entry) => entry !== id);
        writeChannelAllowFromStore(WECOM_CHANNEL_ID, nextStoreAllowFrom);
      }

      writeUserConfig(config);
      opts.requestGatewayRestart?.();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 列出飞书已授权列表（用户 + 群聊，优先展示可读名称） ──
  // ── 列出飞书待审批配对请求（按需 spawn `openclaw pairing list`） ──
  ipcMain.handle("settings:list-feishu-pairing", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:list-feishu-pairing")) throw new Error("IPC sender not trusted");
    const listed = await listFeishuPairingRequests();
    return {
      success: listed.success,
      data: listed.success ? { requests: listed.requests } : undefined,
      message: listed.message,
    };
  });

  // ── 批准飞书配对请求 ──
  ipcMain.handle("settings:approve-feishu-pairing", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:approve-feishu-pairing")) throw new Error("IPC sender not trusted");
    return approveFeishuPairingRequest(params);
  });

  // ── 拒绝飞书配对请求（本地 sidecar 忽略） ──
  ipcMain.handle("settings:reject-feishu-pairing", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:reject-feishu-pairing")) throw new Error("IPC sender not trusted");
    return rejectFeishuPairingRequest(params);
  });

  ipcMain.handle("settings:list-feishu-approved", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:list-feishu-approved")) throw new Error("IPC sender not trusted");
    try {
      const config = readUserConfig();
      const feishuConfig = config?.channels?.feishu ?? {};
      const configEntries = normalizeAllowFromEntries(feishuConfig?.allowFrom);
      const storeEntries = readFeishuAllowFromStore();
      const aliases = readFeishuAliasStore();

      const userEntries = dedupeEntries([...storeEntries, ...configEntries])
        .filter((entry) => entry !== WILDCARD_ALLOW_ENTRY)
        .map((id) => toAuthorizedEntryView("user", id, aliases))
        .sort((a, b) => compareAuthorizedEntry(a, b));

      const groupEntries = normalizeAllowFromEntries(feishuConfig?.groupAllowFrom)
        .map((id) => toAuthorizedEntryView("group", id, aliases))
        .sort((a, b) => compareAuthorizedEntry(a, b));

      const entries: FeishuAuthorizedEntryView[] = [...userEntries, ...groupEntries];
      const enrichedEntries = await enrichFeishuEntryNames(entries, feishuConfig);
      enrichedEntries.sort((a, b) => compareAuthorizedEntry(a, b));
      return { success: true, data: { entries: enrichedEntries } };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 添加用户白名单条目（飞书 open_id / union_id） ──
  ipcMain.handle("settings:add-feishu-user-allow-from", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:add-feishu-user-allow-from")) throw new Error("IPC sender not trusted");
    const id = String(params?.id ?? "").trim();
    if (!id) {
      return { success: false, message: "用户 ID 不能为空。" };
    }
    if (!looksLikeFeishuUserId(id)) {
      return { success: false, message: "仅允许填写以 ou_ 开头的飞书用户 open_id。" };
    }

    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels.feishu ??= {};
      const currentAllowFrom = normalizeAllowFromEntries(config.channels.feishu.allowFrom)
        .filter((entry) => entry !== WILDCARD_ALLOW_ENTRY);
      const nextAllowFrom = dedupeEntries([...currentAllowFrom, id]);
      if (nextAllowFrom.length > 0) {
        config.channels.feishu.allowFrom = nextAllowFrom;
      }
      const nextStoreAllowFrom = dedupeEntries([...readFeishuAllowFromStore(), id]);
      writeFeishuAllowFromStore(nextStoreAllowFrom);
      writeUserConfig(config);
      opts.requestGatewayRestart?.();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 删除飞书已授权条目（用户/群聊） ──
  ipcMain.handle("settings:remove-feishu-approved", async (_event, params) => {
    if (!assertTrustedIpcSender(_event, "settings:remove-feishu-approved")) throw new Error("IPC sender not trusted");
    const kind = String(params?.kind ?? "").trim().toLowerCase() === "group" ? "group" : "user";
    const id = String(params?.id ?? "").trim();
    if (!id) {
      return { success: false, message: "授权条目标识不能为空。" };
    }

    try {
      const config = readUserConfig();
      config.channels ??= {};
      config.channels.feishu ??= {};

      if (kind === "group") {
        const nextGroupAllowFrom = normalizeAllowFromEntries(config.channels.feishu.groupAllowFrom)
          .filter((entry) => entry !== id);
        if (nextGroupAllowFrom.length > 0) {
          config.channels.feishu.groupAllowFrom = nextGroupAllowFrom;
        } else {
          delete config.channels.feishu.groupAllowFrom;
        }
        removeFeishuAlias("group", id);
        writeUserConfig(config);
        opts.requestGatewayRestart?.();
        return { success: true };
      }

      const nextAllowFrom = normalizeAllowFromEntries(config.channels.feishu.allowFrom)
        .filter((entry) => entry !== id);
      if (nextAllowFrom.length > 0) {
        config.channels.feishu.allowFrom = nextAllowFrom;
      } else {
        delete config.channels.feishu.allowFrom;
      }

      const nextStoreAllowFrom = readFeishuAllowFromStore().filter((entry) => entry !== id);
      writeFeishuAllowFromStore(nextStoreAllowFrom);
      removeFeishuAlias("user", id);
      writeUserConfig(config);
      opts.requestGatewayRestart?.();
      return { success: true };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

}
// 列出飞书待审批请求：解析 CLI 输出并统一成前端可消费结构。
async function listFeishuPairingRequests(): Promise<{
  success: boolean;
  requests: FeishuPairingRequestView[];
  message?: string;
}> {
  return listChannelPairingRequests(FEISHU_CHANNEL, "读取飞书待审批列表失败", "解析飞书待审批列表失败");
}

// 列出企业微信待审批请求：解析 CLI 输出并统一成前端可消费结构。
async function listWecomPairingRequests(): Promise<{
  success: boolean;
  requests: PairingRequestView[];
  message?: string;
}> {
  return listChannelPairingRequests(WECOM_CHANNEL_ID, "读取企业微信待审批列表失败", "解析企业微信待审批列表失败");
}

// 批准飞书配对请求：调用 CLI 并在成功后缓存用户别名用于展示。
async function approveFeishuPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  const id = typeof params?.id === "string" ? params.id.trim() : "";
  const name = typeof params?.name === "string" ? params.name.trim() : "";
  const result = await approveChannelPairingRequest(FEISHU_CHANNEL, params);
  if (result.success && id && name) {
    saveFeishuAlias("user", id, name);
    feishuNameFetchFailures.delete(id);
  }
  return result;
}

// 批准企业微信配对请求：调用 CLI，并在成功后清理本地拒绝码。
async function approveWecomPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  return approveChannelPairingRequest(WECOM_CHANNEL_ID, params);
}

// 拒绝飞书配对请求：当前 openclaw pairing 无 reject 子命令，改为本地忽略当前配对码。
async function rejectFeishuPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  return rejectChannelPairingRequest(FEISHU_CHANNEL, params);
}

// 拒绝企业微信配对请求：当前 openclaw pairing 无 reject 子命令，改为本地忽略当前配对码。
async function rejectWecomPairingRequest(params: Record<string, unknown>): Promise<{
  success: boolean;
  message?: string;
}> {
  return rejectChannelPairingRequest(WECOM_CHANNEL_ID, params);
}

// 统一解析某个渠道的待审批列表，并过滤本地 sidecar 里的拒绝码。
async function listChannelPairingRequests(
  channel: string,
  listErrorMessage: string,
  parseErrorMessage: string,
): Promise<{
  success: boolean;
  requests: PairingRequestView[];
  message?: string;
}> {
  try {
    const run = await runGatewayCli(["pairing", "list", channel, "--json"]);
    if (run.code !== 0) {
      return {
        success: false,
        requests: [],
        message: compactCliError(run, listErrorMessage),
      };
    }

    const parsed = parseJsonSafe(run.stdout);
    if (!parsed || !Array.isArray(parsed?.requests)) {
      return {
        success: false,
        requests: [],
        message: compactCliError(run, parseErrorMessage),
      };
    }

    const rawRequests = Array.isArray(parsed?.requests) ? parsed.requests : [];
    const parsedRequests: PairingRequestView[] = rawRequests.map((item: any) => ({
      code: String(item?.code ?? ""),
      id: String(item?.id ?? ""),
      name: String(item?.meta?.name ?? item?.name ?? ""),
      createdAt: String(item?.createdAt ?? ""),
      lastSeenAt: String(item?.lastSeenAt ?? ""),
    }));
    const rejectedCodes = new Set(readRejectedPairingCodes(resolveRejectedPairingStoreFile(channel)));
    const requests = parsedRequests.filter((item) => !rejectedCodes.has(item.code));
    if (rejectedCodes.size > 0) {
      const activeCodes = new Set(parsedRequests.map((item) => item.code));
      pruneRejectedPairingCodes(resolveRejectedPairingStoreFile(channel), activeCodes);
    }
    return { success: true, requests };
  } catch (err: any) {
    return {
      success: false,
      requests: [],
      message: err?.message || String(err),
    };
  }
}

// 从 params 提取并校验配对码（approve / reject 共用）：空则返回 null。
function extractPairingCode(params: Record<string, unknown>): string | null {
  const code = typeof params?.code === "string" ? params.code.trim() : "";
  return code || null;
}

// 统一执行渠道 pairing approve，避免每个渠道重复拼 CLI 参数。
async function approveChannelPairingRequest(
  channel: string,
  params: Record<string, unknown>,
): Promise<{
  success: boolean;
  message?: string;
}> {
  const code = extractPairingCode(params);
  if (!code) {
    return { success: false, message: "配对码不能为空。" };
  }

  try {
    const run = await runGatewayCli(["pairing", "approve", channel, code, "--notify"]);
    if (run.code !== 0) {
      return {
        success: false,
        message: compactCliError(run, `批准配对码失败: ${code}`),
      };
    }
    removeRejectedPairingCode(resolveRejectedPairingStoreFile(channel), code);
    return { success: true };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}

// 当前 openclaw pairing 暂无 reject 子命令，这里统一用本地 sidecar 忽略当前 pairing code。
async function rejectChannelPairingRequest(
  channel: string,
  params: Record<string, unknown>,
): Promise<{
  success: boolean;
  message?: string;
}> {
  const code = extractPairingCode(params);
  if (!code) {
    return { success: false, message: "配对码不能为空。" };
  }
  appendRejectedPairingCode(resolveRejectedPairingStoreFile(channel), code);
  return { success: true };
}

// 根据配置与授权存储统计当前已授权用户，排除通配符与空值。
function collectApprovedUserIds(channel: string, configAllowFrom: unknown): string[] {
  const configEntries = normalizeAllowFromEntries(configAllowFrom).filter(
    (entry) => entry !== WILDCARD_ALLOW_ENTRY
  );
  const storeEntries = readChannelAllowFromStore(channel);
  return dedupeEntries([...configEntries, ...storeEntries]);
}

// 统一运行 openclaw CLI 子命令，复用 CryoClaw 内嵌 runtime 与网关入口。
// 带 90s 超时兑底（对齐 plugin-store execKernelCli）：CLI 内部死锁时
// Promise 永不 settle 会让渲染层 invoke 永久 pending 且泄漏 node 子进程。
async function runGatewayCli(args: string[]): Promise<CliRunResult> {
  const nodeBin = resolveNodeBin();
  const entry = resolveGatewayEntry();
  const cwd = resolveGatewayCwd();
  const runtimeDir = path.join(resolveResourcesPath(), "runtime");
  const envPath = runtimeDir + path.delimiter + (process.env.PATH ?? "");

  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [entry, ...args], {
      cwd,
      env: {
        ...process.env,
        ...resolveNodeExtraEnv(),
        // 统一关闭入口二次 respawn，保证所有短命 CLI 子命令都静默运行
        OPENCLAW_NO_RESPAWN: "1",
        PATH: envPath,
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      // 兑底 kill：不 await 结果，让 close 事件自然触发 resolve
      child.kill();
    }, 90_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: typeof code === "number" ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

// 安全解析 JSON，失败时返回 null，避免界面因格式波动崩溃。
function parseJsonSafe(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // CLI 可能在 JSON 前打印插件日志，这里回退到“提取末尾 JSON 对象”策略。
    const match = trimmed.match(/\{[\s\S]*\}\s*$/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// 压缩 CLI 错误信息，优先保留有用输出并附带兜底描述。
function compactCliError(run: CliRunResult, fallback: string): string {
  const out = run.stderr.trim() || run.stdout.trim();
  if (!out) return fallback;
  const firstLine = out.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine ? firstLine.trim() : fallback;
}

// 规范化 allowFrom 列表，统一转换为非空字符串并去重。
function normalizeAllowFromEntries(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return dedupeEntries(
    input
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0)
  );
}

// 数组去重并保持原始顺序。
function dedupeEntries(items: string[]): string[] {
  return [...new Set(items)];
}

// 统一解析 pairing allowFrom store 文件（由 openclaw pairing approve 写入）。
function readChannelAllowFromStore(channel: string): string[] {
  return readChannelAllowFromStoreEntriesFromFs(
    path.join(resolveUserStateDir(), "credentials"),
    channel,
  );
}

// 写入 pairing allowFrom store 文件（兼容保留原有字段）。
function writeChannelAllowFromStore(channel: string, entries: string[]): void {
  writeChannelAllowFromStoreEntriesFromFs(
    path.join(resolveUserStateDir(), "credentials"),
    channel,
    entries,
  );
}

// 读取本地"已拒绝配对码"sidecar，用于过滤待审批列表。
function readRejectedPairingStore(fileName: string): FeishuRejectedPairingStore {
  const filePath = path.join(resolveUserStateDir(), "credentials", fileName);
  if (!fs.existsSync(filePath)) {
    return { version: 1, codes: [] };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = parseJsonSafe(raw);
    const codes = normalizeAllowFromEntries(parsed?.codes);
    return { version: 1, codes };
  } catch {
    return { version: 1, codes: [] };
  }
}

// 写入本地"已拒绝配对码"sidecar，空数组时删除文件。
function writeRejectedPairingStore(fileName: string, codes: string[]): void {
  const normalized = normalizeAllowFromEntries(codes);
  const dir = path.join(resolveUserStateDir(), "credentials");
  const filePath = path.join(dir, fileName);
  if (normalized.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const payload: FeishuRejectedPairingStore = {
    version: 1,
    codes: normalized,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

function readRejectedPairingCodes(fileName: string): string[] {
  return readRejectedPairingStore(fileName).codes;
}

function appendRejectedPairingCode(fileName: string, code: string): void {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return;
  const store = readRejectedPairingStore(fileName);
  if (store.codes.includes(trimmed)) return;
  store.codes.push(trimmed);
  writeRejectedPairingStore(fileName, store.codes);
}

function removeRejectedPairingCode(fileName: string, code: string): void {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return;
  const store = readRejectedPairingStore(fileName);
  const nextCodes = store.codes.filter((item) => item !== trimmed);
  if (nextCodes.length === store.codes.length) return;
  writeRejectedPairingStore(fileName, nextCodes);
}

function pruneRejectedPairingCodes(fileName: string, activeCodes: Set<string>): void {
  const store = readRejectedPairingStore(fileName);
  if (store.codes.length === 0) return;
  const nextCodes = store.codes.filter((code) => activeCodes.has(code));
  if (nextCodes.length === store.codes.length) return;
  writeRejectedPairingStore(fileName, nextCodes);
}

function resolveRejectedPairingStoreFile(channel: string): string {
  if (channel === WECOM_CHANNEL_ID) {
    return WECOM_REJECTED_PAIRING_STORE_FILE;
  }
  return FEISHU_REJECTED_PAIRING_STORE_FILE;
}

// 读取飞书 allowFrom store 文件（由 openclaw pairing approve 写入）。
function readFeishuAllowFromStore(): string[] {
  return readChannelAllowFromStore(FEISHU_CHANNEL);
}

// 写入飞书 allowFrom store 文件（兼容保留原有字段）。
function writeFeishuAllowFromStore(entries: string[]): void {
  writeChannelAllowFromStore(FEISHU_CHANNEL, entries);
}

// 补全授权条目的可读名称：用户/群聊优先查缓存，未命中则实时查询并回写缓存。
async function enrichFeishuEntryNames(
  entries: FeishuAuthorizedEntryView[],
  feishuConfig: Record<string, unknown>,
): Promise<FeishuAuthorizedEntryView[]> {
  const appId = String(feishuConfig?.appId ?? "").trim();
  const appSecret = String(feishuConfig?.appSecret ?? "").trim();
  if (!appId || !appSecret || entries.length === 0) {
    return entries;
  }

  const userTargets = entries.filter(
    (entry) =>
      entry.kind === "user" && !entry.name && looksLikeFeishuUserId(entry.id) && !isFeishuNameFetchRecentlyFailed(entry.id),
  );
  const groupTargets = entries.filter(
    (entry) =>
      entry.kind === "group" && !entry.name && looksLikeFeishuGroupId(entry.id) && !isFeishuNameFetchRecentlyFailed(entry.id),
  );
  if (userTargets.length === 0 && groupTargets.length === 0) {
    return entries;
  }

  const token = await resolveFeishuTenantAccessToken(appId, appSecret);
  if (!token) {
    return entries;
  }

  // 飞书 OpenAPI 有 QPS 限制：无并发上限的 Promise.all 在新环境（alias 缓存未建立）
  // 会一次并发几十个请求触发限流 → 名称留空 → 下次打开又全量重试。分批串行。
  await runWithConcurrencyLimit(userTargets, async (entry) => {
    const name = await fetchFeishuUserNameByOpenId(token, entry.id);
    if (name) {
      entry.name = name;
      saveFeishuAlias("user", entry.id, name);
      feishuNameFetchFailures.delete(entry.id);
    } else {
      feishuNameFetchFailures.set(entry.id, Date.now());
    }
  }, FEISHU_NAME_FETCH_CONCURRENCY);

  await runWithConcurrencyLimit(groupTargets, async (entry) => {
    const name = await fetchFeishuChatNameById(token, entry.id);
    if (name) {
      entry.name = name;
      saveFeishuAlias("group", entry.id, name);
      feishuNameFetchFailures.delete(entry.id);
    } else {
      feishuNameFetchFailures.set(entry.id, Date.now());
    }
  }, FEISHU_NAME_FETCH_CONCURRENCY);

  return entries;
}

const FEISHU_NAME_FETCH_CONCURRENCY = 5;

// 分批并发：每批上限 limit 个，批间串行。
async function runWithConcurrencyLimit<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

// 获取 tenant_access_token（内存缓存，过期前一分钟自动刷新）。
async function resolveFeishuTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const now = Date.now();
  if (
    feishuTenantTokenCache &&
    feishuTenantTokenCache.appId === appId &&
    feishuTenantTokenCache.appSecret === appSecret &&
    feishuTenantTokenCache.expireAt > now + FEISHU_TOKEN_SAFETY_MS
  ) {
    return feishuTenantTokenCache.token;
  }

  const payload = await fetchJsonWithTimeout(`${FEISHU_OPEN_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const code = Number(payload?.code ?? -1);
  const token = String(payload?.tenant_access_token ?? "").trim();
  const expire = Number(payload?.expire ?? 0);
  if (code !== 0 || !token || !Number.isFinite(expire) || expire <= 0) {
    return "";
  }

  feishuTenantTokenCache = {
    appId,
    appSecret,
    token,
    expireAt: now + expire * 1000,
  };
  return token;
}

// 根据 open_id 查询用户名。
async function fetchFeishuUserNameByOpenId(token: string, openId: string): Promise<string> {
  const encodedId = encodeURIComponent(openId);
  const url = `${FEISHU_OPEN_API_BASE}/contact/v3/users/${encodedId}?user_id_type=open_id`;
  const payload = await fetchJsonWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  if (Number(payload?.code ?? -1) !== 0) return "";
  return String(payload?.data?.user?.name ?? payload?.data?.name ?? "").trim();
}

// 根据 chat_id 查询群名称。
async function fetchFeishuChatNameById(token: string, chatId: string): Promise<string> {
  const encodedId = encodeURIComponent(chatId);
  const url = `${FEISHU_OPEN_API_BASE}/im/v1/chats/${encodedId}`;
  const payload = await fetchJsonWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  if (Number(payload?.code ?? -1) !== 0) return "";
  return String(payload?.data?.chat?.name ?? payload?.data?.name ?? "").trim();
}

// 带超时的 JSON 请求；失败返回 null，不阻塞主流程。
async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    return parseJsonSafe(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 判断字符串是否像飞书用户 open_id。
function looksLikeFeishuUserId(value: string): boolean {
  return /^ou_[A-Za-z0-9]/.test(value);
}

// 判断字符串是否像飞书群聊 chat_id。
function looksLikeFeishuGroupId(value: string): boolean {
  return /^oc_[A-Za-z0-9]/.test(value);
}

// 将授权条目转换为前端展示模型，优先返回可读名称。
function toAuthorizedEntryView(kind: "user" | "group", id: string, aliases: FeishuAliasStore): FeishuAuthorizedEntryView {
  const trimmedId = String(id ?? "").trim();
  const aliasName = kind === "user" ? aliases.users[trimmedId] : aliases.groups[trimmedId];
  if (aliasName) {
    return { kind, id: trimmedId, name: aliasName };
  }

  if (kind === "user" && !looksLikeFeishuUserId(trimmedId)) {
    return { kind, id: trimmedId, name: trimmedId };
  }
  if (kind === "group" && !looksLikeFeishuGroupId(trimmedId)) {
    return { kind, id: trimmedId, name: trimmedId };
  }
  return { kind, id: trimmedId, name: "" };
}

// 授权条目排序：优先按可读名称，再按原始 ID。
function compareAuthorizedEntry(a: FeishuAuthorizedEntryView, b: FeishuAuthorizedEntryView): number {
  const aLabel = (a.name || a.id).toLowerCase();
  const bLabel = (b.name || b.id).toLowerCase();
  const byLabel = aLabel.localeCompare(bLabel, "en");
  if (byLabel !== 0) return byLabel;
  return a.id.localeCompare(b.id, "en");
}

// 读取飞书授权别名（用于把 ID 显示成用户/群聊名称）。
function readFeishuAliasStore(): FeishuAliasStore {
  const filePath = path.join(resolveUserStateDir(), "credentials", FEISHU_ALIAS_STORE_FILE);
  if (!fs.existsSync(filePath)) {
    return { version: 1, users: {}, groups: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = parseJsonSafe(raw);
    const users = parsed && typeof parsed.users === "object" && !Array.isArray(parsed.users)
      ? Object.fromEntries(
          Object.entries(parsed.users).map(([id, name]) => [String(id).trim(), String(name ?? "").trim()])
        )
      : {};
    const groups = parsed && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)
      ? Object.fromEntries(
          Object.entries(parsed.groups).map(([id, name]) => [String(id).trim(), String(name ?? "").trim()])
        )
      : {};
    return {
      version: 1,
      users: Object.fromEntries(Object.entries(users).filter(([id, name]) => id && name)),
      groups: Object.fromEntries(Object.entries(groups).filter(([id, name]) => id && name)),
    };
  } catch {
    return { version: 1, users: {}, groups: {} };
  }
}

// 写入飞书授权别名存储。
function writeFeishuAliasStore(store: FeishuAliasStore): void {
  const dir = path.join(resolveUserStateDir(), "credentials");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, FEISHU_ALIAS_STORE_FILE);
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

// 保存单条飞书授权别名，供列表展示优先使用名称。
function saveFeishuAlias(kind: "user" | "group", id: string, name: string): void {
  const trimmedId = String(id ?? "").trim();
  const trimmedName = String(name ?? "").trim();
  if (!trimmedId || !trimmedName) return;
  const store = readFeishuAliasStore();
  if (kind === "user") {
    store.users[trimmedId] = trimmedName;
  } else {
    store.groups[trimmedId] = trimmedName;
  }
  writeFeishuAliasStore(store);
}

// 删除单条飞书授权别名。
function removeFeishuAlias(kind: "user" | "group", id: string): void {
  const trimmedId = String(id ?? "").trim();
  if (!trimmedId) return;
  const store = readFeishuAliasStore();
  if (kind === "user") {
    delete store.users[trimmedId];
  } else {
    delete store.groups[trimmedId];
  }
  writeFeishuAliasStore(store);
}