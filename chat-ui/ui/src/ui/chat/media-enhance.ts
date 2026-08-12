/**
 * 历史消息 `MEDIA:<路径>` 本地图片渲染（R10 遗留清理，应用户要求落地）：
 * 旧版消息以 `MEDIA:C:\...\file.png` 纯文本形式引用本地图片，此前仅显示为路径链接。
 * 两段式实现（页面本身即 file:// 协议，可直读本地图片）：
 *   1) renderMediaMarkers —— 字符串层：sanitize 之后、linkify 之前把 MEDIA 标记替换为
 *      <img class="chat-local-media" src="file:///...">（必须先于 path-linker，否则路径被拆进 <a>）；
 *   2) enhanceMedia —— DOM 层：为已注入的 img 挂加载失败回退与点击全屏预览。
 * 与代码块/公式增强同模式：不动 marked/DOMPurify 管线、幂等。
 */

// MEDIA 标记：支持带引号路径与裸路径
export const MEDIA_RE = /MEDIA:\s*(?:"([^"\n]+)"|([^\s"'<>|]+))/g;

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;

export function looksLikeImagePath(path: string): boolean {
  return path.includes("/") || path.includes("\\") || IMG_EXT_RE.test(path);
}

// 本地路径 → file:// URL（Windows 盘符 / Unix 绝对路径；不识别 ~ 开头路径，返回 null）
export function localPathToFileUrl(path: string): string | null {
  let p = path.trim();
  if (!p || p.startsWith("~")) {
    return null;
  }
  p = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(p)) {
    p = "/" + p;
  } else if (!p.startsWith("/")) {
    return null; // 相对路径无法可靠解析
  }
  const encoded = p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  // 盘符冒号被 encodeURIComponent 转成 %3A，恢复为 file:///C:/ 规范形态
  return "file://" + encoded.replace(/^\/([A-Za-z])%3A/, "/$1:");
}

interface MediaMatch {
  full: string;
  index: number;
  path: string;
}

// 从文本中提取第一个可渲染的 MEDIA 标记（裸路径按图片扩展名截断尾随非空白文本；不合法跳过继续）
export function extractMediaMatch(text: string): MediaMatch | null {
  MEDIA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_RE.exec(text)) !== null) {
    let path = (m[1] ?? m[2] ?? "").trim();
    let full = m[0];
    const extMatch = path.match(/^(.*?\.(png|jpe?g|gif|webp|bmp|svg|ico))/i);
    if (extMatch && extMatch[1].length < path.length) {
      path = extMatch[1];
      full = m[0].slice(0, m[0].length - (m[1] ?? m[2] ?? "").trim().length + path.length);
    }
    if (path && looksLikeImagePath(path)) {
      return { full, index: m.index, path };
    }
  }
  return null;
}

// 匹配位置是否位于 <pre>...</pre> 内（代码块里的 MEDIA 字样不渲染）
function isInsidePre(html: string, at: number): boolean {
  const before = html.slice(0, at);
  const lastOpen = before.lastIndexOf("<pre");
  if (lastOpen === -1) {
    return false;
  }
  const lastClose = before.lastIndexOf("</pre>");
  return lastOpen > lastClose;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 字符串层：把 sanitized HTML 中的 MEDIA 标记替换为 <img>。
 * 必须在 linkifyPaths 之前调用（否则路径已被拆进 <a>）。
 */
export function renderMediaMarkers(html: string): string {
  if (!html.includes("MEDIA:")) {
    return html;
  }
  return html.replace(MEDIA_RE, (match, _q, _b, offset) => {
    if (isInsidePre(html, offset)) {
      return match;
    }
    const parsed = extractMediaMatch(match);
    if (!parsed) {
      return match;
    }
    const url = localPathToFileUrl(parsed.path);
    if (!url) {
      return match;
    }
    const src = escapeAttr(url);
    const alt = escapeAttr(parsed.path);
    return `<img class="chat-local-media" src="${src}" alt="${alt}" title="${alt}" data-media-text="${escapeAttr(parsed.full)}" loading="lazy">`;
  });
}

// ── DOM 层行为：失败回退 + 点击全屏预览（ref 回调链调用，幂等）──

function buildLightbox(src: string) {
  const overlay = document.createElement("div");
  overlay.className = "chat-media-lightbox";
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  overlay.appendChild(img);
  overlay.addEventListener("click", () => overlay.remove());
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

export function enhanceMedia(container: Element | undefined) {
  if (!container) {
    return;
  }
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>("img.chat-local-media"))) {
    if (img.dataset.mediaBound === "1") {
      continue;
    }
    img.dataset.mediaBound = "1";
    img.addEventListener("error", () => {
      // 文件不存在/不可读：回退为原始标记文本（保持历史行为，不丢信息）
      if (!img.isConnected) {
        return;
      }
      const fallback = document.createElement("span");
      fallback.className = "chat-local-media-fallback";
      fallback.textContent = img.dataset.mediaText || img.alt || "";
      img.replaceWith(fallback);
    });
    img.addEventListener("click", () => {
      if (img.src) {
        buildLightbox(img.src);
      }
    });
  }
}
