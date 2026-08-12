/**
 * 历史消息 `MEDIA:<路径>` 本地图片渲染（R10 遗留清理，应用户要求落地）：
 * 旧版消息以 `MEDIA:C:\...\file.png` 纯文本形式引用本地图片，此前仅显示为路径链接。
 * 本模块在 DOM 层识别该标记并渲染为 <img>（file:// 直读，页面本身即 file:// 协议），
 * 加载失败回退为原始文本；点击图片可全屏预览。与代码块/公式增强同模式：
 * DOM 后处理、不动 marked/DOMPurify 管线、幂等。
 */

// MEDIA 标记：支持带引号路径与裸路径（裸路径需含目录分隔符或图片扩展名，防误判）
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

// 提取文本中第一个可渲染的 MEDIA 标记（不合法的候选跳过继续找）
export function extractMediaMatch(text: string): MediaMatch | null {
  MEDIA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_RE.exec(text)) !== null) {
    let path = (m[1] ?? m[2] ?? "").trim();
    let full = m[0];
    // 裸路径候选可能吞掉尾随非空白文本（如中文）：按图片扩展名截断
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

function buildMediaImage(path: string, originalText: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "chat-local-media";
  img.src = localPathToFileUrl(path) ?? "";
  img.alt = path;
  img.title = path;
  img.loading = "lazy";
  img.addEventListener("error", () => {
    // 文件不存在/不可读：回退为原始文本（保持历史行为，不丢信息）
    if (!img.isConnected) {
      return;
    }
    const fallback = document.createElement("span");
    fallback.className = "chat-local-media-fallback";
    fallback.textContent = originalText;
    img.replaceWith(fallback);
  });
  img.addEventListener("click", () => {
    if (img.src) {
      buildLightbox(img.src);
    }
  });
  return img;
}

function collectTextNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    if (text.nodeValue && text.nodeValue.includes("MEDIA:")) {
      const parent = text.parentElement;
      if (parent && !parent.closest("pre, code, button, .chat-code-copy, .chat-code-lang, .chat-math, .chat-local-media-fallback")) {
        nodes.push(text);
      }
    }
    node = walker.nextNode();
  }
  return nodes;
}

function processTextNode(text: Text) {
  let current: Text | null = text;
  let guard = 0;
  while (current && guard++ < 30) {
    const value = current.nodeValue ?? "";
    const match = extractMediaMatch(value);
    if (!match) {
      return;
    }
    const url = localPathToFileUrl(match.path);
    const parent = current.parentNode;
    if (!parent) {
      return;
    }
    const start = match.index;
    const end = start + match.full.length;
    const after = current.splitText(end);
    const before = current.splitText(start);
    if (url) {
      parent.replaceChild(buildMediaImage(match.path, match.full), before);
    } else {
      // 无法转 file URL（~ / 相对路径）：保留原文，跳过继续
      current = after;
      continue;
    }
    current = after;
  }
}

export function enhanceMedia(container: Element | undefined) {
  if (!container) {
    return;
  }
  if (!container.textContent || !container.textContent.includes("MEDIA:")) {
    return;
  }
  const candidates = collectTextNodes(container).filter((n) => extractMediaMatch(n.nodeValue ?? "") !== null);
  for (const text of candidates) {
    if (text.isConnected) {
      processTextNode(text);
    }
  }
}
