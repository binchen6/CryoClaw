import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { chatTextEnhanceRef } from "../chat/code-block-enhance.ts";

export type MarkdownSidebarProps = {
  content: string | null;
  error: string | null;
  onClose: () => void;
  onViewRawText: () => void;
};

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">${t("chat.toolOutput")}</div>
        <button @click=${props.onClose} class="btn" title=${t("markdownSidebar.close")}>
          ${icons.x}
        </button>
      </div>
      <div class="sidebar-content">
        ${
          props.error
            ? html`
              <div class="callout danger">${props.error}</div>
              <button @click=${props.onViewRawText} class="btn oc-mt-12">
                ${t("markdownSidebar.viewRaw")}
              </button>
            `
            : props.content
              // R52 T4：sidebar 挂载与正文 .chat-text 相同的 DOM 层代码增强
              // （hljs 高亮 + 复制按钮 + 语言标签）。ref 回调在 lit 每次 commit
              // 后触发，增强本身幂等（dataset 标记防重复挂载），懒渲染/details
              // 场景下内容注入即被增强。
              ? html`<div class="sidebar-markdown" ${chatTextEnhanceRef}>${unsafeHTML(toSanitizedMarkdownHtml(props.content))}</div>`
              : html`
                  <div class="muted">${t("markdownSidebar.noContent")}</div>
                `
        }
      </div>
    </div>
  `;
}
