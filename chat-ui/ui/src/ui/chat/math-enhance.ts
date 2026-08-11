/**
 * LaTeX 公式渲染（阅读体验增强，R10）：
 * 对 .chat-text 内的 $$...$$（块级）与 $...$（行内）用 KaTeX 渲染。
 * 与代码块增强同模式：DOM 层后处理，不动 marked/DOMPurify 管线；
 * KaTeX 走动态 import（core + 样式，不拖累首屏）；失败保留原文不影响阅读。
 * 幂等：容器 dataset 标记防重复扫描。
 */

type KatexModule = {
  default: {
    render: (tex: string, el: HTMLElement, opts: { displayMode: boolean; throwOnError: boolean }) => void;
  };
};

let katexPromise: Promise<KatexModule["default"]> | null = null;

function loadKatex(): Promise<KatexModule["default"]> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex") as Promise<KatexModule>,
      import("./katex-css.ts"),
    ]).then(([m]) => m.default);
  }
  return katexPromise;
}

// 块级 $$...$$（可含换行）；行内 $...$ 不允许跨行，首尾不得空白（降低 $5 之类误判）
export const BLOCK_RE = /\$\$([\s\S]+?)\$\$/;
export const INLINE_RE = /\$([^\s$][^$\n]*?)\$/;

export function isValidInlineTex(tex: string): boolean {
  return (
    tex.length > 0 &&
    tex.length <= 300 &&
    !/^\s/.test(tex) &&
    !/\s$/.test(tex) &&
    !tex.includes("\n")
  );
}

function collectTextNodes(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    if (text.nodeValue && text.nodeValue.includes("$")) {
      const parent = text.parentElement;
      // 跳过代码/按钮/标签等非正文区域
      if (parent && !parent.closest("pre, code, button, .chat-code-copy, .chat-code-lang, .chat-math")) {
        nodes.push(text);
      }
    }
    node = walker.nextNode();
  }
  return nodes;
}

function renderTex(katex: KatexModule["default"], tex: string, displayMode: boolean): HTMLElement | null {
  const el = document.createElement(displayMode ? "div" : "span");
  el.className = displayMode ? "chat-math chat-math--block" : "chat-math";
  try {
    katex.render(tex, el, { displayMode, throwOnError: false });
    return el;
  } catch {
    return null;
  }
}

// 处理单个文本节点：可能包含多个公式段，逐段拆分替换
function processTextNode(katex: KatexModule["default"], text: Text) {
  let current: Text | null = text;
  let guard = 0;
  while (current && guard++ < 50) {
    const value = current.nodeValue ?? "";
    const blockMatch = BLOCK_RE.exec(value);
    const inlineMatch = INLINE_RE.exec(value);

    // 取位置更靠前的一个匹配（行内匹配需额外校验首尾空白）
    let match: RegExpExecArray | null = null;
    let displayMode = false;
    if (blockMatch && (!inlineMatch || blockMatch.index <= inlineMatch.index)) {
      match = blockMatch;
      displayMode = true;
    } else if (inlineMatch && isValidInlineTex(inlineMatch[1])) {
      match = inlineMatch;
    } else if (inlineMatch) {
      // 行内候选不合法（如 "$5 and $10"）：跳过该 $ 继续找后续
      const rest = value.slice(inlineMatch.index + 1);
      if (!rest.includes("$")) {
        return;
      }
      const suffix = current.splitText(inlineMatch.index + 1);
      current = suffix;
      continue;
    }
    if (!match) {
      return;
    }

    const tex = match[1];
    const rendered = renderTex(katex, tex, displayMode);
    const start = match.index;
    const end = start + match[0].length;
    const parent = current.parentNode;
    if (!parent) {
      return;
    }
    if (!rendered) {
      // 渲染失败：保留原文，跳过此匹配继续
      const suffix = current.splitText(end);
      current = suffix;
      continue;
    }
    const after = current.splitText(end);
    const before = current.splitText(start);
    parent.replaceChild(rendered, before);
    current = after;
  }
}

export async function enhanceMath(container: Element | undefined) {
  if (!container) {
    return;
  }
  // 廉价早退：已渲染的公式不再含 $；无 $ 直接跳过（ref 回调每次 commit 触发，须快）
  if (!container.textContent || !container.textContent.includes("$")) {
    return;
  }
  const candidates = collectTextNodes(container).filter((n) => BLOCK_RE.test(n.nodeValue ?? "") || INLINE_RE.test(n.nodeValue ?? ""));
  if (candidates.length === 0) {
    return;
  }
  try {
    const katex = await loadKatex();
    if (!container.isConnected) {
      return;
    }
    for (const text of candidates) {
      if (text.isConnected) {
        processTextNode(katex, text);
      }
    }
  } catch {
    // katex 加载失败不影响阅读，保留原文
  }
}
