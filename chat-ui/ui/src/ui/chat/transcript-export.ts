/**
 * transcript-export.ts — 整会话记录导出（双内核兼容）。
 *
 * 优先走内核 transcripts.get（openclaw ≥2026.9.2 提供的 canonical 转录，
 * 含内核侧元数据）；方法不存在（2026.8.2）或失败时回退为本地历史序列化。
 * 输出同时进剪贴板并触发 .md 文件下载。
 */
import type { GatewayBrowserClient } from "../gateway.ts";

export type TranscriptMessage = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  cryoclawError?: unknown;
  cryoclawPartial?: unknown;
};

export type TranscriptSessionMeta = {
  key: string;
  label?: string | null;
};

function extractRole(message: TranscriptMessage): string {
  const role = message.role;
  return typeof role === "string" && role.trim() ? role.trim() : "unknown";
}

function extractMessageText(message: TranscriptMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function formatTimestamp(ts: unknown): string {
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    }
  }
  return "";
}

/** 纯函数：把本地历史消息序列化为 markdown 转录。 */
export function buildTranscriptMarkdown(
  session: TranscriptSessionMeta,
  messages: TranscriptMessage[],
  exportedAt = Date.now(),
): string {
  const headerLines = [
    "# " + (session.label?.trim() || session.key),
    "",
    "- Session: `" + session.key + "`",
    "- Messages: " + messages.length,
    "- Exported: " + formatTimestamp(exportedAt),
    "",
    "---",
    "",
  ];
  const body = messages.map((message) => {
    const role = extractRole(message);
    const text = extractMessageText(message).trim();
    const time = formatTimestamp(message.timestamp);
    const tags: string[] = [];
    if (message.cryoclawError) tags.push("error");
    if (message.cryoclawPartial) tags.push("partial");
    const tagText = tags.length ? " `" + tags.join(",") + "`" : "";
    const timeText = time ? " · " + time : "";
    if (!text) return "";
    return "## " + role + tagText + timeText + "\n\n" + text;
  });
  return headerLines.join("\n") + body.filter(Boolean).join("\n\n---\n\n") + "\n";
}

/** 特性探测：≥2026.9.2 的 transcripts.get；8.2 返回 method not found → null（回退本地序列化）。 */
export async function tryFetchKernelTranscript(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<string | null> {
  try {
    const res = await client.request<{ transcript?: unknown }>("transcripts.get", {
      sessionKey,
      format: "markdown",
    });
    if (res && typeof res.transcript === "string" && res.transcript.trim()) {
      return res.transcript;
    }
    return null;
  } catch {
    return null;
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (!text || typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 触发 .md 下载（file:// 下 a[download] 可用；失败静默——剪贴板兜底）。 */
export function downloadMarkdownFile(filename: string, text: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 文件名：会话标签（清洗）+ 日期；非法字符替换为 -。 */
export function buildTranscriptFilename(label: string | null | undefined, key: string, now = new Date()): string {
  const base = (label?.trim() || key).replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60) || "session";
  const date = now.toISOString().slice(0, 10);
  return "transcript-" + base + "-" + date + ".md";
}
