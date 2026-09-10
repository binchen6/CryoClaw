// bare-i18n-scan.js — 裸 i18n key 扫描表达式（layout / settings / ui-qa 三个冒烟共用）。
//
// 背景（R66）：原实现直接扫描 document.body.textContent，把**用户与模型内容**里形如
// `tasks.Let` 的点号 token 也当成裸键——实测聊天思考块文案
// "…triggers additional tasks.Let me read the files." 触发假阳性并阻断发版
// （相邻文本节点在 textContent 里无分隔符拼接，逐节点搜索反而定位不到）。
//
// 现在只扫 UI chrome：逐文本节点收集文本，跳过内容容器（消息气泡/思考块/工具卡/
// 代码块/任务行/会话名/技能列表/工作区文件等）。真实漏翻的键都出现在按钮、标签、
// 页签、提示这类 chrome 上，扫描能力不受影响。
"use strict";

/** 返回在页面上下文中求值的表达式字符串，结果为 JSON 数组（裸键列表）。 */
function bareI18nScanExpr() {
  return `(() => {
    const SKIP_TAGS = new Set(["PRE", "CODE", "SCRIPT", "STYLE", "TEXTAREA"]);
    // 内容容器（用户/模型产出）：class 命中即整棵子树跳过
    const SKIP_CLASS = /(chat-bubble|chat-group|chat-thinking|chat-tool|chat-question|chat-error|chat-attachment|chat-approval|chat-file-change|markdown|md-body|markdown-body|ts-row|session-item|cc-session|skill-store__list|skills-group|skill-row|workspace-file|workspace-tree|git-entry|chat-cmd-suggest|chat-stream)/;
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
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text = "";
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement && isContent(n.parentElement)) continue;
      text += n.textContent + "\\n";
    }
    const re = /\\b(app|chat|settings|setup|common|workspace|tasks|extensions|sessions)\\.[a-zA-Z][a-zA-Z0-9_.]{2,}/g;
    const ext = /\\.(xml|json|md|png|jpe?g|gif|js|mjs|ts|html|css|txt|ya?ml|exe|asar|zip)$/i;
    return JSON.stringify([...new Set((text.match(re) || []).filter((k) => !ext.test(k)))]);
  })()`;
}

module.exports = { bareI18nScanExpr };
