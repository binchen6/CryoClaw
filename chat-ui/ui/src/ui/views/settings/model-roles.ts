import {html,nothing,type TemplateResult} from "lit";
import type {AppViewState} from "../../app-view-state.ts";
import {getLocale} from "../../i18n.ts";
import {getCachedConfigSnapshot,getConfigSnapshot,patchConfig} from "../../controllers/config.ts";
import {getCachedGatewayModelEntries} from "../../controllers/models.ts";
import {configureModelRoles,type ModelRole} from "../../controllers/model-roles.ts";

type Draft={hash:string;utilityModel:string;decisionModel:string;dirty:boolean;busy:boolean;error:string;saved:boolean};
const drafts=new WeakMap<AppViewState,Draft>();
const expanded=new WeakMap<AppViewState,boolean>();
export function renderModelRoles(host:AppViewState, fallbackControls?:TemplateResult) {
  const snapshot=getCachedConfigSnapshot();if(!snapshot)return nothing;
  const text=(cn:string,en:string)=>getLocale().startsWith("zh")?cn:en;
  const defaults=(snapshot.config as any).agents?.defaults??{};
  let draft=drafts.get(host);
  if(!draft || (!draft.dirty && !draft.busy && draft.hash!==snapshot.hash)) {
    draft={hash:snapshot.hash,utilityModel:defaults.utilityModel??"__inherit__",decisionModel:defaults.decisionModel??"__inherit__",dirty:false,busy:false,error:"",saved:false};
    drafts.set(host,draft);
  }
  const s=draft;
  const models=Object.values(getCachedGatewayModelEntries()??{}).flat();
  const save=async()=>{
    if(!host.client || !host.connected || s.busy)return;
    const client=host.client;s.busy=true;s.error="";s.saved=false;host.requestUpdate();
    try {
      const result=await patchConfig(client,config=>configureModelRoles(config,{
        utilityModel:s.utilityModel==="__inherit__"?undefined:s.utilityModel,
        decisionModel:s.decisionModel==="__inherit__"?undefined:s.decisionModel,
      }));
      if(!result.ok)throw new Error(result.error);
      const refreshed=await getConfigSnapshot(client,{force:true});
      if(host.client===client){s.hash=refreshed?.hash??s.hash;s.dirty=false;s.saved=true;}
    } catch(error){s.error=error instanceof Error?error.message:String(error);}
    finally{s.busy=false;host.requestUpdate();}
  };
  return html`<details class="oc-model-roles" .open=${expanded.get(host)??false} @toggle=${(event:Event)=>expanded.set(host,(event.currentTarget as HTMLDetailsElement).open)}><summary><strong>${text("模型分工与回退", "Model roles and fallback")}</strong><span class="oc-settings__hint">${text("辅助 · 决策 · 备用", "Utility · Decision · Fallback")}</span></summary>
    <div class="oc-model-roles__body"><p class="oc-settings__hint">${text("主模型负责对话；辅助模型处理内核辅助工作；决策模型用于内核决策。备用链在主模型不可用时按顺序尝试。", "The primary model handles chat. Utility and decision models handle their native gateway roles. Ordered fallbacks are tried when the primary model is unavailable.")}</p>
    ${(["utilityModel","decisionModel"] as ModelRole[]).map(role=>html`<label class="setting-row"><span class="setting-row__text">${role==="utilityModel"?text("辅助模型", "Utility model"):text("决策模型", "Decision model")}</span>
      <select class="oc-settings__select" .value=${s[role]} ?disabled=${s.busy || !host.connected}
        @change=${(event:Event)=>{s[role]=(event.target as HTMLSelectElement).value;s.dirty=true;s.saved=false;host.requestUpdate();}}>
        <option value="__inherit__">${text("使用内核默认规则", "Use gateway defaults")}</option><option value="">${text("明确停用此角色", "Disable this role")}</option>
        ${s[role] && s[role]!=="__inherit__" && !models.some(m=>`${m.provider}/${m.id}`===s[role])?html`<option value=${s[role]}>${s[role]}</option>`:nothing}
        ${models.map(model=>html`<option value=${`${model.provider}/${model.id}`} ?disabled=${model.available===false}>${model.name??model.id} · ${model.provider}</option>`)}
      </select></label>`)}
    ${s.error?html`<p role="alert" class="oc-text-danger">${s.error}</p>`:nothing}${s.saved?html`<p role="status">${text("模型分工已保存", "Model roles saved")}</p>`:nothing}
    <div class="btn-row"><button class="btn primary" ?disabled=${!s.dirty || s.busy || !host.connected} @click=${()=>void save()}>${s.busy?text("保存中…", "Saving…"):text("保存模型分工", "Save model roles")}</button></div>
    ${fallbackControls??nothing}</div></details>`;
}
