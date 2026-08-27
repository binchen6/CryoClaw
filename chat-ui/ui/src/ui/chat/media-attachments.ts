/**
 * 已发送附件元数据消费（纯函数，node 下可单测）。
 *
 * 内核 chat.send 收到 base64 附件后会把非图片 mime offload 到 media store
 * （<stateDir>/media/inbound/<原文件名>---<uuid>.<ext>），transcript user 消息带顶层
 * `MediaPath/MediaPaths/MediaType/MediaTypes`；chat.history 原样透传。
 * chat.ts 的乐观气泡也挂同构字段（值为本地原始 filePath），
 * grouped-render.ts 据此渲染附件卡片（历史与乐观气泡同构）。
 */

export type MessageMediaAttachment = {
  /** 文件路径（历史：media store 路径；乐观气泡：本地原始路径） */
  path: string;
  /** mime（MediaTypes 平行数组对应项；缺失/空串 → undefined） */
  mimeType?: string;
  /** 展示文件名（路径 basename，media store id 剥掉 ---<uuid> 段还原原名） */
  fileName: string;
};

// 内核 media store 文件名形如 `name---<uuid>.<ext>`，剥掉 ---<uuid> 段还原原名
const MEDIA_UUID_RE = /---[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?=\.[^./\\]*$|$)/i;

export function restoreMediaFileName(fileName: string): string {
  return fileName.replace(MEDIA_UUID_RE, "");
}

export function mediaPathBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function isImageMime(mimeType?: string): boolean {
  return Boolean(mimeType && /^image\//i.test(mimeType));
}

// 从消息顶层提取附件列表；兼容单数 MediaPath/MediaType 与复数 MediaPaths/MediaTypes。
// MediaTypes 与 MediaPaths 按下标平行对应，缺项/非字符串按 undefined 处理。
export function extractMessageMediaAttachments(message: unknown): MessageMediaAttachment[] {
  if (typeof message !== "object" || message === null) {
    return [];
  }
  const m = message as Record<string, unknown>;
  const rawPaths: unknown[] = Array.isArray(m.MediaPaths)
    ? m.MediaPaths
    : typeof m.MediaPath === "string"
      ? [m.MediaPath]
      : [];
  const rawTypes: unknown[] = Array.isArray(m.MediaTypes)
    ? m.MediaTypes
    : typeof m.MediaType === "string"
      ? [m.MediaType]
      : [];
  const out: MessageMediaAttachment[] = [];
  for (let i = 0; i < rawPaths.length; i++) {
    const p = rawPaths[i];
    if (typeof p !== "string" || !p.trim()) {
      continue;
    }
    const rawType = rawTypes[i];
    const mimeType = typeof rawType === "string" && rawType ? rawType : undefined;
    out.push({ path: p, mimeType, fileName: restoreMediaFileName(mediaPathBaseName(p)) });
  }
  return out;
}
