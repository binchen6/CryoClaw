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
  /* cc-alert 语义：subtle 底 + 语义文字色 + 同色 25% 边 */
  .oc-msgbox--error {
    background: var(--danger-subtle, rgba(239,68,68,0.1));
    color: var(--destructive, var(--danger, #ef4444));
    border: 1px solid color-mix(in srgb, var(--destructive, #ef4444) 25%, transparent);
  }
  .oc-msgbox--success {
    background: var(--ok-subtle, rgba(21,168,119,0.12));
    color: var(--ok, #15a877);
    border: 1px solid color-mix(in srgb, var(--ok, #15a877) 25%, transparent);
  }
  .oc-msgbox--info {
    background: var(--accent-subtle, rgba(14,165,233,0.1));
    color: var(--accent, #0ea5e9);
    border: 1px solid color-mix(in srgb, var(--accent, #0ea5e9) 25%, transparent);
  }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-message-box": MessageBox;
  }
}
