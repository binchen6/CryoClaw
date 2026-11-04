import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { MOTION_MS, prefersReducedMotion } from "./motion.ts";

/** Keep the existing subtree during exit; a fast reversal cancels removal. */
export class DisclosureDirective extends AsyncDirective {
  private body: TemplateResult | typeof nothing = nothing;
  private timer?: ReturnType<typeof setTimeout>;
  private expanded = false;
  private floating = false;
  render(open: boolean, content: () => TemplateResult, floating = false) {
    this.floating = floating;
    if (open) { clearTimeout(this.timer); this.timer = undefined; }
    this.expanded = open;
    if (open) this.body = content();
    else if (prefersReducedMotion()) this.body = nothing;
    else if (this.body !== nothing && !this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.expanded) { this.body = nothing; this.setValue(nothing); }
    }, MOTION_MS.panel);
    return this.frame(open);
  }
  private frame(open: boolean) {
    return this.body === nothing ? nothing : this.floating
      ? html`<div class="cc-menu-presence" data-open=${String(open)} ?inert=${!open} aria-hidden=${String(!open)}>${this.body}</div>`
      : html`<div class="cc-disclosure" data-open=${String(open)} ?inert=${!open} aria-hidden=${String(!open)}><div>${this.body}</div></div>`;
  }
  protected disconnected() { clearTimeout(this.timer); this.timer = undefined; }
  protected reconnected() { if (!this.expanded) { this.body = nothing; this.setValue(nothing); } }
}

export const disclosure = directive(DisclosureDirective);
