/**
 * 托管图片解析（阶段 18）。
 *
 * 内核取证（managed-image-attachments）：助手消息里的图片 block 形如
 * `{ type:"image", url:"/api/chat/media/outgoing/<sessionKey>/<id>/full", openUrl, ... }`，
 * url 是网关 HTTP server 的相对路径，且该端点强制 `Authorization: Bearer <token>` 头
 * （只认 header），file:// 渲染层的 <img src> 无法携带——必须先 fetch 转 blob object URL。
 *
 * 凭证优先级与 WS 连接一致：设备 token（operator 角色，含 chat.history scope）→ 共享 token。
 */

import { loadDeviceAuthToken } from "../device-auth.ts";
import { loadOrCreateDeviceIdentity } from "../device-identity.ts";

export type ManagedMediaConfig = {
  /** 网关 HTTP origin（由 ws(s):// 换算成 http(s)://） */
  httpOrigin: string;
  /** 共享 token 兜底（settings.token） */
  sharedToken?: string;
};

let config: ManagedMediaConfig | null = null;

export function configureManagedMedia(cfg: ManagedMediaConfig | null) {
  config = cfg;
}

/** 网关 WS URL → HTTP origin */
export function wsUrlToHttpOrigin(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) {
    return `https://${wsUrl.slice("wss://".length)}`;
  }
  if (wsUrl.startsWith("ws://")) {
    return `http://${wsUrl.slice("ws://".length)}`;
  }
  return wsUrl;
}

/** 是否为网关托管媒体相对路径（需鉴权 fetch） */
export function isManagedMediaUrl(url: string): boolean {
  return url.startsWith("/api/chat/media/");
}

export function toAbsoluteMediaUrl(url: string): string {
  if (!isManagedMediaUrl(url) || !config) {
    return url;
  }
  return `${config.httpOrigin}${url}`;
}

// object URL 缓存：绝对 URL → object URL；上限防泄漏（LRU -ish：满即清空重建，规模小可接受）
const MAX_CACHE = 100;
const objectUrlCache = new Map<string, string>();
const pendingFetches = new Map<string, Promise<string | null>>();
// 代际计数：reset 时递增。在途 fetch 落地前校验代际，过期结果立即 revoke 不写缓存，
// 避免 reset 后晚到的在途任务把 object URL 写回缓存造成泄漏。
let mediaGeneration = 0;

async function resolveBearerToken(): Promise<string | null> {
  try {
    const identity = await loadOrCreateDeviceIdentity();
    const deviceToken = loadDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
    })?.token;
    return deviceToken ?? config?.sharedToken ?? null;
  } catch {
    return config?.sharedToken ?? null;
  }
}

/**
 * 拉取托管图片并返回可渲染的 object URL；失败返回 null。
 * 同一绝对 URL 只拉一次（缓存），并发请求合并。
 */
export async function fetchManagedImageObjectUrl(url: string): Promise<string | null> {
  const absolute = toAbsoluteMediaUrl(url);
  const cached = objectUrlCache.get(absolute);
  if (cached) {
    return cached;
  }
  const pending = pendingFetches.get(absolute);
  if (pending) {
    return pending;
  }
  const generation = mediaGeneration;
  const task = (async (): Promise<string | null> => {
    try {
      const token = await resolveBearerToken();
      const res = await fetch(absolute, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        return null;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      // reset 发生过的代际：缓存已清空，写回即泄漏，直接 revoke 丢弃
      if (generation !== mediaGeneration) {
        URL.revokeObjectURL(objectUrl);
        return null;
      }
      if (objectUrlCache.size >= MAX_CACHE) {
        // 逐出最旧一条（Map 迭代序即插入序）：旧策略是满 100 全清，会把仍在
        // DOM <img> 上引用的 URL 一次性作废，后续组件重建触发最多 100 张的
        // 批量 refetch（网关瞬时压力与内存峰值）；逐出最旧把冲击摊平为单个。
        const oldest = objectUrlCache.keys().next();
        if (!oldest.done) {
          const oldestUrl = objectUrlCache.get(oldest.value);
          if (oldestUrl) {
            URL.revokeObjectURL(oldestUrl);
          }
          objectUrlCache.delete(oldest.value);
        }
      }
      objectUrlCache.set(absolute, objectUrl);
      return objectUrl;
    } catch {
      return null;
    } finally {
      pendingFetches.delete(absolute);
    }
  })();
  pendingFetches.set(absolute, task);
  return task;
}

/** 测试与断连重连时用：清空缓存与配置 */
export function resetManagedMedia() {
  mediaGeneration += 1;
  for (const old of objectUrlCache.values()) {
    URL.revokeObjectURL(old);
  }
  objectUrlCache.clear();
  pendingFetches.clear();
  config = null;
}
