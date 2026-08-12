/**
 * 消息引用（quote）文本构造：
 * 把消息纯文本转为 markdown 引用块，并支持追加到输入框草稿。
 * 纯函数，供 grouped-render 的「引用」按钮与 app-chat-props 装配复用。
 */

/** 引用单条消息的最大字符数，超出截断并在末尾标注省略号 */
export const QUOTE_MAX_CHARS = 4000;

/**
 * 把消息文本转为 markdown 引用块（每行加 `> ` 前缀）。
 * 空行保留为 `>`（markdown 引用块内可容空行），空文本返回空串。
 */
export function buildQuoteText(text: string, maxChars = QUOTE_MAX_CHARS): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  // 超长截断：截到 maxChars 后回退到最近的完整单词/行边界，避免断词
  let clipped = normalized;
  if (normalized.length > maxChars) {
    const head = normalized.slice(0, maxChars);
    const lastBreak = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
    clipped = `${(lastBreak > maxChars * 0.5 ? head.slice(0, lastBreak) : head).replace(/\s+$/, "")}\n…`;
  }
  return clipped
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * 把引用块追加到现有草稿：
 * 草稿为空 → 直接是引用块；否则以两个换行分隔追加（保证引用块另起一段）。
 */
export function appendQuoteToDraft(draft: string, text: string): string {
  const quote = buildQuoteText(text);
  if (!quote) {
    return draft;
  }
  const current = draft ?? "";
  if (current.trim().length === 0) {
    return quote;
  }
  return `${current.replace(/\s+$/, "")}\n\n${quote}`;
}
