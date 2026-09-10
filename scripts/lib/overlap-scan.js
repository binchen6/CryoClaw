// overlap-scan.js — 跨组件重叠检测表达式（ui-screenshot-qa / settings-cdp-smoke 共用）。
//
// R66 修复的假阳性：折叠容器（如思考块 details 的 height:0 + overflow:hidden）里的
// 子元素**仍参与布局**并带坐标，但被祖先裁剪、根本不可见。原实现只过滤
// display:none / visibility:hidden / position:fixed，于是把这些被裁掉的文本算成
// "压住输入框的重叠"，连续两次把发版门禁判红（截图目视无任何重叠）。
//
// 现按**可见矩形**判定：元素矩形与所有裁剪祖先（overflow != visible，含 auto/scroll）
// 求交，得到实际可见区域；可见区不足 5×5 的元素整体跳过，重叠也按可见区计算。
// 只丢弃不可见部分的相交，可见元素的重叠照旧上报（门禁能力不变）。
"use strict";

/**
 * 返回在页面上下文中求值的表达式字符串；结果为 JSON 数组（重叠描述）。
 * opts.viewportOnly=true（默认，截图 QA）把可见区再与视口求交；
 * 设置页冒烟传 false——它整页逐 tab 检查，不受视口高度限制。
 */
function overlapCheckExpr(opts = {}) {
  const viewportOnly = opts.viewportOnly !== false;
  return `(() => {
  // 模态/对话框打开时跳过：模态带遮罩覆盖底层内容属预期交互。
  if (document.querySelector('.cc-dialog-overlay, [role="dialog"][aria-modal="true"]')) return "[]";
  const scope = document.querySelector('.oc-settings-content') || document.body;
  const customAncestor = (e) => { let n = e; while (n && n !== document.body) { if (n.tagName.includes('-')) return n; n = n.parentElement; } return null; };
  // 可见矩形：与所有裁剪祖先（overflow != visible）求交${viewportOnly ? "，并与视口求交" : ""}
  const visibleRect = (el) => {
    const base = el.getBoundingClientRect();
    let r = { left: base.left, top: base.top, right: base.right, bottom: base.bottom, width: base.width, height: base.height };
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const cs = getComputedStyle(cur);
      if (/(hidden|clip|auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
        const cr = cur.getBoundingClientRect();
        const left = Math.max(r.left, cr.left), top = Math.max(r.top, cr.top);
        const right = Math.min(r.right, cr.right), bottom = Math.min(r.bottom, cr.bottom);
        if (right <= left || bottom <= top) return null;
        r = { left, top, right, bottom, width: right - left, height: bottom - top };
      }
      cur = cur.parentElement;
    }${viewportOnly ? `
    {
      const left = Math.max(r.left, 0), top = Math.max(r.top, 0);
      const right = Math.min(r.right, innerWidth), bottom = Math.min(r.bottom, innerHeight);
      if (right <= left || bottom <= top) return null;
      r = { left, top, right, bottom, width: right - left, height: bottom - top };
    }` : ""}
    return r;
  };
  const els = [...scope.querySelectorAll('*')].filter(e => {
    const base = e.getBoundingClientRect();
    if (base.width < 5 || base.height < 5) return false;
    if (e.children.length > 0) return false;
    const cs = getComputedStyle(e);
    if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') return false;
    const vr = visibleRect(e);
    return !!vr && vr.width >= 5 && vr.height >= 5;
  });
  const bad = [];
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
      const ca = customAncestor(els[i]), cb = customAncestor(els[j]);
      if (ca && ca === cb) continue;
      const a = visibleRect(els[i]), b = visibleRect(els[j]);
      if (!a || !b) continue;
      const xo = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const yo = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (xo > 8 && yo > 6) {
        const d = (e, r) => {
          const id = typeof e.className === "string" && e.className ? e.className : e.tagName;
          const txt = (e.textContent || "").trim().slice(0, 18);
          return id + (txt ? "«" + txt + "»" : "") + "@" + Math.round(r.left) + "," + Math.round(r.top) + "," + Math.round(r.width) + "x" + Math.round(r.height);
        };
        bad.push((d(els[i], a) + " ⨯ " + d(els[j], b)).slice(0, 200));
      }
    }
  }
  return JSON.stringify([...new Set(bad)].slice(0, 15));
})()`;
}

module.exports = { overlapCheckExpr };
