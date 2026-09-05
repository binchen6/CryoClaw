/**
 * Status message display (error / success / info).
 *
 * Usage:
 *   <oc-message-box .message=${"Saved!"} .type=${"success"} .visible=${true}></oc-message-box>
 */
import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";

export class MessageBox extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: String }) message = "";
  @property({ type: String }) type: "error" | "success" | "info" = "info";
  @property({ type: Boolean }) visible = false;

  render() {
    if (!this.visible || !this.message) return nothing;
    return html`
      <div class="oc-msgbox oc-msgbox--${this.type}">${this.message}</div>
    `;
  }
}

customElements.define("oc-message-box", MessageBox);

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(/* css */`
  .oc-msgbox {
    padding: var(--spacer-10, 10px) var(--spacer-12, 12px);
    border-radius: var(--radius-sm, 8px);
    font-size: var(--text-sm, 12px);
    line-height: 1.4;
    margin: var(--spacer-8, 8px) 0;
    /* 防止超长 provider 报错（如带堆栈/JSON 的字符串）撑爆布局或顶进 sticky 按钮条；
       自身可滚 + 强制换行。 */
    max-height: 30vh;
    overflow-y: auto;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: pre-wrap;
  }
  /* cc-alert 语义：subtle 底 + 语义文字色 + 同色 25% 边；
     fallback 值与 shared/design-tokens.css 浅色主题对齐（token 缺席时兜底） */
  .oc-msgbox--error {
    background: var(--danger-subtle, rgba(220,38,38,0.08));
    color: var(--destructive, var(--danger, #dc2626));
    border: 1px solid color-mix(in srgb, var(--destructive, #dc2626) 25%, transparent);
  }
  .oc-msgbox--success {
    background: var(--ok-subtle, rgba(22,163,74,0.1));
    color: var(--ok, #16a34a);
    border: 1px solid color-mix(in srgb, var(--ok, #16a34a) 25%, transparent);
  }
  .oc-msgbox--info {
    background: var(--accent-subtle, rgba(79,70,229,0.08));
    color: var(--accent, #1a6fd0);
    border: 1px solid color-mix(in srgb, var(--accent, #1a6fd0) 25%, transparent);
  }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-message-box": MessageBox;
  }
}
