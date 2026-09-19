/**
 * Status message display (error / success / info).
 *
 * Usage:
 *   <oc-message-box .message=${"Saved!"} .type=${"success"} .visible=${true}></oc-message-box>
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("oc-message-box")
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

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(/* css */`
  .oc-msgbox {
    padding: var(--spacer-10) var(--spacer-12);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    line-height: 1.4;
    margin: var(--spacer-8) 0;
    /* 防止超长 provider 报错（如带堆栈/JSON 的字符串）撑爆布局或顶进 sticky 按钮条；
       自身可滚 + 强制换行。 */
    max-height: 30vh;
    overflow-y: auto;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: pre-wrap;
  }
  /* cc-alert 语义：subtle 底 + 语义文字色 + 同色 25% 边（令牌由全局 tokens/tokens-ext 提供） */
  .oc-msgbox--error {
    background: var(--danger-subtle);
    color: var(--destructive);
    border: 1px solid color-mix(in srgb, var(--destructive) 25%, transparent);
  }
  .oc-msgbox--success {
    background: var(--ok-subtle);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 25%, transparent);
  }
  .oc-msgbox--info {
    background: var(--accent-subtle);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-message-box": MessageBox;
  }
}
