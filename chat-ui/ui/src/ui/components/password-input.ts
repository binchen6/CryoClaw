/**
 * Password field with visibility toggle.
 *
 * Usage:
 *   <oc-password-input .value=${"sk-..."} placeholder="sk-..."
 *     @input=${(e: CustomEvent) => { e.detail.value }}
 *   ></oc-password-input>
 */
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { t } from "../i18n.ts";
import { icons } from "../icons.ts";

@customElement("oc-password-input")
export class PasswordInput extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "";
  @property({ type: Boolean }) disabled = false;

  private visible = false;

  private toggleVisibility() {
    this.visible = !this.visible;
    this.requestUpdate();
  }

  private handleInput(e: Event) {
    // Light DOM 下需阻止原生 input 冒泡：否则它会在我们的 CustomEvent 之后到达消费者，
    // 而原生事件没有 detail.value，导致读取到 undefined（粘贴时尤其明显）
    e.stopPropagation();
    this.value = (e.target as HTMLInputElement).value;
    this.dispatchEvent(new CustomEvent("input", { detail: { value: this.value }, bubbles: true, composed: true }));
  }

  render() {
    return html`
      <div class="oc-password">
        <input
          class="oc-password__input oc-password-input"
          .type=${this.visible ? "text" : "password"}
          .value=${this.value}
          .placeholder=${this.placeholder}
          ?disabled=${this.disabled}
          @input=${this.handleInput}
        />
        <button class="oc-password__toggle" type="button"
          aria-label=${this.visible ? t("settings.hidePassword") : t("settings.showPassword")}
          aria-pressed=${this.visible ? "true" : "false"}
          @click=${this.toggleVisibility}>
          ${this.visible ? icons.eyeOff : icons.eye}
        </button>
      </div>
    `;
  }
}

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(/* css */`
  .oc-password {
    position: relative;
    display: flex;
    align-items: center;
  }
  .oc-password-input {
    width: 100%;
    min-height: 32px;
    padding: 0 var(--spacer-12);
    border: var(--hairline);
    border-radius: var(--radius-8);
    background: var(--bg-input);
    color: var(--text);
    font-size: var(--text-base);
    outline: none;
    box-sizing: border-box;
    font-family: inherit;
    transition: border-color var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) var(--ease-out);
  }
  /* 后定义覆盖 .oc-password-input 的 padding-right，给可视切换钮让位（无需 !important） */
  .oc-password__input {
    flex: 1;
    padding-right: var(--spacer-40);
  }
  .oc-password-input::placeholder {
    color: var(--text-muted);
  }
  .oc-password-input:focus {
    border-color: var(--border-focus);
    box-shadow: var(--focus-ring);
  }
  .oc-password-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .oc-password__toggle {
    position: absolute;
    right: var(--spacer-4);
    top: 50%;
    transform: translateY(-50%);
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-6);
    transition: color var(--duration-fast) var(--ease-out),
      background var(--duration-fast) var(--ease-out);
  }
  .oc-password__toggle:hover {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-password-input": PasswordInput;
  }
}
