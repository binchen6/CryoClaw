/**
 * Pill-style provider selector, shared between Setup Step 2 and Settings Provider Tab.
 *
 * Usage:
 *   <oc-provider-segment .providers=${["moonshot","anthropic"]} .selected=${"moonshot"}
 *     .locked=${["anthropic"]}
 *     @select=${(e: CustomEvent) => { e.detail.provider }}
 *   ></oc-provider-segment>
 */
import { LitElement, html } from "lit";
import { property } from "lit/decorators.js";

export class ProviderSegment extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Array }) providers: string[] = [];
  @property({ type: String }) selected = "";
  @property({ type: Array }) locked: string[] = [];
  @property({ type: Object }) labels: Record<string, string> = {};

  private handleClick(provider: string) {
    if (this.locked.includes(provider)) return;
    this.dispatchEvent(new CustomEvent("select", { detail: { provider }, bubbles: true, composed: true }));
  }

  render() {
    return html`
      <div class="oc-provider-seg">
        ${this.providers.map(p => {
          const isActive = p === this.selected;
          const isLocked = this.locked.includes(p);
          return html`
            <button class="oc-provider-seg__pill ${isActive ? "oc-provider-seg__pill--active" : ""} ${isLocked ? "oc-provider-seg__pill--locked" : ""}"
              ?disabled=${isLocked}
              @click=${() => this.handleClick(p)}>
              ${this.labels[p] ?? p}
            </button>
          `;
        })}
      </div>
    `;
  }
}

customElements.define("oc-provider-segment", ProviderSegment);

const styleSheet = new CSSStyleSheet();
styleSheet.replaceSync(/* css */`
  .oc-provider-seg {
    display: flex;
    gap: var(--spacer-2, 2px);
    background: var(--bg-input, #f5f5f5);
    border: 1px solid var(--border, #e4e4e7);
    border-radius: var(--radius-sm, 8px);
    padding: var(--spacer-2, 2px);
    overflow: hidden;
    flex-shrink: 0;
    margin-bottom: 8px;
  }
  .oc-provider-seg__pill {
    flex: 1;
    height: 28px;
    padding: 0 var(--spacer-12, 12px);
    font-size: var(--text-base, 14px);
    font-weight: 500;
    color: var(--text-muted, #a1a1aa);
    background: transparent;
    border: none;
    border-radius: var(--radius-6, 6px);
    cursor: pointer;
    transition: color var(--transition, 0.18s ease), background var(--transition, 0.18s ease);
    white-space: nowrap;
    font-family: inherit;
  }
  .oc-provider-seg__pill:hover:not(:disabled):not(.oc-provider-seg__pill--active) {
    color: var(--text, #333);
    background: var(--bg-hover, rgba(0,0,0,0.04));
  }
  /* 选中段：accent-subtle 底 + accent 字（cc-chip--selected / 导航 active 同语言） */
  .oc-provider-seg__pill--active {
    color: var(--accent, #0ea5e9);
    background: var(--accent-subtle, rgba(14,165,233,0.1));
    font-weight: 600;
  }
  .oc-provider-seg__pill--locked { opacity: 0.4; cursor: not-allowed; }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-provider-segment": ProviderSegment;
  }
}
