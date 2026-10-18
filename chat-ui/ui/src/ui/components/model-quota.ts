import {LitElement,html,svg,nothing} from "lit";
import {customElement,property,state} from "lit/decorators.js";
import type {GatewayBrowserClient} from "../gateway.ts";
import {loadModelQuota,quotaRemaining,quotaWindowLabel,summarizeModelQuota,type ModelQuota} from "../controllers/model-quota.ts";
import {balanceAriaLabel,balanceRingView,comfortTone,currencyKey,quotaAriaLabel,quotaComfort,quotaCurrencyProfile,quotaRingView} from "../chat/quota-ring.ts";
import {getLocale,t} from "../i18n.ts";
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
    // 余额与窗口是两条口径：有余额就按余额画（绝不把金额换算成限额百分比），否则按最紧窗口画。
    const value=this.value?.provider===this.provider?this.value:null;
    const summary=summarizeModelQuota(value,this.model);
    const balance=balanceRingView(summary.balance);
    const quota=quotaRingView(summary.remaining);
    const kind=balance?"balance":quota?"quota":"unknown";
    const tone=balance?.tone ?? quota?.tone;
    const ratio=balance?.ratio ?? quota?.ratio ?? 0;
    const aria=balance?balanceAriaLabel(balance,t):quotaAriaLabel(summary.remaining,t);
    const center=balance?balance.symbol:quota?`${quota.percent}`:this.busy?"…":"·";
    const profile=quotaCurrencyProfile(summary.balance?.currency);
    const legend=profile.ceiling!==null && profile.warnBelow!==null && profile.dangerBelow!==null
      ?{symbol:profile.symbol,ceiling:profile.ceiling,warnBelow:profile.warnBelow,dangerBelow:profile.dangerBelow}:null;
    const currencyName=profile.currency?`${profile.currency} · ${t(currencyKey(profile.currency))}`:t(currencyKey(profile.currency));
    const panelLabel=balance?t("quota.details.balance"):t("quota.details.limits");
    const zh=getLocale().startsWith("zh");
    return html`<button class="chat-quota__trigger" data-kind=${kind} data-tone=${tone ?? nothing} aria-label=${aria} title=${aria} aria-haspopup="dialog" aria-expanded=${this.open} aria-controls=${this.panelId} @click=${()=>this.toggle()}>
      <svg class="chat-quota__ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="chat-quota__track" cx="12" cy="12" r="10" pathLength="100"></circle>
        ${ratio>0?svg`<circle class="chat-quota__fill" cx="12" cy="12" r="10" pathLength="100" stroke-dasharray=${`${ratio*100} 100`}></circle>`:nothing}
        <text class="chat-quota__center" x="12" y="12" text-anchor="middle" dominant-baseline="central">${center}</text></svg>${balance?html`<span class="chat-quota__balance">${balance.display}</span>`:nothing}
    </button><div id=${this.panelId} class="chat-quota__details" popover="auto" role="dialog" aria-label=${panelLabel}
      @toggle=${(event:Event)=>{this.open=(event as ToggleEvent).newState==="open";}}>
      <div class="chat-quota__header"><strong>${panelLabel}</strong><button class="btn btn--sm" ?disabled=${this.busy || !this.connected} @click=${()=>void this.load(true)}>${this.busy?t("quota.details.loading"):t("quota.details.refresh")}</button></div>
      <p class="muted">${this.provider}${value?.plan?` · ${value.plan}`:""}</p>
      ${balance?html`<div class="chat-quota__balance-block" data-tone=${balance.tone}>
        <div class="chat-quota__amount"><span>${balance.display}</span><small>${currencyName}</small></div>
        ${balance.comfort!=="ok"?html`<p class="chat-quota__hint" data-tone=${balance.tone}>${t(balance.comfort==="danger"?"quota.details.lowBalance":"quota.details.lowBalanceWarn")}</p>`:nothing}
        <div class="chat-quota__legend" role="note"><span class="chat-quota__legend-title">${t("quota.legend.title")}${legend?` · ${t("quota.legend.fullRing")} ${legend.symbol}${legend.ceiling}`:""}</span>
          ${legend?html`<span class="chat-quota__legend-item" data-tone="accent"><i class="chat-quota__dot" aria-hidden="true"></i>${t("quota.level.ok")} ≥ ${legend.symbol}${legend.warnBelow}</span>
            <span class="chat-quota__legend-item" data-tone="warn"><i class="chat-quota__dot" aria-hidden="true"></i>${t("quota.level.warn")} ${legend.symbol}${legend.dangerBelow}–${legend.symbol}${legend.warnBelow}</span>
            <span class="chat-quota__legend-item" data-tone="danger"><i class="chat-quota__dot" aria-hidden="true"></i>${t("quota.level.danger")} &lt; ${legend.symbol}${legend.dangerBelow}</span>`
          :html`<span class="chat-quota__legend-item" data-tone="accent"><i class="chat-quota__dot" aria-hidden="true"></i>${t("quota.legend.other")}</span>`}
        </div></div>`:nothing}
      ${!balance?summary.windows.map(w=>{const pct=quotaRemaining([w]);const comfort=quotaComfort(pct);return html`<div class="chat-quota__window" data-tone=${comfort==="ok"?nothing:comfortTone(comfort)}><span>${quotaWindowLabel(w.label,zh)}</span><strong>${pct===null?t("quota.window.unknown"):`${Math.round(pct)}% ${t("quota.window.remaining")}`}</strong>
        ${w.remaining!==undefined && w.total!==undefined?html`<small>${w.unit==="USD"?"USD ":""}${w.remaining.toLocaleString()} / ${w.total.toLocaleString()}${w.unit==="requests"?` ${t("quota.window.requests")}`:""}</small>`:nothing}
        ${pct!==null?html`<progress max="100" value=${pct} aria-label=${quotaWindowLabel(w.label,zh)}></progress>`:nothing}${w.resetAt?html`<small>${t("quota.window.reset")} ${new Date(w.resetAt).toLocaleString()}</small>`:nothing}</div>`;}):nothing}
      ${!summary.windows.length && !balance && !value?.error?html`<p class="muted">${this.busy?t("quota.details.syncing"):value?.notice==="key-limit-unset"?t("quota.details.keyLimitUnset"):t("quota.details.noLimits")}</p>`:nothing}
      ${value?.error?html`<p role="status">${value.error}</p>`:nothing}
      ${value?.stale?html`<p class="muted" role="status">${t("quota.details.stale")}</p>`:nothing}
      ${value?html`<small class="muted chat-quota__synced">${t("quota.details.synced")} ${new Date(value.at).toLocaleTimeString()} · ${balance?t("quota.details.scopeBalance"):value.scope==="key"?t("quota.details.scopeKey"):t("quota.details.scopeAccount")}</small>`:nothing}
    </div>`;
  }
}
