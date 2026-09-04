/**
 * iOS-style toggle switch component.
 *
 * Usage:
 *   <oc-toggle-switch .label=${"Enable"} .checked=${true}
 *     @change=${(e: CustomEvent) => { e.detail.checked }}
 *   ></oc-toggle-switch>
 */
import { LitElement, html, css, nothing } from "lit";
import { property } from "lit/decorators.js";

export class ToggleSwitch extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Boolean }) checked = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) label = "";
  // 无文字 label 的调用方必须提供（内部 div 才是 role=switch，host 上的 aria-label 不生效）
  @property({ type: String, attribute: "aria-label" }) ariaLabel = "";

  private toggle() {
    if (this.disabled) return;
    this.checked = !this.checked;
    this.dispatchEvent(new CustomEvent("change", { detail: { checked: this.checked }, bubbles: true, composed: true }));
  }

  private onKeydown(e: KeyboardEvent) {
    if (this.disabled) return;
    if (e.repeat) return; // 长按 repeat 不反复切换（对齐原生 checkbox 每次按键只切一次）
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // Space 默认滚动页面，需拦截
      this.toggle();
    }
  }

  render() {
    return html`
      <div class="oc-toggle ${this.disabled ? "oc-toggle--disabled" : ""}"
        role="switch"
        aria-checked=${this.checked ? "true" : "false"}
        aria-label=${this.ariaLabel || nothing}
        tabindex=${this.disabled ? "-1" : "0"}
        @click=${this.toggle}
        @keydown=${this.onKeydown}>
        ${this.label ? html`<span class="oc-toggle-label">${this.label}</span>` : nothing}
        <span class="oc-toggle-track ${this.checked ? "oc-toggle-track--on" : ""}">
          <span class="oc-toggle-thumb"></span>
        </span>
      </div>
    `;
  }
}

customElements.define("oc-toggle-switch", ToggleSwitch);

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(/* css */`
  .oc-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacer-12);
    padding: var(--spacer-4) 0;
    cursor: pointer;
    user-select: none;
  }
  .oc-toggle--disabled { opacity: 0.5; cursor: not-allowed; }
  .oc-toggle:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--radius-8); }
  .oc-toggle-label { font-size: var(--heading-xs); font-weight: var(--weight-medium); color: var(--text-secondary); }
  .oc-toggle-track {
    position: relative;
    box-sizing: border-box;
    width: 40px;
    height: 22px;
    border-radius: var(--radius-pill);
    background: var(--bg-muted);
    border: 1px solid var(--border);
    transition: background var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
    flex-shrink: 0;
  }
  .oc-toggle-track--on { background: var(--accent); border-color: transparent; }
  .oc-toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--toggle-knob);
    box-shadow: var(--shadow-sm);
    transition: transform var(--duration-fast) var(--ease-out);
  }
  .oc-toggle-track--on .oc-toggle-thumb { transform: translateX(18px); }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-toggle-switch": ToggleSwitch;
  }
}
