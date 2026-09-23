// text-quality-scan.js — 文本质量扫描表达式（ui-screenshot-qa 用）。
//
// 两个独立表达式，都在页面上下文求值、返回 JSON 字符串：
//
// textOverflowScanExpr — 截断/溢出检测。互补于 overlap-scan（元素间几何重叠）：
//   它看的是"元素内部"——按钮/标签/页签文字被容器裁掉却没走 ellipsis 省略
//   （ellipsis 属有意设计，不报），以及 body 级横向滚动条（真缺陷，硬门槛）。
//   跳过用户/模型内容容器（与 bare-i18n-scan 同一套 SKIP_CLASS）。
//
// contrastScanExpr — WCAG 对比度启发式。对 UI chrome 文本向上找第一个非透明
//   背景色算对比度，低于阈值上报。背景图/渐变会让结果失真，故只进报告、不做门禁。
"use strict";

// 与 bare-i18n-scan.js 保持一致的内容容器排除（用户/模型产出不算 UI chrome）
const SKIP_CLASS =
  "(chat-bubble|chat-group|chat-thinking|chat-tool|chat-question|chat-error|chat-attachment|chat-approval|chat-file-change|markdown|md-body|markdown-body|ts-row|session-item|cc-session|skill-store__list|skills-group|skill-row|workspace-file|workspace-tree|git-entry|chat-cmd-suggest|chat-stream)";

function textOverflowScanExpr() {
  return `(() => {
    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "PRE", "CODE", "SVG", "CANVAS"]);
    const SKIP_CLASS = /${SKIP_CLASS}/;
    const isContent = (el) => {
      let cur = el;
      while (cur && cur !== document.body) {
        if (SKIP_TAGS.has(cur.tagName)) return true;
        const cls = typeof cur.className === "string" ? cur.className : "";
        if (cls && SKIP_CLASS.test(cls)) return true;
        if (cur.tagName === "DETAILS" && !cur.open) return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const describe = (el) => {
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : el.tagName.toLowerCase();
      return cls + "«" + (el.textContent || "").trim().slice(0, 24) + "»";
    };
    const clipped = [];
    const els = document.body.querySelectorAll("button, a, label, span, h1, h2, h3, h4, p, li, td, th, [role='tab'], [role='button']");
    for (const el of els) {
      if (isContent(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // 横向裁切：省略号属有意设计不报；白空格 pre 的不适用 clientWidth 判定
      if (el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== "ellipsis" && !/pre/.test(cs.whiteSpace)) {
        clipped.push("H:" + describe(el) + " (" + el.scrollWidth + ">" + el.clientWidth + ")");
      }
      // 纵向裁切：仅 overflow 隐藏且非 line-clamp（-webkit-line-clamp 属有意截断）
      const lineClamp = cs.webkitLineClamp || cs.lineClamp;
      if (el.scrollHeight > el.clientHeight + 4 && /(hidden|clip)/.test(cs.overflowY) && (!lineClamp || lineClamp === "none")) {
        clipped.push("V:" + describe(el) + " (" + el.scrollHeight + ">" + el.clientHeight + ")");
      }
      if (clipped.length >= 20) break;
    }
    // body 级横向滚动条：任何场景都是真缺陷
    const pageHOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    return JSON.stringify({ clipped: [...new Set(clipped)].slice(0, 20), pageHOverflow });
  })()`;
}

function contrastScanExpr() {
  return `(() => {
    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "PRE", "CODE", "SVG"]);
    const SKIP_CLASS = /${SKIP_CLASS}/;
    const isContent = (el) => {
      let cur = el;
      while (cur && cur !== document.body) {
        if (SKIP_TAGS.has(cur.tagName)) return true;
        const cls = typeof cur.className === "string" ? cur.className : "";
        if (cls && SKIP_CLASS.test(cls)) return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const parse = (c) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
      if (!m) return null;
      const p = m[1].split(",").map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      let cur = el;
      while (cur) {
        const cs = getComputedStyle(cur);
        // 渐变/背景图无法取色，放弃判定（误报源：active 项常用渐变 pill）
        if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
        const bg = parse(cs.backgroundColor);
        if (bg && bg.a > 0.05) return bg;
        cur = cur.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const low = [];
    const seen = new Set();
    const els = document.body.querySelectorAll("button, a, label, span, h1, h2, h3, h4, [role='tab'], [role='button']");
    for (const el of els) {
      if (isContent(el)) continue;
      // 纯图标元素（无文本）的 color 经 currentColor 驱动 SVG，fg/bg 判定不适用
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const fg = parse(cs.color);
      if (!fg || fg.a < 0.3) continue;
      const bg = bgOf(el);
      if (!bg) continue;
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const fontSize = parseFloat(cs.fontSize) || 14;
      const large = fontSize >= 18 || (fontSize >= 14 && parseInt(cs.fontWeight, 10) >= 700);
      const threshold = large ? 3 : 4.5;
      if (ratio < threshold) {
        const key = (typeof el.className === "string" ? el.className : el.tagName) + "|" + cs.color;
        if (seen.has(key)) continue;
        seen.add(key);
        low.push({
          el: (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase()),
          text: text.slice(0, 20),
          ratio: Math.round(ratio * 100) / 100,
          threshold,
          color: cs.color,
          bg: "rgb(" + bg.r + "," + bg.g + "," + bg.b + ")",
        });
      }
      if (low.length >= 25) break;
    }
    return JSON.stringify(low);
  })()`;
}

module.exports = { textOverflowScanExpr, contrastScanExpr };
