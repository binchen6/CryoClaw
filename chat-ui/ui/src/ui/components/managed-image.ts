import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";
import { fetchManagedImageObjectUrl, isManagedMediaUrl } from "../chat/managed-media.ts";

/**
 * 消息图片渲染组件（阶段 18 图文混排）。
 * - 网关托管媒体（/api/chat/media/... 相对路径，强制 Bearer 头）：fetch 转 blob object URL 后渲染
 * - data:/http(s)/blob: 直链：直接渲染
 * 加载中/失败显示占位，不阻塞消息流。
 */
@customElement("oc-managed-img")
export class ManagedImage extends LitElement {
  static properties = {
    src: { type: String },
    alt: { type: String },
    resolvedSrc: { state: true },
    failed: { state: true },
    expanded: { state: true },
  };

  src = "";
  alt = "";
  private resolvedSrc: string | null = null;
  private failed = false;
  private expanded = false;
  private loadToken = 0;

  static styles = css`
    :host {
      display: block;
    }
    img {
      display: block;
      max-width: min(480px, 100%);
      max-height: 360px;
      object-fit: contain;
      border-radius: var(--radius-md, 12px);
      border: 1px solid var(--border, #2a2c31);
      cursor: zoom-in;
      background: var(--bg-elevated, #1e2024);
    }
    img.expanded {
      max-width: 100%;
      max-height: none;
      cursor: zoom-out;
    }
    .placeholder {
      display: flex;
      align-items: center;
      gap: var(--spacer-8, 8px);
      padding: var(--spacer-12, 14px) var(--spacer-16, 16px);
      border-radius: var(--radius-md, 12px);
      border: 1px dashed var(--border, #2a2c31);
      color: var(--text-muted, #71717a);
      font-family: var(--font-meta, ui-monospace, monospace);
      font-size: var(--font-size-meta, 11px);
      max-width: 480px;
      box-sizing: border-box;
    }
    .placeholder__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent, #0ea5e9);
      animation: ocMediaPulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes ocMediaPulse {
      0%, 100% { opacity: 0.35; }
      50% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .placeholder__dot { animation: none; }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.load();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("src")) {
      this.load();
    }
  }

  private async load() {
    const src = this.src;
    const token = ++this.loadToken;
    this.failed = false;
    if (!src) {
      this.resolvedSrc = null;
      return;
    }
    if (!isManagedMediaUrl(src)) {
      this.resolvedSrc = src;
      return;
    }
    this.resolvedSrc = null; // 加载中 → 占位
    const objectUrl = await fetchManagedImageObjectUrl(src);
    if (token !== this.loadToken) {
      return; // src 已变化或组件重建，丢弃过期结果
    }
    if (objectUrl) {
      this.resolvedSrc = objectUrl;
    } else {
      this.failed = true;
    }
  }

  // 点击切换展开/收起：blob object URL 无法跨窗口打开（openExternal 不支持 blob:），
  // 且无 setWindowOpenHandler，新窗口行为不可控——就地展开最稳
  private toggleExpand() {
    this.expanded = !this.expanded;
  }

  render() {
    if (this.resolvedSrc) {
      return html`<img
        class=${this.expanded ? "expanded" : ""}
        src=${this.resolvedSrc}
        alt=${this.alt || "image"}
        @click=${this.toggleExpand}
      />`;
    }
    if (this.failed) {
      return html`<div class="placeholder">⚠ ${this.alt || "image"}</div>`;
    }
    return html`<div class="placeholder">
      <span class="placeholder__dot" aria-hidden="true"></span>${this.alt || "image"}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-managed-img": ManagedImage;
  }
}
