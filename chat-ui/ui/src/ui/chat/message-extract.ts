import { stripThinkingTags } from "../format.ts";
import { t } from "../i18n.ts";

const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/;
const ENVELOPE_CHANNELS = [
  "WebChat",
  "WhatsApp",
  "Telegram",
  "Signal",
  "Slack",
  "Discord",
  "iMessage",
  "Teams",
  "Matrix",
  "Zalo",
  "Zalo Personal",
  "BlueBubbles",
];

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

function looksLikeEnvelopeHeader(header: string): boolean {
  // 真实网关信封头始终以频道名开头（取证：网关 formatAgentEnvelope 产出
  // `[<Channel> <from?> <host?> <ip?> <ts?>] body`，频道名是 parts[0]），
  // 频道名是最强特征。
  if (ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `))) {
    return true;
  }
  // 时间戳形态收紧为「带秒」：网关时间戳 displaySeconds: true（如
  // `[2026-01-12 12:19:17]`），用户手打的 `[2024-01-01 12:00] 提醒我…`
  // 不带秒，据此区分，避免误剥用户消息前缀。
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\b/.test(header)) {
    return true;
  }
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/.test(header)) {
    return true;
  }
  return false;
}

export function stripEnvelope(text: string): string {
  const match = text.match(ENVELOPE_PREFIX);
  if (!match) {
    return text;
  }
  const header = match[1] ?? "";
  if (!looksLikeEnvelopeHeader(header)) {
    return text;
  }
  return text.slice(match[0].length);
}

export function extractText(message: unknown): string | null {
  const raw = extractRawText(message);
  if (raw === null) {
    return null;
  }
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  return role === "assistant" ? stripThinkingTags(raw) : stripEnvelope(raw);
}

export function extractTextCached(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return extractText(message);
  }
  const obj = message;
  if (textCache.has(obj)) {
    return textCache.get(obj) ?? null;
  }
  const value = extractText(message);
  textCache.set(obj, value);
  return value;
}

export function extractThinking(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      const item = p as Record<string, unknown>;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        const cleaned = item.thinking.trim();
        if (cleaned) {
          parts.push(cleaned);
        }
      }
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }

  // Back-compat: older logs may still have <think> tags inside text blocks.
  const rawText = extractRawText(message);
  if (!rawText) {
    return null;
  }
  const matches = [
    ...rawText.matchAll(/<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi),
  ];
  const extracted = matches.map((m) => (m[1] ?? "").trim()).filter(Boolean);
  return extracted.length > 0 ? extracted.join("\n") : null;
}

export function extractThinkingCached(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return extractThinking(message);
  }
  const obj = message;
  if (thinkingCache.has(obj)) {
    return thinkingCache.get(obj) ?? null;
  }
  const value = extractThinking(message);
  thinkingCache.set(obj, value);
  return value;
}

// 提取 content 数组中的 text 块并拼接（extractRawText / extractText 共用）。
function collectContentText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((p) => {
      const item = p as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      return null;
    })
    .filter((v): v is string => typeof v === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

export function extractRawText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") {
    return content;
  }
  const joined = collectContentText(content);
  if (joined !== null) {
    return joined;
  }
  if (typeof m.text === "string") {
    return m.text;
  }
  return null;
}

export function formatReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `_${line}_`);
  return lines.length ? [t("chat.reasoningLabel"), ...lines].join("\n") : "";
}
