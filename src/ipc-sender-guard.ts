/**
 * ipc-sender-guard.ts — 渲染层 IPC 调用来源校验
 *
 * 安全面：preload 暴露的 IPC 方法理论上只应被 CryoClaw 自家 Chat UI 调用。
 * 若渲染层被 XSS / 异常页面 / 外部加载内容劫持，未校验来源的 ipcMain
 * 处理器可能被滥用（任意文件读取、网关控制、内核换装、系统打开路径等）。
 *
 * 本模块提供统一的可信 sender 判定：sender 主 frame 的 URL 必须指向
 * Chat UI 的 index.html（file://，允许 ?query 与 #hash 后缀）。
 * 开发环境与打包环境共用同一判定（resolveChatUiPath 已适配两种形态）。
 */

import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { resolveChatUiPath } from "./constants";
import * as log from "./logger";

let cachedPrefix: string | null = null;

// Chat UI 的合法入口：index.html（初始加载）+ 路由 pathname。
// renderer 的 history API 会把 URL 从 /dist/index.html 改写为 /dist/<route>
// （如 /dist/chat?session=...），sender guard 必须容忍这些合法路由。
// 注意：本白名单只保留当前仍然存在的视图路由（chat/setup/settings/skills/
// workspace/cron/tasks）。历史路由 sessions/agents/overview/channels/
// instances/usage/nodes/config/debug/logs 与已删除的 feedback 视图已从 Chat UI
// 移除，且主进程唯一的
// 加载入口（window.ts → buildChatUiEntryUrl）永远只指向 index.html，
// 旧路由没有残留注入入口，故从白名单移除以收紧可信面。
const KNOWN_CHAT_UI_ENTRIES = new Set([
  "index.html",
  "chat", "settings", "setup", "workspace", "tasks", "skills", "cron",
]);

/** Chat UI dist 目录的 file:// 前缀（进程内不变，缓存避免重复计算），尾部带 / */
export function chatUiEntryUrlPrefix(): string {
  if (cachedPrefix === null) {
    const dir = path.dirname(resolveChatUiPath());
    cachedPrefix = pathToFileURL(dir).href.replace(/\/?$/, "/");
  }
  return cachedPrefix;
}

/**
 * 纯函数：URL 是否属于可信 Chat UI 入口。
 *
 * prefix 为 chat-ui/dist 目录前缀；允许的结构：
 *   <prefix>[<base>/]<entry>[?query][#hash]
 * 其中 entry 必须是 KNOWN_CHAT_UI_ENTRIES 之一（index.html 或路由名），
 * base 最多 1 段（部署 base 路径），拒绝 /../ 与多余路径段，
 * 保证任意非 Chat UI 页面（同盘其它目录 / 远程页面 / 伪装文件）都被拒绝。
 */
export function isTrustedChatUiUrl(url: string, prefix: string): boolean {
  if (!url.startsWith(prefix)) return false;
  const rest = url.slice(prefix.length);
  const pathPart = rest.split(/[?#]/, 1)[0];
  if (!pathPart || pathPart.includes("..")) return false;
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return false;
  const entry = segments.length === 1 ? segments[0] : segments[1];
  if (!KNOWN_CHAT_UI_ENTRIES.has(entry)) return false;
  const after = rest.slice(pathPart.length);
  return after === "" || after.startsWith("?") || after.startsWith("#");
}

/** sender 主 frame 是否指向 CryoClaw Chat UI（file:// 入口 + ?query/#hash） */
export function isTrustedIpcSenderFrame(frame: Electron.WebFrameMain | null | undefined): boolean {
  if (!frame || typeof frame.url !== "string") return false;
  return isTrustedChatUiUrl(frame.url, chatUiEntryUrlPrefix());
}

/**
 * 校验 IPC 调用来源；不可信时记录错误并返回 false。
 * - ipcMain.handle 处理器：返回 false 时应抛错拒绝（渲染层得到 rejected promise）
 * - ipcMain.on 处理器：返回 false 时应直接 return（无返回值语义）
 */
export function assertTrustedIpcSender(
  event: { senderFrame?: Electron.WebFrameMain | null },
  channel: string,
): boolean {
  const ok = isTrustedIpcSenderFrame(event.senderFrame);
  if (!ok) {
    const rawFrameUrl = event.senderFrame?.url ?? "(no frame)";
    // 日志脱敏：frame URL 的 query/hash 可能携带 token 等敏感参数，只保留 origin+pathname
    let frameUrl = rawFrameUrl;
    try {
      const u = new URL(rawFrameUrl);
      u.search = "";
      u.hash = "";
      frameUrl = u.href;
    } catch {
      frameUrl = rawFrameUrl.split(/[?#]/, 1)[0];
    }
    log.error(`[ipc-guard] 拒绝非可信 sender 的 IPC 调用 channel=${channel} frame=${frameUrl}`);
  }
  return ok;
}
