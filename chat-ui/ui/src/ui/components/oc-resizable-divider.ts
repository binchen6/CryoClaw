import { LitElement, css, nothing } from "lit";
import { customElement } from "lit/decorators.js";

/**
 * A draggable divider for resizable split views.
 * Dispatches 'resize' events with { splitRatio: number } detail.
 */
@customElement("oc-resizable-divider")
export class OcResizableDivider extends LitElement {
  static properties = {
    splitRatio: { type: Number },
    minRatio: { type: Number },
    maxRatio: { type: Number },
  };

  splitRatio = 0.6;
  minRatio = 0.4;
  maxRatio = 0.7;

  private isDragging = false;
  private startX = 0;
  private startRatio = 0;
  private containerWidth = 0;

  static styles = css`
    :host {
      width: 8px;
      cursor: col-resize;
      background: transparent;
      transition: background var(--duration-fast) var(--ease-out);
      flex-shrink: 0;
      position: relative;
      -webkit-app-region: no-drag;
    }
    :host::after {
      content: "";
      position: absolute;
      top: 0;
      left: 3px;
      width: 1px;
      bottom: 0;
      border-radius: var(--radius-full);
      background: var(--border);
      mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent);
      transition: transform var(--duration-fast) var(--ease-standard), background-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
    }
    :host(:hover)::after, :host(.dragging)::after {
      background: var(--accent);
      transform: scaleX(2);
      box-shadow: 0 0 12px 2px var(--accent-glow);
      mask-image: none;
    }
    :host-context([data-motion="reduce"])::after { transition: none; }
    @media (prefers-reduced-motion: reduce) { :host::after { transition: none; } }
  `;

  render() {
    return nothing;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("mousedown", this.handleMouseDown);
  }

  disconnectedCallback() {
    this.finishDrag(false);
    super.disconnectedCallback();
    this.removeEventListener("mousedown", this.handleMouseDown);
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
  }

  private handleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    this.isDragging = true;
    this.startX = e.clientX;
    this.startRatio = this.splitRatio;
    this.containerWidth = this.parentElement?.getBoundingClientRect().width ?? 0;
    this.classList.add("dragging");
    this.parentElement?.classList.add("split-resizing");

    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
    window.addEventListener("blur", this.handleMouseUp);

    e.preventDefault();
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (!this.isDragging) {
      return;
    }
    // 拖拽中在窗口外释放鼠标时不会派发 mouseup，拖拽会永久挂起且分割条幽灵跟随。
    // buttons=0 表示无按键，等价于补偿丢失的 mouseup。
    if (e.buttons === 0) {
      this.handleMouseUp();
      return;
    }

    const container = this.parentElement;
    if (!container) {
      return;
    }

    const containerWidth = this.containerWidth;
    if (containerWidth <= 0) return;
    const deltaX = e.clientX - this.startX;
    const deltaRatio = deltaX / containerWidth;

    let newRatio = this.startRatio + deltaRatio;
    newRatio = Math.max(this.minRatio, Math.min(this.maxRatio, newRatio));

    this.splitRatio = newRatio;
    // 与会话列表一致：拖动仅改布局，结束才触发应用状态与持久化。
    const main = container.querySelector<HTMLElement>(".chat-main");
    if (main) main.style.flex = `0 1 ${newRatio * 100}%`;
    else if (container.classList.contains("wk-layout")) container.style.setProperty("--wk-nav-ratio", String(newRatio));
  };

  private handleMouseUp = () => this.finishDrag();
  private finishDrag(commit = true) {
    const wasDragging = this.isDragging;
    this.isDragging = false;
    this.classList.remove("dragging");
    this.parentElement?.classList.remove("split-resizing");
    if (commit && wasDragging && this.splitRatio !== this.startRatio) this.dispatchEvent(new CustomEvent("resize", {
      detail: { splitRatio: this.splitRatio }, bubbles: true, composed: true,
    }));

    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("blur", this.handleMouseUp);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-resizable-divider": OcResizableDivider;
  }
}
