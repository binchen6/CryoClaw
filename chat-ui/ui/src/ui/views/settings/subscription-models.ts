import {html, nothing} from "lit";
import type {AppViewState} from "../../app-view-state.ts";
import {getLocale} from "../../i18n.ts";
import {getCachedGatewayModelEntries, type GatewayModelEntry} from "../../controllers/models.ts";
import {getCachedConfigSnapshot, getConfigSnapshot, patchConfig} from "../../controllers/config.ts";
import {configureSubscriptionModel, parseSubscriptionParams} from "../../controllers/subscription-model-settings.ts";

type Draft = {key:string; alias:string; streaming:boolean; params:string; primary:boolean; busy:boolean; error:string; notice:string; open:boolean};
const drafts = new WeakMap<AppViewState,Draft>();
export function renderSubscriptionModels(host: AppViewState, signedIn: boolean) {
  const text = (cn:string,en:string) => getLocale().startsWith("zh") ? cn : en;
  const catalog = getCachedGatewayModelEntries();
  const models = [ ...(catalog?.openai ?? []), ...(catalog?.["openai-codex"] ?? []) ];
  const config = getCachedConfigSnapshot()?.config as Record<string,any> | undefined;
  const defaults = config?.agents?.defaults;
  const settings = defaults?.models ?? {};
  const configuredCount = Object.keys(settings).filter(key=>/^(openai|openai-codex)\//.test(key)).length;
  let draft = drafts.get(host);
  if (!draft) {draft={key:"",alias:"",streaming:true,params:"{}",primary:false,busy:false,error:"",notice:"",open:configuredCount===0};drafts.set(host,draft);}
  const s = draft;
  const select = (model:GatewayModelEntry) => {
    s.key=`${model.provider}/${model.id}`;
    const saved=settings[s.key];
    s.alias=saved?.alias ?? "";s.streaming=saved?.streaming !== false;
    s.params=JSON.stringify(saved?.params ?? {},null,2);s.primary=defaults?.model?.primary === s.key;
    s.error="";s.notice="";host.requestUpdate();
  };
  const selected = models.find(m=>`${m.provider}/${m.id}`===s.key);
  const save = async () => {
    if (!host.client || !selected || s.busy || !signedIn) return;
    s.busy=true;s.error="";s.notice="";host.requestUpdate();
    try {
      const params=parseSubscriptionParams(s.params);
      const input={alias:s.alias,streaming:s.streaming,params,primary:s.primary};
      const result=await patchConfig(host.client,d=>configureSubscriptionModel(d,selected,input));
      if (!result.ok) throw new Error(result.error ?? text("模型保存失败", "Could not save model"));
      await getConfigSnapshot(host.client,{force:true});await host.loadConfiguredModels();
      s.notice=text("模型设置已保存，聊天和任务选择器已同步。", "Saved. Chat and task model selectors are synced.");
      s.open=false;
    } catch(error) {s.error=error instanceof Error ? error.message : String(error);}
    finally {s.busy=false;host.requestUpdate();}
  };
  return html`<details class="oc-subscription-models" .open=${s.open} @toggle=${(e:Event)=>{s.open=(e.target as HTMLDetailsElement).open;}}>
    <summary><strong>${text("账户模型", "Account models")}</strong><span class="oc-settings__hint">${s.notice ? `${s.alias || selected?.name || selected?.id || ""} · ${text("已保存", "Saved")}` : configuredCount ? `${configuredCount} ${text("个已配置", "configured")}` : text("选择与配置", "Choose and configure")}</span></summary>
    <div class="oc-subscription-models__body"><p class="oc-settings__hint">${text("选择模型，设置显示名称、默认模型和请求参数。上下文与输入能力由内核同步。", "Choose a model and customize its name, default selection and request parameters. Capabilities come from the gateway.")}</p>
    ${models.length ? html`<label>${text("选择要配置的模型", "Choose a model")}<select class="oc-settings__select" .value=${s.key} ?disabled=${s.busy}
      @change=${(e:Event)=>{const model=models.find(m=>`${m.provider}/${m.id}`===(e.target as HTMLSelectElement).value);if(model)select(model);}}>
      <option value="">${text("请选择模型…", "Choose a model…")}</option>${models.map(m=>{const key=`${m.provider}/${m.id}`;return html`<option value=${key}>${settings[key]?.alias || m.name || m.id}${settings[key] ? text(" · 已配置", " · Configured") : ""}${defaults?.model?.primary===key ? text(" · 默认", " · Default") : ""}</option>`;})}</select></label>` : html`<p role="status" class="oc-settings__hint">${text("暂无模型目录，请同步账户后重试。", "No model catalog yet. Sync your account and try again.")}</p>`}
    ${selected ? html`<fieldset class="oc-subscription-models__editor" ?disabled=${s.busy || !signedIn}>
      <legend>${selected.name || selected.id}</legend><code>${s.key}</code>
      <div class="oc-subscription-models__facts">${selected.contextWindow ? html`<span class="cc-tag">${text("上下文", "Context")} ${selected.contextWindow.toLocaleString()}</span>` : nothing}
        ${selected.input?.map(input=>html`<span class="cc-tag">${input}</span>`)}${selected.reasoning ? html`<span class="cc-tag">${text("支持推理", "Reasoning")}</span>` : nothing}</div>
      <label>${text("显示名称", "Display name")}<input class="oc-settings__input" .value=${s.alias} placeholder=${selected.name || selected.id} @input=${(e:Event)=>{s.alias=(e.target as HTMLInputElement).value;}} /></label>
      <oc-toggle-switch .disabled=${s.busy || !signedIn || defaults?.model?.primary===s.key} .checked=${s.primary} .label=${text("设为默认模型", "Use as default model")} @change=${(e:CustomEvent)=>{s.primary=Boolean(e.detail?.checked);host.requestUpdate();}}></oc-toggle-switch>
      <oc-toggle-switch .disabled=${s.busy || !signedIn} .checked=${s.streaming} .label=${text("流式输出", "Streaming")} @change=${(e:CustomEvent)=>{s.streaming=Boolean(e.detail?.checked);host.requestUpdate();}}></oc-toggle-switch>
      <details><summary>${text("高级请求参数", "Advanced request parameters")}</summary><p class="oc-settings__hint">${text("填写模型支持的 JSON 参数。保留 {} 即使用内核默认值。", "Enter supported model parameters as JSON. Leave {} to use gateway defaults.")}</p>
        <textarea class="oc-settings__input" rows="5" spellcheck="false" aria-label=${text("模型 JSON 参数", "Model JSON parameters")} .value=${s.params} @input=${(e:Event)=>{s.params=(e.target as HTMLTextAreaElement).value;}}></textarea></details>
      <div class="btn-row"><button class="btn primary" @click=${()=>void save()}>${s.busy ? text("正在保存…", "Saving…") : text("保存模型设置", "Save model settings")}</button></div>
    </fieldset>` : nothing}
    ${!signedIn ? html`<p class="oc-settings__hint">${text("账户连接确认后即可保存模型设置。", "Model settings become available once your account connection is confirmed.")}</p>` : nothing}
    <oc-message-box .visible=${!!s.error} .message=${s.error} type="error"></oc-message-box><oc-message-box .visible=${!!s.notice} .message=${s.notice} type="success"></oc-message-box>
    </div></details>`;
}
