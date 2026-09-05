/**
 * 历史消息 `MEDIA:<路径>` 本地文件渲染（R23 扩展为图片 + 文件卡片两段式）：
 * 旧版消息以 `MEDIA:C:\...\file.png` 纯文本形式引用本地文件，此前仅图片可渲染。
 * 两段式实现（页面本身即 file:// 协议，可直读本地图片）：
 *   1) renderMediaMarkers —— 字符串层：sanitize 之后、linkify 之前把 MEDIA 标记替换为
 *      `<img class="chat-local-media">`（图片）或 `<div class="chat-file-card">`（其他文件，
 *      点击打开 + 「在文件夹中显示」按钮）；必须先于 path-linker，否则路径被拆进 <a>；
 *   2) enhanceMedia —— DOM 层：为已注入的 img 挂加载失败回退与点击全屏预览；
 *      为文件卡片挂 document 级事件委托（打开/定位）。
 * 与代码块/公式增强同模式：不动 marked/DOMPurify 管线、幂等。
 *
 * 文件卡片图标：CryoIcons 自绘内联 SVG（24x24 / 2px 描边 / currentColor），按扩展名类别区分。
 */

import * as ipc from "../data/ipc-bridge.ts";
import { t } from "../i18n.ts";
import { showToastGlobal } from "../app-toast.ts";
import { ref } from "lit/directives/ref.js";

// MEDIA 标记：支持带引号路径与裸路径
export const MEDIA_RE = /MEDIA:\s*(?:"([^"\n]+)"|([^\s"'<>|]+))/g;

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;

// 文件卡片支持的常见后缀（与主进程 safe-open 白名单对齐并扩充开发类文件；
// 白名单外的后缀卡片仍可渲染与定位，点击打开会被主进程拒绝并 toast 提示）。
export const FILE_CARD_EXTS = [
  // 文档
  "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "log",
  // 表格
  "xls", "xlsx", "csv", "tsv", "ods",
  // 演示
  "ppt", "pptx", "odp",
  // 压缩包
  "zip", "rar", "7z", "tar", "gz", "bz2",
  // 音频 / 视频
  "mp3", "wav", "flac", "aac", "ogg", "m4a",
  "mp4", "mkv", "webm", "avi", "mov", "m4v", "mpg", "mpeg",
  // 代码 / 配置
  "py", "js", "ts", "tsx", "jsx", "json", "sh", "bat", "ps1",
  "html", "css", "xml", "yml", "yaml", "toml",
] as const;

const FILE_CARD_EXT_SET = new Set<string>(FILE_CARD_EXTS);

// 裸路径截断用的已知扩展名联合（图片 + 文件卡片）；
// 交替项按长度降序，避免 xls 抢先匹配 xlsx、mpg 抢先 mpeg
const KNOWN_EXT_RE = new RegExp(
  `^(.*?\\.(png|jpe?g|gif|webp|bmp|svg|ico|${[...FILE_CARD_EXTS].sort((a, b) => b.length - a.length).join("|")}))`,
  "i",
);

export function isImageExt(path: string): boolean {
  return IMG_EXT_RE.test(path);
}

export function fileExtOf(path: string): string {
  const m = path.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

export function looksLikeImagePath(path: string): boolean {
  return path.includes("/") || path.includes("\\") || IMG_EXT_RE.test(path);
}

// 图片或已知文件后缀都视为可渲染媒体路径
export function looksLikeFileOrImagePath(path: string): boolean {
  return (
    path.includes("/") ||
    path.includes("\\") ||
    IMG_EXT_RE.test(path) ||
    FILE_CARD_EXT_SET.has(fileExtOf(path))
  );
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

// 从文本中提取第一个可渲染的 MEDIA 标记（裸路径按已知扩展名截断尾随非空白文本；不合法跳过继续）
export function extractMediaMatch(text: string): MediaMatch | null {
  MEDIA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_RE.exec(text)) !== null) {
    let path = (m[1] ?? m[2] ?? "").trim();
    let full = m[0];
    const extMatch = path.match(KNOWN_EXT_RE);
    if (extMatch && extMatch[1].length < path.length) {
      path = extMatch[1];
      full = m[0].slice(0, m[0].length - (m[1] ?? m[2] ?? "").trim().length + path.length);
    }
    if (path && looksLikeFileOrImagePath(path)) {
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

// ── 文件卡片图标（CryoIcons 自绘，与 icons.ts 同一规范）──

const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

// 文档外形（折角）
const FILE_OUTLINE = '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"></path><path d="M13.5 3v5.5H19"></path>';

const ICON_BY_CATEGORY: Record<string, string> = {
  // 文本：两行内容
  text: `${FILE_OUTLINE}<path d="M9 12.5h6"></path><path d="M9 16h6"></path>`,
  // 表格：四格
  sheet: `${FILE_OUTLINE}<path d="M8.5 12.5h2"></path><path d="M13.5 12.5h2"></path><path d="M8.5 16h2"></path><path d="M13.5 16h2"></path>`,
  // 压缩包：拉链 + 拉头
  archive: `${FILE_OUTLINE}<path d="M12 9.5V11"></path><path d="M12 13v1.5"></path><circle cx="12" cy="17.2" r="1.6"></circle>`,
  // 代码：一对尖括号
  code: `${FILE_OUTLINE}<path d="m10.2 12-2.2 2.3 2.2 2.2"></path><path d="m14.3 12 2.2 2.3-2.2 2.2"></path>`,
  // 音频：耳机
  audio: `${FILE_OUTLINE}<path d="M8.8 18.2v-1a3.2 3.2 0 0 1 6.4 0v1"></path><path d="M8.8 17.2H8a.9.9 0 0 0-.9.9v.7a.9.9 0 0 0 .9.9h.8z"></path><path d="M15.2 17.2h.8a.9.9 0 0 1 .9.9v.7a.9.9 0 0 1-.9.9h-.8z"></path>`,
  // 视频：播放三角
  video: `${FILE_OUTLINE}<path d="M10.5 12.2l4.5 2.6-4.5 2.6z"></path>`,
  // 通用文档
  generic: FILE_OUTLINE,
};

const FOLDER_OPEN_ICON = '<path d="M3.5 18V6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v1"></path><path d="m3.5 18 2-6.5A1.5 1.5 0 0 1 7 10h13.5a1.5 1.5 0 0 1 1.4 2l-2 6.5a1.5 1.5 0 0 1-1.4 1H5A1.5 1.5 0 0 1 3.5 18z"></path>';

export function fileCategoryOf(ext: string): string {
  switch (ext) {
    case "pdf": case "doc": case "docx": case "odt": case "rtf":
    case "txt": case "md": case "markdown": case "log":
    case "ppt": case "pptx": case "odp":
      return "text";
    case "xls": case "xlsx": case "csv": case "tsv": case "ods":
      return "sheet";
    case "zip": case "rar": case "7z": case "tar": case "gz": case "bz2":
      return "archive";
    case "py": case "js": case "ts": case "tsx": case "jsx": case "json":
    case "sh": case "bat": case "ps1": case "html": case "css":
    case "xml": case "yml": case "yaml": case "toml":
      return "code";
    case "mp3": case "wav": case "flac": case "aac": case "ogg": case "m4a":
      return "audio";
    case "mp4": case "mkv": case "webm": case "avi": case "mov":
    case "m4v": case "mpg": case "mpeg":
      return "video";
    default:
      return "generic";
  }
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// 文件卡片（字符串层产物）：点击卡片主体打开文件，右侧按钮在文件夹中显示。
// 根元素用 <span>：替换点位于 marked 生成的 <p> 内，<div> 会触发隐式闭合段落（phrasing content 合法性）。
export function buildFileCardHtml(path: string, fullMatch: string): string {
  const ext = fileExtOf(path);
  const icon = SVG_OPEN + (ICON_BY_CATEGORY[fileCategoryOf(ext)] ?? ICON_BY_CATEGORY.generic) + "</svg>";
  const revealIcon = SVG_OPEN + FOLDER_OPEN_ICON + "</svg>";
  return (
    `<span class="chat-file-card" role="button" tabindex="0" ` +
    `aria-label="${escapeAttr(t("chat.fileCard.openLabel"))}: ${escapeAttr(fileNameOf(path))}" ` +
    `data-file-path="${escapeAttr(path)}" data-file-ext="${escapeAttr(ext)}" ` +
    `data-media-text="${escapeAttr(fullMatch)}" title="${escapeAttr(path)}">` +
    `<span class="chat-file-card__icon" aria-hidden="true">${icon}</span>` +
    `<span class="chat-file-card__info">` +
    `<span class="chat-file-card__name">${escapeAttr(fileNameOf(path))}</span>` +
    `<span class="chat-file-card__meta">${escapeAttr(ext.toUpperCase() || "FILE")}</span>` +
    `</span>` +
    `<button class="chat-file-card__reveal" data-file-reveal="1" type="button" ` +
    `title="${escapeAttr(t("chat.fileCard.reveal"))}" aria-label="${escapeAttr(t("chat.fileCard.reveal"))}">${revealIcon}</button>` +
    `</span>`
  );
}

/**
 * 字符串层：把 sanitized HTML 中的 MEDIA 标记替换为 <img>（图片）或文件卡片（其他文件）。
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
    if (!isImageExt(parsed.path) && FILE_CARD_EXT_SET.has(fileExtOf(parsed.path))) {
      return buildFileCardHtml(parsed.path, parsed.full);
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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
    }
  };
  // 关闭时同步移除 keydown 监听（点击关闭路径原先泄漏监听器，
  // 会残留到用户下次按 Escape 才自清理）
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

// 点击用 document 级事件委托：lit 流式重渲染会重建元素，
// 逐元素绑定会丢监听；委托与时序解耦，始终生效。
let clickDelegateInstalled = false;
function ensureClickDelegate() {
  if (clickDelegateInstalled) {
    return;
  }
  clickDelegateInstalled = true;
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") {
      return;
    }
    // 文件卡片：定位按钮优先，其次整卡打开
    const card = target.closest(".chat-file-card") as HTMLElement | null;
    if (card) {
      const path = card.dataset.filePath ?? "";
      if (!path) {
        return;
      }
      if (target.closest("[data-file-reveal]")) {
        void revealFileCardPath(path, card);
      } else {
        void openFileCardPath(path, card);
      }
      return;
    }
    const img = target.closest("img.chat-local-media, img.chat-attachment-image");
    if (img && (img as HTMLImageElement).src) {
      buildLightbox((img as HTMLImageElement).src);
    }
  });
  // 键盘可达性：Enter/Space 触发文件卡片打开
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") {
      return;
    }
    const target = e.target as HTMLElement | null;
    const card = target && typeof target.closest === "function"
      ? (target.closest(".chat-file-card") as HTMLElement | null)
      : null;
    if (card && card.dataset.filePath && target === card) {
      e.preventDefault();
      void openFileCardPath(card.dataset.filePath, card);
    }
  });
}

function flashFileCardError(card: HTMLElement) {
  card.classList.add("chat-file-card--error");
  setTimeout(() => card.classList.remove("chat-file-card--error"), 1600);
}

async function openFileCardPath(path: string, card: HTMLElement) {
  try {
    await ipc.openPath(path);
  } catch {
    // 白名单外扩展名被主进程拒绝，或文件不存在
    flashFileCardError(card);
    showToastGlobal(t("chat.fileCard.openFailed"));
  }
}

async function revealFileCardPath(path: string, card: HTMLElement) {
  try {
    await ipc.revealPath(path);
  } catch {
    flashFileCardError(card);
    showToastGlobal(t("chat.fileCard.revealFailed"));
  }
}

export function enhanceMedia(container: Element | undefined) {
  if (!container) {
    return;
  }
  ensureClickDelegate();
  // error 事件不冒泡，只能逐元素绑定（幂等）
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>("img.chat-local-media"))) {
    if (img.dataset.mediaErrBound === "1") {
      continue;
    }
    img.dataset.mediaErrBound = "1";
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
  }
}

// 已发送附件容器 ref（grouped-render.ts MediaPaths 附件区）：附件卡片渲染在
// .chat-text 之外（无 chatTextEnhanceRef 兜底），需自行触发 enhanceMedia 安装
// 文件卡片点击委托（幂等）。
export const chatMediaEnhanceRef = ref((el?: Element) => {
  if (el) {
    enhanceMedia(el);
  }
});
