import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import { placePopover } from "../utils/popover-placement.ts";
import { prefersReducedMotion } from "../utils/motion.ts";

type BrowserState = {
  visible: boolean; url: string; title: string; loading: boolean;
  canGoBack: boolean; canGoForward: boolean; error?: string;
  tabId?: number; tabs?: Array<{ id: number; url: string; title: string }>;
  device?: { width: number; height: number } | null;
};
export function normalizeBrowserInput(raw: string, searchEngine: "google" | "bing" | "baidu"): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value === "about:blank") return value;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/i.test(value)) return `https://${value}`;
  const query = encodeURIComponent(value);
  return searchEngine === "baidu" ? `https://www.baidu.com/s?wd=${query}` : searchEngine === "bing" ? `https://www.bing.com/search?q=${query}` : `https://www.google.com/search?q=${query}`;
}

@customElement("oc-embedded-browser")
export class OcEmbeddedBrowser extends LitElement {
  static properties = Object.fromEntries(["url", "zoom", "downloadPath", "askSavePath", "maxBytes", "userAgent", "searchEngine", "agentEnabled", "onAgentToggle", "onSettings", "onReference", "onZoom", "contextKey", "compactInDock"].map(key => [key, { attribute: false }]));
  url = "about:blank"; zoom = 1; downloadPath = ""; askSavePath = true;
  maxBytes = 1024 * 1024 * 1024; userAgent = "";
  searchEngine: "google" | "bing" | "baidu" = "google";
  agentEnabled = false;
  compactInDock = false;
  contextKey = "";
  onAgentToggle?: () => void;
  onSettings?: () => void;
  onZoom?: (zoom: number) => void;
  onReference?: (reference: { url: string; title: string; text: string; screenshot?: string }) => void;
  private draft = "";
  private state: BrowserState | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cleanup: (() => void) | null = null;
  private active = false;
  private generation = 0;
  private frame = 0;
  private syncing = false;
  private pending = false;
  private error = "";
  private menuId = `browser-menu-${Math.random().toString(36).slice(2)}`;
  private panel: "menu" | "history" | "downloads" | "device" = "menu";
  private records: Array<Record<string, any>> = [];
  private preview: string | null = null;
  private findOpen = false;
  private findText = "";
  private annotating = false;
  private annotation: Record<string, any> | null = null;
  private annotationComment = "";
  private annotationScreenshot = true;
  private annotationRequest = "";
  private annotationGeneration = 0;
  private annotationTabId?: number;
  private menuGeneration = 0;
  private chromeOverlayViewId?: number;
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback(); this.active = true;
    const generation = ++this.generation;
    this.cleanup = window.cryoclaw?.onEmbeddedBrowserState?.(raw => this.acceptState(raw)) ?? null;
    void this.updateComplete.then(async () => {
      if (!this.active || generation !== this.generation) return;
      this.resizeObserver = new ResizeObserver(this.queueBounds);
      const viewport = this.querySelector<HTMLElement>(".embedded-browser__viewport");
      if (viewport) this.resizeObserver.observe(viewport);
      window.addEventListener("resize", this.queueBounds);
      await this.sync(false);
    });
  }
  updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has("contextKey") && changed.get("contextKey") !== undefined) void this.closeAnnotation();
    if (["zoom", "downloadPath", "askSavePath", "maxBytes", "userAgent"].some(key => changed.has(key))) void this.run(() => window.cryoclaw?.embeddedBrowserPreferences?.(this.preferences()));
  }
  disconnectedCallback() {
    this.active = false; this.generation++;
    this.annotationGeneration++; this.menuGeneration++;
    this.annotation = null; this.preview = null;
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    cancelAnimationFrame(this.frame); this.frame = 0;
    window.removeEventListener("resize", this.queueBounds);
    this.cleanup?.(); this.cleanup = null;
    this.closeMenu();
    void window.cryoclaw?.embeddedBrowserHide?.().catch(() => {});
    super.disconnectedCallback();
  }
  private acceptState(raw: unknown) {
    if (!this.active || !raw || typeof raw !== "object") return;
    const next = raw as BrowserState;
    if (this.state?.tabId !== next.tabId && (this.annotation || this.annotating)) void this.closeAnnotation();
    this.state = next;
    this.url = this.state.url || "about:blank";
    if (document.activeElement !== this.querySelector(".embedded-browser__address")) this.draft = this.url === "about:blank" ? "" : this.url;
    this.error = this.state.error ?? ""; this.requestUpdate();
  }
  private preferences() { return { zoom: this.zoom, downloadPath: this.downloadPath, askSavePath: this.askSavePath, maxBytes: this.maxBytes, userAgent: this.userAgent }; }
  private queueBounds = () => {
    if (!this.active || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; void this.sync(true); this.positionAnnotation(); });
  };
  private async sync(boundsOnly: boolean) {
    if (!this.active) return;
    if (this.syncing) { this.pending = true; return; }
    const rect = this.querySelector<HTMLElement>(".embedded-browser__viewport")?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return;
    const generation = this.generation; this.syncing = true;
    try {
      const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const result = boundsOnly ? await window.cryoclaw?.embeddedBrowserBounds?.(bounds) : await window.cryoclaw?.embeddedBrowserShow?.({ bounds, url: this.url, preferences: this.preferences() });
      if (this.active && generation === this.generation) this.acceptState(result);
    } catch (error) { this.reportError(error); }
    finally { this.syncing = false; if (this.pending) { this.pending = false; this.queueBounds(); } }
  }
  private reportError(error: unknown) { if (this.active) { this.error = error instanceof Error ? error.message : String(error); this.requestUpdate(); } }
  private async run(action: () => unknown) {
    try { const result: any = await action(); if (result?.tabId !== undefined && Array.isArray(result.tabs)) this.acceptState(result); return result; }
    catch (error) { this.reportError(error); return undefined; }
  }
  private utility(action: string, params: Record<string, unknown> = {}) { return this.run(() => window.cryoclaw?.embeddedBrowserUtility?.({ action, ...params })); }
  private closeMenu() { this.querySelector<HTMLElement>("[popover]")?.hidePopover(); }
  private navigate(raw = this.draft) {
    const target = normalizeBrowserInput(raw, this.searchEngine);
    if (!target) return;
    this.closeMenu(); this.error = ""; this.draft = target;
    void this.run(() => window.cryoclaw?.embeddedBrowserNavigate?.(target));
  }
  private async toggleMenu(event: Event) {
    const open = (event as Event & { newState: string }).newState === "open";
    if (open) { this.panel = "menu"; this.records = []; }
    if (await this.setChromeOverlay(open) && open) this.positionMenu();
  }
  /** Shared by browser chrome and the outer Dock menu above the native web view. */
  async setChromeOverlay(open: boolean): Promise<boolean> {
    if (!this.active) return false;
    const generation = ++this.menuGeneration;
    const viewId = open ? this.state?.tabId : this.chromeOverlayViewId ?? this.state?.tabId;
    if (open) this.chromeOverlayViewId = viewId;
    const visible = open || Boolean(this.annotation || this.annotating);
    const result = await this.utility("overlay", { visible, viewId });
    if (!this.active || generation !== this.menuGeneration || (open && this.state?.tabId !== viewId)) return false;
    this.preview = visible ? result?.preview ?? this.preview : null;
    if (!open) this.chromeOverlayViewId = undefined;
    this.requestUpdate(); await this.updateComplete;
    return this.active && generation === this.menuGeneration;
  }
  private positionMenu() {
    const menu = this.querySelector<HTMLElement>("[popover]");
    const trigger = this.querySelector<HTMLElement>(".embedded-browser__more");
    if (!menu || !trigger) return;
    const position = placePopover({ anchor: trigger.getBoundingClientRect(), panel: menu.getBoundingClientRect(), viewport: { width: innerWidth, height: innerHeight }, candidates: [{ side: "bottom", align: "end" }, { side: "top", align: "end" }], avoid: [trigger.getBoundingClientRect()] });
    Object.assign(menu.style, { left: `${position.left}px`, top: `${position.top}px` });
  }
  private async showRecords(panel: "history" | "downloads") {
    const result = await this.utility(panel);
    this.records = Array.isArray(result) ? result : []; this.panel = panel;
    this.requestUpdate(); await this.updateComplete; this.positionMenu();
  }
  private async annotate() {
    this.closeMenu(); this.annotating = true; this.requestUpdate();
    const generation = ++this.annotationGeneration;
    const contextKey = this.contextKey;
    const viewId = this.annotationTabId = this.state?.tabId;
    this.annotationRequest = crypto.randomUUID();
    try {
      const reference = await this.utility("annotate", { requestId: this.annotationRequest, viewId, reducedMotion: prefersReducedMotion(), accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() });
      if (reference?.url && this.active && generation === this.annotationGeneration && contextKey === this.contextKey) {
        await import("./toggle-switch.ts");
        if (!this.active || generation !== this.annotationGeneration) return;
        this.annotation = reference; this.annotationComment = "";
        const capture = await this.utility("overlay", { visible: true, viewId });
        if (!this.active || generation !== this.annotationGeneration) return;
        this.preview = capture?.preview ?? null;
        this.requestUpdate(); await this.updateComplete;
        this.querySelector<HTMLTextAreaElement>(".embedded-browser__annotation textarea")?.focus();
        this.positionAnnotation();
      }
    }
    finally { if (generation === this.annotationGeneration) { this.annotating = false; this.requestUpdate(); await this.updateComplete; this.positionAnnotation(); } }
  }
  private async closeAnnotation() {
    const generation = ++this.annotationGeneration;
    this.annotation = null; this.annotating = false; this.preview = null; this.requestUpdate();
    const viewId = this.annotationTabId;
    await this.utility("clear-annotation", { requestId: this.annotationRequest, viewId });
    if (generation === this.annotationGeneration && !this.querySelector(":popover-open")) await this.utility("overlay", { visible: false, viewId });
  }
  private positionAnnotation() {
    const ref = this.annotation;
    const card = this.querySelector<HTMLElement>(".embedded-browser__annotation");
    const viewport = this.querySelector<HTMLElement>(".embedded-browser__viewport")?.getBoundingClientRect();
    if (!ref || !card || !viewport) return;
    const scale = this.state?.device ? Math.min(1, viewport.width / ref.viewport.width, viewport.height / ref.viewport.height) : ref.zoom || 1;
    const anchor = { left: viewport.left + ref.rect.x * scale, top: viewport.top + ref.rect.y * scale, width: ref.rect.width * scale, height: ref.rect.height * scale };
    const spaces = [innerHeight - anchor.top - anchor.height - 24, anchor.top - 24];
    const horizontalSpace = Math.max(anchor.left - 24, innerWidth - anchor.left - anchor.width - 24);
    const availableHeight = Math.max(...spaces);
    const cardWidth = Math.min(560, innerWidth - 24);
    // A compact scrollable inspector can sit above/below even a full-width element.
    card.style.width = `${horizontalSpace >= 300 ? Math.min(cardWidth, horizontalSpace) : cardWidth}px`;
    card.style.maxHeight = `${Math.max(120, horizontalSpace >= 300 ? innerHeight - 24 : availableHeight)}px`;
    const position = placePopover({ anchor, panel: card.getBoundingClientRect(), viewport: { width: innerWidth, height: innerHeight }, gap: 12, candidates: [{ side: "right", align: "start" }, { side: "left", align: "start" }, { side: "bottom", align: "start" }, { side: "top", align: "start" }], avoid: [anchor] });
    Object.assign(card.style, { position: "fixed", left: `${position.left}px`, top: `${position.top}px` });
  }
  private insertClass(name: string) {
    const field = this.querySelector<HTMLTextAreaElement>(".embedded-browser__annotation textarea");
    if (!field) return;
    const start = field.selectionStart, end = field.selectionEnd;
    this.annotationComment = `${field.value.slice(0, start)}${name}${field.value.slice(end)}`;
    field.value = this.annotationComment; field.focus(); field.setSelectionRange(start + name.length, start + name.length);
  }
  private addAnnotation() {
    const reference = this.annotation;
    if (!reference) return;
    const text = `[${t("browser.annotation")} 1] ${reference.text}\nID: ${reference.id || "—"}\n${t("browser.classes")}: ${reference.classes.join(" ")}\nSelector: ${reference.selector}\nXPath: ${reference.xpath}\n${t("browser.geometry")}: ${JSON.stringify(reference.rect)}\n${t("browser.semantics")}: ${JSON.stringify({ tag: reference.tag, role: reference.role, label: reference.label, href: reference.href, name: reference.name, disabled: reference.disabled })}\n${t("browser.viewport")}: ${JSON.stringify(reference.viewport)}, zoom=${reference.zoom}\n${t("browser.capturedAt")}: ${reference.capturedAt}${this.annotationComment.trim() ? `\n${t("browser.comment")}: ${this.annotationComment.trim()}` : ""}`;
    this.onReference?.({ url: reference.url, title: reference.title, text, screenshot: this.annotationScreenshot ? this.preview ?? undefined : undefined });
    void this.closeAnnotation();
  }
  private renderAnnotation() {
    const ref = this.annotation;
    if (!ref) return nothing;
    return html`<div class="embedded-browser__annotation-shade"><section class="embedded-browser__annotation" role="dialog" aria-modal="true" aria-label=${t("browser.annotation")} @keydown=${(event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); void this.closeAnnotation(); }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); this.addAnnotation(); }
      if (event.key === "Tab") {
        const controls = Array.from(this.querySelectorAll<HTMLElement>(".embedded-browser__annotation button,.embedded-browser__annotation summary,.embedded-browser__annotation textarea")).filter(element => element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><span class="embedded-browser__annotation-number">1</span><strong>${t("browser.annotation")}</strong><code>${ref.tag}</code>${this.iconButton("x", t("browser.cancelAnnotation"), () => this.closeAnnotation())}</header>
      <dl class="embedded-browser__annotation-identity"><dt>ID</dt><dd>${ref.id || "—"}</dd><dt>${t("browser.classes")}</dt><dd>${ref.classes.map((name: string) => html`<span class="embedded-browser__class"><code>${name}</code><button type="button" title=${t("browser.copyClass")} aria-label=${`${t("browser.copyClass")} ${name}`} @click=${() => void navigator.clipboard.writeText(name).catch(error => this.reportError(error))}>${icons.copy}</button><button type="button" title=${t("browser.insertClass")} aria-label=${`${t("browser.insertClass")} ${name}`} @click=${() => this.insertClass(name)}>${icons.plus}</button></span>`)}</dd></dl>
      <details @toggle=${() => this.positionAnnotation()}><summary>${t("browser.geometry")}</summary><dl><dt>Selector</dt><dd class="embedded-browser__copy-value"><code>${ref.selector}</code>${this.copyValue(ref.selector, "browser.copySelector")}</dd><dt>XPath</dt><dd class="embedded-browser__copy-value"><code>${ref.xpath}</code>${this.copyValue(ref.xpath, "browser.copyXPath")}</dd><dt>X / Y</dt><dd>${ref.rect.x} / ${ref.rect.y}</dd><dt>${t("browser.width")} × ${t("browser.height")}</dt><dd>${ref.rect.width} px × ${ref.rect.height} px</dd></dl></details>
      <details @toggle=${() => this.positionAnnotation()}><summary>${t("browser.semantics")}</summary><dl><dt>text</dt><dd>${ref.text || "—"}</dd><dt>href</dt><dd>${ref.href || "—"}</dd><dt>name</dt><dd>${ref.name || "—"}</dd><dt>role</dt><dd>${ref.role || "—"}</dd><dt>aria-label</dt><dd>${ref.label || "—"}</dd><dt>${t("browser.disabled")}</dt><dd>${String(ref.disabled)}</dd></dl></details>
      <details @toggle=${() => this.positionAnnotation()}><summary>${t("browser.captureInfo")}</summary><dl><dt>${t("browser.pageTitle")}</dt><dd>${ref.title}</dd><dt>URL</dt><dd>${ref.url}</dd><dt>${t("browser.capturedAt")}</dt><dd>${new Date(ref.capturedAt).toLocaleString()}</dd><dt>${t("browser.viewport")}</dt><dd>${ref.viewport.width} × ${ref.viewport.height} · ${Math.round(ref.zoom * 100)}%</dd><dt>${t("browser.pixelRatio")}</dt><dd>${ref.viewport.devicePixelRatio}</dd></dl></details>
      <oc-toggle-switch .checked=${this.annotationScreenshot} .label=${t("browser.includeScreenshot")} @change=${(event: CustomEvent) => { this.annotationScreenshot = Boolean(event.detail.checked); }}></oc-toggle-switch>
      <label class="embedded-browser__annotation-comment">${t("browser.comment")}<textarea rows="3" .value=${this.annotationComment} placeholder=${t("browser.commentPlaceholder")} @input=${(event: Event) => { this.annotationComment = (event.target as HTMLTextAreaElement).value; }}></textarea></label>
      <footer><button class="btn" type="button" @click=${() => void this.closeAnnotation()}>${t("browser.cancelAnnotation")}</button><button class="btn primary" type="button" @click=${() => this.addAnnotation()}>${t("browser.addToComposer")} <kbd>Ctrl ↵</kbd></button></footer>
    </section></div>`;
  }
  private changeZoom(value: number) { this.onZoom?.(Math.min(2, Math.max(0.5, value))); }
  private iconButton(icon: keyof typeof icons, label: string, action: () => unknown, disabled = false, pressed?: boolean) {
    return html`<button class="icon-btn icon-btn--sm" type="button" title=${label} aria-label=${label} aria-pressed=${pressed === undefined ? nothing : String(pressed)} ?disabled=${disabled} @click=${action}>${icons[icon]}</button>`;
  }
  private menuItem(icon: keyof typeof icons, label: string, action: () => unknown) { return html`<button type="button" @click=${action}>${icons[icon]}<span>${label}</span></button>`; }
  private copyValue(value: string, label: string) { return this.iconButton("copy", t(label), () => navigator.clipboard.writeText(value).catch(error => this.reportError(error))); }
  private renderMenu() {
    const back = () => this.menuItem("arrowLeft", t("browser.menu"), () => { this.panel = "menu"; this.requestUpdate(); });
    if (this.panel === "history" || this.panel === "downloads") return html`${back()}<strong class="embedded-browser__panel-title">${t(this.panel === "history" ? "browser.history" : "browser.downloads")}</strong><p class="embedded-browser__panel-hint">${t("browser.sessionRecords")}</p>${this.records.length ? this.records.map(record => this.menuItem(this.panel === "history" ? "history" : "download", this.panel === "history" ? record.title || record.url : `${record.name} · ${record.state}`, () => { if (this.panel === "history") this.navigate(record.url); else void this.utility("show-download", { id: record.id }); })) : html`<p class="embedded-browser__panel-hint">${t("browser.noRecords")}</p>`}`;
    if (this.panel === "device") return html`${back()}${[[0, 0, "browser.desktop"], [390, 844, "browser.mobile"], [768, 1024, "browser.tablet"]].map(([width, height, label]) => this.menuItem("monitor", t(String(label)), () => { void this.utility("device", { width, height }); this.closeMenu(); }))}<form class="embedded-browser__device-form" @submit=${(event: SubmitEvent) => { event.preventDefault(); const data = new FormData(event.target as HTMLFormElement); void this.utility("device", { width: Number(data.get("width")), height: Number(data.get("height")) }); this.closeMenu(); }}><label>${t("browser.width")}<input name="width" type="number" min="240" max="2560" value="1280" required /></label><label>${t("browser.height")}<input name="height" type="number" min="240" max="2560" value="800" required /></label><button type="submit">${t("browser.apply")}</button></form>`;
    return html`
      ${this.compactInDock ? this.menuItem("x", t("browser.closeTab"), () => { this.closeMenu(); void this.utility("close-tab", { tabId: this.state?.tabId }); }) : nothing}
      ${this.menuItem("search", t("browser.find"), () => { this.closeMenu(); this.findOpen = true; this.requestUpdate(); void this.updateComplete.then(() => this.querySelector<HTMLInputElement>(".embedded-browser__find input")?.focus()); })}
      ${this.menuItem("fileText", t("browser.print"), () => { this.closeMenu(); void this.utility("print"); })}
      <div class="embedded-browser__zoom"><span>${icons.search}${t("settings.browser.zoom")}</span>${this.iconButton("minus", t("browser.zoomOut"), () => this.changeZoom(this.zoom - 0.1))}<output>${Math.round(this.zoom * 100)}%</output>${this.iconButton("plus", t("browser.zoomIn"), () => this.changeZoom(this.zoom + 0.1))}${this.iconButton("rotateCcw", t("browser.resetZoom"), () => this.changeZoom(1))}</div>
      ${this.menuItem("monitor", t("browser.device"), () => { this.panel = "device"; this.requestUpdate(); })}
      ${this.menuItem("eye", t("browser.focus"), () => { this.closeMenu(); void this.utility("focus"); })}
      ${this.menuItem("image", t("browser.screenshot"), () => { this.closeMenu(); void this.utility("screenshot"); })}<hr />
      ${this.menuItem("download", t("browser.downloads"), () => void this.showRecords("downloads"))}
      ${this.menuItem("history", t("browser.history"), () => void this.showRecords("history"))}
      ${this.menuItem("trash2", t("browser.clearData"), () => { this.closeMenu(); void this.utility("clear-data"); })}<hr />
      ${this.menuItem("settings", t("browser.settings"), () => { this.closeMenu(); this.onSettings?.(); })}`;
  }
  render() {
    const blank = !this.state?.url || this.state.url === "about:blank";
    const showWebTabs = !this.compactInDock || (this.state?.tabs?.length ?? 0) > 1;
    return html`<section class="embedded-browser">
      ${showWebTabs ? html`<div class="embedded-browser__tabs" role="tablist" aria-label=${t("dock.browser")}>${(this.state?.tabs ?? []).map(tab => html`<span class="embedded-browser__tab ${tab.id === this.state?.tabId ? "is-active" : ""}"><button type="button" role="tab" aria-selected=${String(tab.id === this.state?.tabId)} @click=${() => void this.utility("select-tab", { tabId: tab.id })}>${icons.globe}<span>${tab.title || t("browser.newTab")}</span></button>${this.iconButton("x", t("browser.closeTab"), () => void this.utility("close-tab", { tabId: tab.id }))}</span>`)}${this.iconButton("plus", t("browser.newTab"), () => void this.utility("new-tab"))}</div>` : nothing}
      <div class="embedded-browser__toolbar">
        ${this.iconButton("arrowLeft", t("workspace.browser.back"), () => this.run(() => window.cryoclaw?.embeddedBrowserAction?.("back")), !this.state?.canGoBack)}
        ${this.iconButton("arrowRight", t("workspace.browser.forward"), () => this.run(() => window.cryoclaw?.embeddedBrowserAction?.("forward")), !this.state?.canGoForward)}
        ${this.iconButton(this.state?.loading ? "loader" : "refreshCw", t("workspace.refresh"), () => this.run(() => window.cryoclaw?.embeddedBrowserAction?.("reload")))}
        <label class="embedded-browser__address-wrap">${icons.info}<input class="embedded-browser__address" type="text" .value=${this.draft} aria-label=${t("browser.addressPlaceholder")} placeholder=${t("browser.addressPlaceholder")} @input=${(event: Event) => { this.draft = (event.target as HTMLInputElement).value; }} @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter") this.navigate(); }} /></label>
        ${!showWebTabs ? this.iconButton("plus", t("browser.newTab"), () => void this.utility("new-tab")) : nothing}
        ${this.iconButton("externalLink", t("browser.openExternal"), () => this.run(() => window.cryoclaw?.openExternal?.(this.state?.url || this.url)), blank)}
        ${this.iconButton("crosshair", t("browser.annotate"), () => void this.annotate(), blank || this.annotating, this.annotating)}
        <button class="icon-btn icon-btn--sm embedded-browser__more" type="button" title=${t("browser.menu")} aria-label=${t("browser.menu")} ?disabled=${Boolean(this.annotation || this.annotating)} popovertarget=${this.menuId}>${icons.moreHorizontal}</button>
      </div>
      ${this.findOpen ? html`<form class="embedded-browser__find" @submit=${(event: Event) => { event.preventDefault(); void this.utility("find", { text: this.findText, next: true }); }}><input aria-label=${t("browser.find")} placeholder=${t("browser.find")} .value=${this.findText} @input=${(event: Event) => { this.findText = (event.target as HTMLInputElement).value; void this.utility("find", { text: this.findText }); }} @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { this.findOpen = false; void this.utility("stop-find"); this.requestUpdate(); } }} />${this.iconButton("arrowLeft", t("browser.previousMatch"), () => this.utility("find", { text: this.findText, next: true, forward: false }))}${this.iconButton("arrowRight", t("browser.nextMatch"), () => this.utility("find", { text: this.findText, next: true }))}${this.iconButton("x", t("browser.closeFind"), () => { this.findOpen = false; void this.utility("stop-find"); this.requestUpdate(); })}</form>` : nothing}
      ${this.error ? html`<div class="embedded-browser__error" role="alert">${this.error}</div>` : nothing}
      ${this.annotating || this.annotation ? html`<div class="embedded-browser__notice embedded-browser__annotation-status" role="status">${this.annotation ? t("browser.annotation") : t("browser.annotateHint")}</div>` : nothing}
      ${this.state?.device ? html`<div class="embedded-browser__notice">${this.state.device.width} × ${this.state.device.height}${this.iconButton("x", t("browser.desktop"), () => this.utility("device", { width: 0 }))}</div>` : nothing}
      <div class="embedded-browser__viewport" aria-label=${this.state?.title || t("dock.browser")}>
        ${this.preview ? html`<img class="embedded-browser__preview" src=${this.preview} alt="" />` : nothing}
        ${blank ? html`<div class="embedded-browser__welcome"><h3>${t("browser.newTab")}</h3><p>${t("browser.welcomeHint")}</p><dl>${([ ["globe", "browse"], ["fileText", "read"], ["mousePointer", "interact"], ["monitor", "layout"], ["history", "recall"] ] as const).map(([icon, feature]) => html`<div>${icons[icon]}<dt>${t(`browser.feature.${feature}`)}</dt><dd>${t(`browser.feature.${feature}Hint`)}</dd></div>`)}</dl><p class="embedded-browser__takeover">${t("browser.takeoverHint")}</p></div>` : nothing}
      </div>
      <div class="embedded-browser__agent"><span>${this.agentEnabled ? t("browser.agentReady") : t("browser.userControl")}</span><button type="button" @click=${() => this.onAgentToggle?.()}>${this.agentEnabled ? t("browser.takeover") : t("browser.allowAgent")}</button></div>
      ${this.renderAnnotation()}
      <div class="embedded-browser__menu" id=${this.menuId} popover="auto" @beforetoggle=${(event: Event) => void this.toggleMenu(event)}>${this.renderMenu()}</div>
    </section>`;
  }
}
declare global { interface HTMLElementTagNameMap { "oc-embedded-browser": OcEmbeddedBrowser; } }
