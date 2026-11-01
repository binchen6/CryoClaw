import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";

type BrowserState = {
  visible: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export function normalizeBrowserInput(raw: string, searchEngine: "google" | "bing" | "baidu"): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/i.test(value)) return `https://${value}`;
  const query = encodeURIComponent(value);
  return searchEngine === "baidu"
    ? `https://www.baidu.com/s?wd=${query}`
    : searchEngine === "bing"
      ? `https://www.bing.com/search?q=${query}`
      : `https://www.google.com/search?q=${query}`;
}

@customElement("oc-embedded-browser")
export class OcEmbeddedBrowser extends LitElement {
  static properties = {
    url: { attribute: false },
    zoom: { attribute: false },
    downloadPath: { attribute: false },
    askSavePath: { attribute: false },
    maxBytes: { attribute: false },
    userAgent: { attribute: false },
    searchEngine: { attribute: false },
  };

  url = "about:blank";
  zoom = 1;
  downloadPath = "";
  askSavePath = true;
  maxBytes = 1024 * 1024 * 1024;
  userAgent = "";
  searchEngine: "google" | "bing" | "baidu" = "google";
  private draft = "";
  private state: BrowserState | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cleanup: (() => void) | null = null;
  private syncQueue: Promise<void> = Promise.resolve();
  private active = false;
  private error = "";

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.active = true;
    this.cleanup = window.cryoclaw?.onEmbeddedBrowserState?.((raw) => {
      this.state = raw as BrowserState;
      if (this.state.url) {
        this.url = this.state.url;
        this.draft = this.state.url === "about:blank" ? "" : this.state.url;
      }
      this.requestUpdate();
    }) ?? null;
  }

  firstUpdated() {
    const host = this.querySelector<HTMLElement>(".embedded-browser__viewport");
    this.resizeObserver = new ResizeObserver(() => this.queueSync(true));
    if (host) this.resizeObserver.observe(host);
    this.queueSync(false);
  }

  updated(changed: Map<PropertyKey, unknown>) {
    if (["zoom", "downloadPath", "askSavePath", "maxBytes", "userAgent"].some((key) => changed.has(key))) {
      void window.cryoclaw?.embeddedBrowserPreferences?.(this.preferences()).catch(() => {});
    }
  }

  disconnectedCallback() {
    this.active = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cleanup?.();
    this.cleanup = null;
    void window.cryoclaw?.embeddedBrowserHide?.().catch(() => {});
    super.disconnectedCallback();
  }

  private preferences() {
    return {
      zoom: this.zoom,
      downloadPath: this.downloadPath || undefined,
      askSavePath: this.askSavePath,
      maxBytes: this.maxBytes,
      userAgent: this.userAgent || undefined,
    };
  }

  private queueSync(boundsOnly: boolean) {
    this.syncQueue = this.syncQueue.then(() => this.sync(boundsOnly)).catch((error) => {
      this.error = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
    });
  }

  private async sync(boundsOnly: boolean) {
    if (!this.active) return;
    const host = this.querySelector<HTMLElement>(".embedded-browser__viewport");
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    if (boundsOnly) {
      await window.cryoclaw?.embeddedBrowserBounds?.(bounds);
    } else {
      await window.cryoclaw?.embeddedBrowserShow?.({ bounds, url: this.url, preferences: this.preferences() });
    }
    if (!this.active) await window.cryoclaw?.embeddedBrowserHide?.().catch(() => {});
  }

  private navigate(raw = this.draft) {
    const target = normalizeBrowserInput(raw, this.searchEngine);
    if (!target) return;
    this.error = "";
    this.url = target;
    this.draft = target;
    void window.cryoclaw?.embeddedBrowserNavigate?.(target).catch((error) => {
      this.error = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
    });
  }

  render() {
    return html`<section class="embedded-browser">
      <div class="embedded-browser__toolbar">
        <button class="icon-btn icon-btn--sm" type="button" aria-label=${t("workspace.browser.back")}
          ?disabled=${!this.state?.canGoBack} @click=${() => void window.cryoclaw?.embeddedBrowserAction?.("back")}>${icons.arrowLeft}</button>
        <button class="icon-btn icon-btn--sm" type="button" aria-label=${t("workspace.browser.forward")}
          ?disabled=${!this.state?.canGoForward} @click=${() => void window.cryoclaw?.embeddedBrowserAction?.("forward")}>${icons.arrowRight}</button>
        <button class="icon-btn icon-btn--sm" type="button" aria-label=${t("workspace.refresh")}
          @click=${() => void window.cryoclaw?.embeddedBrowserAction?.("reload")}>${this.state?.loading ? icons.loader : icons.refreshCw}</button>
        <input class="embedded-browser__address" type="text" .value=${this.draft}
          aria-label=${t("dock.browser")} placeholder=${t("browser.addressPlaceholder")}
          @input=${(event: Event) => { this.draft = (event.target as HTMLInputElement).value; }}
          @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter") this.navigate(); }} />
        <button class="icon-btn icon-btn--sm" type="button" aria-label=${t("sidebar.fullUI")}
          @click=${() => void window.cryoclaw?.openExternal?.(this.state?.url || this.url)}>${icons.externalLink}</button>
      </div>
      ${this.error ? html`<div class="embedded-browser__error" role="alert">${this.error}</div>` : nothing}
      <div class="embedded-browser__viewport" aria-label=${this.state?.title || this.url}></div>
      ${!this.state ? html`<div class="embedded-browser__status" role="status">${t("chat.loading")}</div>` : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-embedded-browser": OcEmbeddedBrowser;
  }
}
