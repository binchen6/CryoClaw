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
    gap: var(--spacer-2);
    background: var(--bg-input);
    border: var(--hairline);
    border-radius: var(--radius-8);
    padding: var(--spacer-2);
    overflow: hidden;
    flex-shrink: 0;
    margin-bottom: var(--spacer-8);
  }
  .oc-provider-seg__pill {
    flex: 1;
    height: 28px;
    padding: 0 var(--spacer-12);
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: var(--radius-6);
    cursor: pointer;
    transition: color var(--duration-fast) var(--ease-out),
      background var(--duration-fast) var(--ease-out);
    white-space: nowrap;
    font-family: inherit;
  }
  .oc-provider-seg__pill:hover:not(:disabled):not(.oc-provider-seg__pill--active) {
    color: var(--text);
    background: var(--bg-hover);
  }
  /* 选中段：accent-subtle 底 + accent 字（cc-chip--selected / 导航 active 同语言） */
  .oc-provider-seg__pill--active {
    color: var(--accent);
    background: var(--accent-subtle);
    font-weight: var(--weight-semibold);
  }
  .oc-provider-seg__pill--locked { opacity: 0.4; cursor: not-allowed; }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styleSheet];

declare global {
  interface HTMLElementTagNameMap {
    "oc-provider-segment": ProviderSegment;
  }
}
