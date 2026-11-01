import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import type { UiSettings } from "../../storage.ts";
import { t } from "../../i18n.ts";
let controlsPromise: Promise<unknown> | null = null;
let controlsLoaded = false;

export function renderTabBrowser(state: AppViewState) {
  if (!controlsLoaded) {
    controlsPromise ??= import("../../components/toggle-switch.ts");
    void controlsPromise.then(() => {
      controlsLoaded = true;
      state.requestUpdate();
    });
    return html`<section class="oc-settings-section" data-page-id="settings:browser" data-load-state="loading"><p class="oc-settings__hint">${t("chat.loading")}</p></section>`;
  }
  const settings = state.settings;
  const update = (patch: Partial<UiSettings>) => state.applySettings({ ...settings, ...patch });
  return html`<section class="oc-settings-section" data-page-id="settings:browser" data-load-state="ready" aria-busy="false">
    <header class="oc-settings__header">
      <h2>${t("settings.nav.browser")}</h2>
      <p class="oc-settings__hint">${t("settings.browser.hint")}</p>
    </header>
    <div class="oc-settings__group">
      <oc-toggle-switch
        .checked=${settings.embeddedBrowserEnabled}
        .label=${t("settings.browser.enable")}
        @change=${(event: CustomEvent) => update({ embeddedBrowserEnabled: !!event.detail.checked })}
      ></oc-toggle-switch>
      <oc-toggle-switch
        .checked=${settings.embeddedBrowserAgentEnabled}
        .disabled=${!settings.embeddedBrowserEnabled}
        .label=${t("settings.browser.agent")}
        @change=${(event: CustomEvent) => update({ embeddedBrowserAgentEnabled: !!event.detail.checked })}
      ></oc-toggle-switch>
      <label class="field"><span>${t("settings.browser.searchEngine")}</span><select
        .value=${settings.embeddedBrowserSearchEngine}
        @change=${(event: Event) => update({ embeddedBrowserSearchEngine: (event.target as HTMLSelectElement).value as UiSettings["embeddedBrowserSearchEngine"] })}>
        <option value="google">Google</option><option value="bing">Bing</option><option value="baidu">Baidu</option>
      </select></label>
      <label class="field"><span>${t("settings.browser.priority")}</span><select
        .value=${settings.embeddedBrowserPriority}
        @change=${(event: Event) => update({ embeddedBrowserPriority: (event.target as HTMLSelectElement).value as UiSettings["embeddedBrowserPriority"] })}>
        <option value="builtin">${t("settings.browser.builtinFirst")}</option>
        <option value="webbridge">${t("settings.browser.webbridgeFirst")}</option>
        <option value="kernel">${t("settings.browser.kernelFirst")}</option>
      </select></label>
      <label class="field"><span>${t("settings.browser.zoom")}</span><select
        .value=${String(settings.embeddedBrowserZoom)}
        @change=${(event: Event) => update({ embeddedBrowserZoom: Number((event.target as HTMLSelectElement).value) })}>
        <option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option>
      </select></label>
      <oc-toggle-switch
        .checked=${settings.embeddedBrowserAskSavePath}
        .label=${t("settings.browser.askSavePath")}
        @change=${(event: CustomEvent) => update({ embeddedBrowserAskSavePath: !!event.detail.checked })}
      ></oc-toggle-switch>
      <label class="field"><span>${t("settings.browser.downloadPath")}</span><span class="oc-settings__inline">
        <input class="oc-settings__input" .value=${settings.embeddedBrowserDownloadPath} readonly placeholder=${t("settings.browser.downloadPathHint")} />
        <button class="btn" type="button" @click=${async () => {
          const selected = await window.cryoclaw?.selectDirectory?.();
          if (selected) update({ embeddedBrowserDownloadPath: selected });
        }}>${t("workspace.browse")}</button>
      </span></label>
      <label class="field"><span>${t("settings.browser.maxBytes")}</span><select
        .value=${String(settings.embeddedBrowserMaxBytes)}
        @change=${(event: Event) => update({ embeddedBrowserMaxBytes: Number((event.target as HTMLSelectElement).value) })}>
        <option value="268435456">256 MB</option><option value="1073741824">1.0 GB</option><option value="5368709120">5.0 GB</option>
      </select></label>
      <label class="field"><span>${t("settings.browser.userAgent")}</span><input class="oc-settings__input"
        .value=${settings.embeddedBrowserUserAgent} placeholder=${t("settings.browser.userAgentHint")}
        @change=${(event: Event) => update({ embeddedBrowserUserAgent: (event.target as HTMLInputElement).value })} /></label>
    </div>
  </section>`;
}
