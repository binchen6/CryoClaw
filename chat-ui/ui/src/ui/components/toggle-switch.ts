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
    gap: var(--spacer-12, 12px);
    padding: var(--spacer-4, 4px) 0;
    cursor: pointer;
    user-select: none;
  }
  .oc-toggle--disabled { opacity: 0.5; cursor: not-allowed; }
  .oc-toggle:focus-visible { outline: none; box-shadow: var(--focus-ring, 0 0 0 2px var(--accent, #0ea5e9)); border-radius: var(--radius-sm, 6px); }
  .oc-toggle-label { font-size: var(--heading-xs, 13px); font-weight: 500; color: var(--text-secondary, #a1a1aa); }
  .oc-toggle-track {
    position: relative;
    width: 42px;
    height: 24px;
    border-radius: var(--radius-pill, 12px);
    background: var(--border, #ccc);
    transition: background var(--duration-normal, 0.2s) ease;
    flex-shrink: 0;
  }
  .oc-toggle-track--on { background: var(--accent, #0ea5e9); }
  .oc-toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--toggle-knob, #ffffff);
    box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.2));
    transition: transform var(--duration-normal, 0.2s) ease;
  }
  .oc-toggle-track--on .oc-toggle-thumb { transform: translateX(18px); }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-toggle-switch": ToggleSwitch;
  }
}
