import {LitElement,html,svg,nothing} from "lit";
import {customElement,property,state} from "lit/decorators.js";
import type {GatewayBrowserClient} from "../gateway.ts";
import {loadModelQuota,quotaRemaining,quotaWindowLabel,quotaWindowsForModel,type ModelQuota} from "../controllers/model-quota.ts";
import {getLocale} from "../i18n.ts";
let nextId=0;

@customElement("oc-model-quota")
export class ModelQuotaMeter extends LitElement {
  createRenderRoot(){return this;}
  @property({attribute:false}) client:GatewayBrowserClient | null=null;
  @property() provider="";
  @property() model="";
  @property({type:Boolean}) connected=false;
  @state() private value:ModelQuota | null=null;
  @state() private busy=false;
  @state() private open=false;
  private epoch=0;
  private timer:ReturnType<typeof setInterval> | null=null;
  private readonly panelId=`model-quota-${++nextId}`;
  private text(cn:string,en:string){return getLocale().startsWith("zh")?cn:en;}
  connectedCallback(){super.connectedCallback();this.timer=setInterval(()=>{if(!document.hidden)void this.load();},60_000);}
  disconnectedCallback(){super.disconnectedCallback();++this.epoch;if(this.timer)clearInterval(this.timer);this.timer=null;}
  protected updated(changed:Map<PropertyKey,unknown>){
    if(changed.has("client") || changed.has("provider") || changed.has("model") || !this.connected)this.value=null;
    if(changed.has("provider") || changed.has("model") || changed.has("client") || changed.has("connected"))void this.load(changed.has("model"));
  }
  private async load(force=false){
    const epoch=++this.epoch,client=this.client,provider=this.provider;
    if(!client || !provider || !this.connected){this.busy=false;return;}
    this.busy=true;
    try {const value=await loadModelQuota(client,provider,force);if(epoch===this.epoch && this.isConnected)this.value=value;}
    catch(error){if(epoch===this.epoch && this.isConnected)this.value={provider,at:Date.now(),windows:[],error:error instanceof Error?error.message:String(error)};}
    finally {if(epoch===this.epoch)this.busy=false;}
  }
  private toggle(){
    const panel=this.querySelector<HTMLElement>(`#${this.panelId}`);
    if(!panel)return;
    if(this.open){panel.hidePopover();return;}
    const rect=this.querySelector("button")!.getBoundingClientRect();
    panel.style.left=`${Math.max(12,Math.min(window.innerWidth-332,rect.right-320))}px`;
    panel.style.bottom=`${Math.max(12,window.innerHeight-rect.top+8)}px`;
    panel.showPopover();
  }
  render(){
    const value=this.value?.provider===this.provider?this.value:null;
    const windows=value?quotaWindowsForModel(value.windows,this.model):[];
    const remaining=value?quotaRemaining(windows):null;
    const amount=value?.balance?.available;
    const balance=amount!==undefined && amount!==null && String(amount).trim()!==""?Number(amount):NaN;
    const hasBalance=Number.isFinite(balance);
    const balanceText=hasBalance?`${value?.balance?.currency==="CNY"?"¥":value?.balance?.currency==="USD"?"$":value?.balance?.currency??""}${balance.toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2})}`:"";
    const unknown=remaining===null && !hasBalance;
    const label=this.text("当前模型账户额度", "Current model account limits");
    const triggerLabel=unknown?this.text("额度未知，点击查看详情", "Quota unknown; view details"):label;
    return html`<button class="chat-quota__trigger" data-state=${unknown?"unknown":"known"} data-kind=${hasBalance?"balance":"quota"} aria-label=${hasBalance?`${label} · ${balanceText}`:triggerLabel} title=${hasBalance?balanceText:triggerLabel} aria-haspopup="dialog" aria-expanded=${this.open} aria-controls=${this.panelId} @click=${()=>this.toggle()}>
      <svg viewBox="0 0 32 32" aria-hidden="true"><circle class="chat-quota__track" cx="16" cy="16" r="12" pathLength="100"></circle>
        ${remaining!==null?svg`<circle class="chat-quota__fill" cx="16" cy="16" r="12" pathLength="100" stroke-dasharray=${`${remaining} 100`}></circle>`:nothing}
        <text x="16" y="20" text-anchor="middle">${remaining!==null?Math.round(remaining):hasBalance?(value!.balance!.currency==="CNY"?"¥":value!.balance!.currency==="USD"?"$":"¤"):this.busy?"…":"·"}</text></svg>${hasBalance?html`<span class="chat-quota__balance">${balanceText}</span>`:nothing}
    </button><div id=${this.panelId} class="chat-quota__details" popover="auto" role="dialog" aria-label=${label}
      @toggle=${(event:Event)=>{this.open=(event as ToggleEvent).newState==="open";}}>
      <div class="chat-quota__header"><strong>${this.text("账户额度", "Account limits")}</strong><button class="btn btn--sm" ?disabled=${this.busy || !this.connected} @click=${()=>void this.load(true)}>${this.busy?this.text("查询中…", "Loading…"):this.text("刷新", "Refresh")}</button></div>
      <p class="muted">${this.provider}${value?.plan?` · ${value.plan}`:""}</p>
      ${windows.map(w=>{const pct=quotaRemaining([w]);return html`<div class="chat-quota__window"><span>${quotaWindowLabel(w.label,getLocale().startsWith("zh"))}</span><strong>${pct===null?this.text("未知", "Unknown"):`${Math.round(pct)}% ${this.text("剩余", "remaining")}`}</strong>
        ${w.remaining!==undefined && w.total!==undefined?html`<small>${w.unit==="USD"?"USD ":""}${w.remaining.toLocaleString()} / ${w.total.toLocaleString()}${w.unit==="requests"?this.text(" 次", " requests"):""}</small>`:nothing}
        ${pct!==null?html`<progress max="100" value=${pct} aria-label=${w.label}></progress>`:nothing}${w.resetAt?html`<small>${this.text("重置", "Resets")} ${new Date(w.resetAt).toLocaleString()}</small>`:nothing}</div>`;})}
      ${value?.balance?html`<p>${this.text("可用余额", "Available balance")} <strong>${value.balance.currency??""} ${value.balance.available??this.text("未知", "Unknown")}</strong></p>`:nothing}
      ${value?.error?html`<p role="status">${value.error}</p>`:nothing}
      ${value?.stale?html`<p class="muted" role="status">${this.text("暂时无法更新，当前显示上次成功查询的数据。", "Refresh failed. Showing the last successful result.")}</p>`:nothing}
      ${!windows.length && !value?.balance?html`<p class="muted">${this.busy?this.text("正在同步此提供商的额度…", "Syncing provider limits…"):value?.notice==="key-limit-unset"?this.text("此密钥未设置金额限额。账户余额请前往 OpenRouter 控制台查看。", "This key has no spending cap. View account credits in the OpenRouter dashboard."):this.text("此提供商暂未返回当前模型可查询的额度，无法计算剩余比例。", "This provider has not returned limits for this model; remaining capacity is unknown.")}</p>`:nothing}
      ${value?html`<small class="muted">${this.text("同步于", "Synced")} ${new Date(value.at).toLocaleTimeString()} · ${value.scope==="key"?this.text("当前 API 密钥额度", "Current API key limits"):this.text("提供商返回的账户或模型额度", "Provider account or model limits")}</small>`:nothing}
    </div>`;
  }
}
