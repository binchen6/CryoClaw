import { ref } from "lit/directives/ref.js";

/**
 * 代码块复制按钮（阅读/操作体验增强，R10）：
 * markdown 经 unsafeHTML 注入后，为 .chat-text 内每个 <pre> 追加一个悬浮复制按钮。
 * 增强在 DOM 层完成（不经 DOMPurify 白名单），幂等（dataset 标记防重复挂载）。
 * 用法：<div class="chat-text" ${chatTextEnhanceRef}>…unsafeHTML…</div>
 */

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
const COPY_TITLE = "复制代码";
const COPIED_TITLE = "已复制";
const ERROR_TITLE = "复制失败";

const SVG_NS = "http://www.w3.org/2000/svg";

function buildIcon(kind: "copy" | "check"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  if (kind === "copy") {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", "9");
    rect.setAttribute("y", "9");
    rect.setAttribute("width", "13");
    rect.setAttribute("height", "13");
    rect.setAttribute("rx", "2");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1");
    svg.appendChild(rect);
    svg.appendChild(path);
  } else {
    const polyline = document.createElementNS(SVG_NS, "polyline");
    polyline.setAttribute("points", "20 6 9 17 4 12");
    svg.appendChild(polyline);
  }
  return svg;
}

function setIcon(btn: HTMLButtonElement, kind: "copy" | "check") {
  btn.textContent = "";
  btn.appendChild(buildIcon(kind));
}

async function copyCodeText(pre: HTMLPreElement): Promise<boolean> {
  const text = pre.innerText;
  if (!text) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function buildCodeCopyButton(pre: HTMLPreElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-code-copy";
  btn.title = COPY_TITLE;
  btn.setAttribute("aria-label", COPY_TITLE);
  setIcon(btn, "copy");

  btn.addEventListener("click", async () => {
    if (btn.dataset.busy === "1") {
      return;
    }
    btn.dataset.busy = "1";
    const ok = await copyCodeText(pre);
    if (!btn.isConnected) {
      return;
    }
    delete btn.dataset.busy;
    if (ok) {
      btn.dataset.copied = "1";
      btn.title = COPIED_TITLE;
      setIcon(btn, "check");
      window.setTimeout(() => {
        if (!btn.isConnected) {
          return;
        }
        delete btn.dataset.copied;
        btn.title = COPY_TITLE;
        setIcon(btn, "copy");
      }, COPIED_FOR_MS);
    } else {
      btn.dataset.error = "1";
      btn.title = ERROR_TITLE;
      window.setTimeout(() => {
        if (!btn.isConnected) {
          return;
        }
        delete btn.dataset.error;
        btn.title = COPY_TITLE;
      }, ERROR_FOR_MS);
    }
  });
  return btn;
}

// 幂等增强一个 .chat-text 容器（lit ref 回调每次 commit 都会触发）
export function enhanceChatText(container: Element | undefined) {
  if (!container) {
    return;
  }
  for (const pre of Array.from(container.querySelectorAll("pre"))) {
    if (pre.dataset.copyEnhanced === "1") {
      continue;
    }
    pre.dataset.copyEnhanced = "1";
    pre.appendChild(buildCodeCopyButton(pre));
  }
}

export const chatTextEnhanceRef = ref((el?: Element) => enhanceChatText(el));
