/**
 * 文件/目录路径识别与超链接化
 *
 * 在已 sanitize 的 HTML 中识别 Unix/macOS/Windows 文件路径，
 * 替换为可点击的 <a> 标签，点击后通过 Electron 打开本地文件。
 */

// 路径段字符：字母/数字/汉字等 Unicode 字符 + 常见文件名符号
// \p{L} 匹配所有 Unicode 字母（含 CJK），\p{N} 匹配 Unicode 数字
// 已 sanitize HTML 中文本 & 转义为 &amp;：把 &amp; 作为整体纳入段字符，
// 否则路径在实体分号处被截断（文件名含 & 合法，Windows/Unix 均常见）
const S = `(?:&amp;|[\\p{L}\\p{N}.@_\\-+#()（）【】\\[\\]{}!！~·&=])`;
// 路径正则：匹配 Unix 绝对路径、~ 路径、Windows 盘符路径
// 要求路径至少包含一层目录分隔符，避免误匹配孤立的 "/" 或 "~"
const PATH_RE = new RegExp(
  [
    // Unix/macOS 绝对路径: /home/user/file.txt, /tmp/output/
    `(?:\\/(?:${S}+\\/)+${S}*)`,
    // Home 目录路径: ~/Documents/file.pdf
    `(?:~\\/(?:${S}+\\/)*${S}+)`,
    // Windows 路径: C:\Users\foo\bar.txt, D:\data\
    `(?:[A-Z]:\\\\(?:${S}+\\\\)+${S}*)`,
  ].join("|"),
  "gu",
);

// 检查匹配位置是否在 HTML 标签属性内部（如 <a href="..."> 或 <img src="...">）
function isInsideHtmlTag(html: string, matchStart: number): boolean {
  // 从匹配位置向前搜索，找最近的 < 或 >
  for (let i = matchStart - 1; i >= 0; i--) {
    const ch = html[i];
    if (ch === ">") return false; // 遇到 > 说明在标签外
    if (ch === "<") return true;  // 遇到 < 说明在标签内
  }
  return false;
}

// 检查匹配位置是否已经被 <a> 标签包裹
function isInsideAnchor(html: string, matchStart: number): boolean {
  const before = html.slice(0, matchStart);
  const lastOpenA = before.lastIndexOf("<a ");
  if (lastOpenA === -1) return false;
  const lastCloseA = before.lastIndexOf("</a>");
  return lastOpenA > lastCloseA;
}

// 检查匹配前面是否紧跟协议前缀（http:// 等），说明这是 URL 的一部分
function isPrecededByProtocol(html: string, matchStart: number): boolean {
  // 向前最多检查 10 字符寻找 "://"
  const lookback = html.slice(Math.max(0, matchStart - 10), matchStart);
  return /\w+:\/\/$/.test(lookback);
}

const NAMED_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

/**
 * 反转义 DOMPurify 标准输出中的 HTML 实体（&amp; &lt; &gt; &quot; &#39; &#x27; 等）。
 * 只覆盖 sanitize 管线实际产出的实体，不引依赖、不实现完整实体表；
 * 未知或未识别的实体原样保留。
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#(?:x|X)?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITY_MAP[body.toLowerCase()] ?? entity;
  });
}

/**
 * 在 sanitized HTML 中识别文件路径，替换为可点击超链接
 */
export function linkifyPaths(html: string): string {
  return html.replace(PATH_RE, (match, offset) => {
    // 跳过 HTML 标签属性内的路径
    if (isInsideHtmlTag(html, offset)) return match;
    // 跳过已在 <a> 标签内的路径
    if (isInsideAnchor(html, offset)) return match;
    // 跳过 URL 中的路径部分（如 http://example.com/path）
    if (isPrecededByProtocol(html, offset)) return match;

    // match 取自 sanitized HTML（& 以 &amp; 实体出现）：先解码回真实路径，
    // 再统一转义一次产出属性与文本，避免双重转义产生 a&amp;amp 损坏 data-path
    const path = decodeHtmlEntities(match);
    const escaped = path
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return `<a class="chat-path-link" data-path="${escaped}" title="${escaped}">${escaped}</a>`;
  });
}
