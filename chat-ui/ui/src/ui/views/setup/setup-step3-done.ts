/**
 * Setup Step 3: Completion — launch CryoClaw.
 *
 * WebBridge toggle 行为：
 *   - 系统默认浏览器是 Chrome/Edge → 默认开启，可手动关闭
 *   - 系统默认浏览器是其他（Safari/Firefox/...）→ 关闭 + 禁用，hover info 图标解释原因
 *   - 后端 setup-ipc 也会做兜底（默认浏览器非 Chrome/Edge 时静默跳过 webbridge 后台 task）
 */
import {createCompletionOptions,loadCompletionOptions,finishSetup} from "./setup-completion-state.ts";
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";

const s={...createCompletionOptions(),error:null as string|null,statusMsg:null as string|null,initialized:false};
async function init(state:AppViewState,force=false){
  if(s.initialized && !force)return;s.initialized=true;
  await loadCompletionOptions(s,ipc.setupGetLaunchAtLogin,ipc.settingsGetDefaultBrowserName,()=>state.requestUpdate());
}

async function handleComplete(state:AppViewState){
  if(s.starting || !s.optionsLoaded)return;
  s.error=null;s.statusMsg=t("setup.done.starting");
  try{if(await finishSetup(s,ipc.completeSetup,()=>state.requestUpdate()))s.statusMsg=t("setup.done.opening");}
  catch(error:any){s.error=error?.message??t("setup.done.startFailed");s.statusMsg=null;}
  state.requestUpdate();
}

export function renderStep3(state: AppViewState) {
  if (!s.initialized) init(state);

  // 浏览器能力未知时不提交启用状态；禁用控件仍保持用户的已知选择。
  const wbDisabled = s.starting || s.completed || !s.optionsLoaded || !s.defaultBrowser;
  const wbChecked=s.optionsLoaded && !!s.defaultBrowser && s.enableWebbridge;
  const toggleWebbridge = () => {
    if (wbDisabled) return;
    s.browserTouched=true;
    s.enableWebbridge = !s.enableWebbridge;
    state.requestUpdate();
  };

  return html`
    <div class="oc-setup-step" aria-busy=${s.starting || s.initializing?"true":"false"}>
      <div class="oc-setup-step-body">
        <h2 class="oc-setup-title oc-setup-title--hero">${t("setup.done.title")}</h2>
        <p class="oc-setup-subtitle">${t("setup.done.subtitle")}</p>
        <div class="oc-setup-ready"><h3>${t("setup.done.connectionReady")}</h3><p>${t("setup.done.optionsHint")}</p></div>
        ${s.initializing?html`<p role="status">${t("setup.done.optionsLoading")}</p>`:nothing}
        ${s.optionsFailed?html`<p role="alert">${t("setup.done.optionsFailed")}</p><div class="btn-row"><button class="btn btn--sm" ?disabled=${s.starting || s.initializing} @click=${()=>void init(state,true)}>${t("setup.detect.retry")}</button></div>`:nothing}

        <div class="oc-setup-options">
          ${s.launchAtLoginSupported ? html`
            <oc-toggle-switch .label=${t("setup.done.launchAtLogin")} .checked=${s.launchAtLogin} .disabled=${s.starting || s.completed || !s.optionsLoaded}
              @change=${(e: CustomEvent) => { s.launchTouched=true;s.launchAtLogin = e.detail.checked; state.requestUpdate(); }}
            ></oc-toggle-switch>
          ` : nothing}

          <!-- WebBridge toggle：
               - 标题旁 info 图标永远显示「这选项干啥」的常规说明
               - 禁用态：tooltip 挂在右侧 track 上，hover 时显示在开关附近（不再居中漂在 row 中间） -->
          <div class="oc-toggle ${wbDisabled ? 'oc-toggle--disabled' : ''}"
            role="switch"
            aria-disabled=${wbDisabled?"true":"false"}
            aria-checked=${wbChecked ? "true" : "false"}
            aria-label=${t("setup.done.enableWebbridge")}
            tabindex=${wbDisabled ? "-1" : "0"}
            @click=${toggleWebbridge}
            @keydown=${(e: KeyboardEvent) => {
              if (wbDisabled || e.repeat || e.isComposing || e.keyCode===229) return;
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleWebbridge(); }
            }}>
            <span class="oc-toggle-label">
              ${t("setup.done.enableWebbridge")}
              <span class="oc-info-icon"
                data-tooltip=${t("setup.done.enableWebbridgeTooltip")}
                data-tooltip-wide="true"
                @click=${(e: Event) => e.stopPropagation()}>
                <svg class="cryo-icon" aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4"/>
                  <path d="M12 8h.01"/>
                </svg>
              </span>
            </span>
            <span class="oc-toggle-track ${wbChecked ? 'oc-toggle-track--on' : ''}"
              data-tooltip=${s.optionsLoaded && !s.defaultBrowser ? t("setup.done.enableWebbridgeDisabledTooltip") : ""}
              data-tooltip-wide="true">
              <span class="oc-toggle-thumb"></span>
            </span>
          </div>
        </div>

        ${s.error?html`<div class="cc-alert cc-alert--error oc-setup-inline-error" role="alert">${s.error}</div>`:nothing}
        ${s.statusMsg && !s.error?html`<p class="oc-setup-status" role="status">${s.statusMsg}</p>`:nothing}
      </div>

      <div class="btn-row">
        <button class="btn primary" ?disabled=${s.starting || !s.optionsLoaded}
          @click=${() => handleComplete(state)}>
          ${s.starting?t("setup.done.starting"):s.completed?t("setup.done.openWorkspace"):t("setup.done.start")}
        </button>
      </div>
    </div>
  `;
}
