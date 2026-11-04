import { nothing, type ElementPart } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type Part } from "lit/directive.js";
import { positionAnchorPanel } from "./anchor-panel.ts";

class AnchoredMenuDirective extends AsyncDirective {
  private panel?: HTMLElement;
  private trigger: () => HTMLElement | null = () => null;
  private above = false;
  private listening = false;
  private dismiss?: () => void;
  render(trigger: () => HTMLElement | null, above = false, dismiss?: () => void) {
    this.dismiss = dismiss;
    this.trigger = trigger; this.above = above;
    queueMicrotask(this.position);
    return nothing;
  }
  update(part: Part, args: [() => HTMLElement | null, boolean?, (() => void)?]) {
    this.panel = (part as ElementPart).element as HTMLElement;
    this.listen();
    return this.render(...args);
  }
  private position = () => {
    const panel = this.panel, trigger = this.trigger();
    if (!this.isConnected || !panel?.isConnected || !trigger?.isConnected) return;
    const result = positionAnchorPanel(panel,trigger,this.above);
    panel.dataset.side = result.side;
    panel.style.setProperty("--menu-offset", result.side === "top" ? "6px" : "-6px");
    panel.classList.add("cc-anchored-menu");
  };
  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("resize", this.position);
    window.addEventListener("scroll", this.position, true);
    document.addEventListener("pointerdown", this.outside, true);
    document.addEventListener("keydown", this.keydown, true);
  }
  private outside = (event: Event) => { if (this.dismiss && !event.composedPath().includes(this.panel!) && !event.composedPath().includes(this.trigger()!)) this.dismiss(); };
  private keydown = (event: KeyboardEvent) => { if (this.dismiss && event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); this.dismiss(); this.trigger()?.focus(); } };
  protected disconnected() {
    this.listening = false;
    window.removeEventListener("resize", this.position);
    window.removeEventListener("scroll", this.position, true);
    document.removeEventListener("pointerdown", this.outside, true);
    document.removeEventListener("keydown", this.keydown, true);
  }
  protected reconnected() { this.listen(); this.position(); }
}
export const anchoredMenu = directive(AnchoredMenuDirective);
