import {LitElement,html,nothing} from "lit";
import {customElement} from "lit/decorators.js";
import type {GatewayBrowserClient} from "../gateway.ts";
import {t} from "../i18n.ts";

type Report={version:number;primary:string|null;retention:string|null;toolSchemaChars:number;catalogueDigest:string;duplicateFallbacks:string[];
  totals:{entryBytes:number;descriptionChars:number};skills:Array<{name:string;entryBytes:number;descriptionChars:number}>};
@customElement("oc-context-report")
export class OcContextReport extends LitElement{
  static properties={client:{attribute:false},connected:{type:Boolean},report:{state:true},loading:{state:true},error:{state:true}};
  client:GatewayBrowserClient|null=null;connected=false;
  private report:Report|null=null;private loading=false;private error=false;private generation=0;
  createRenderRoot(){return this;}
  disconnectedCallback(){this.generation++;super.disconnectedCallback();}
  protected updated(changed:Map<PropertyKey,unknown>){
    if(changed.has("client")){this.generation++;this.report=null;this.loading=false;this.error=false;
      if(this.querySelector("details")?.open&&this.connected)void this.load();}
  }
  private async load(){
    if(!this.client||!this.connected||this.loading)return;
    const client=this.client,generation=++this.generation;this.loading=true;this.error=false;
    try{
      const report=await client.request<Report>("cryoclaw.context.inspect",{});
      if(this.client===client&&this.connected&&this.isConnected&&generation===this.generation){
        if(report.version!==1||!Array.isArray(report.skills)||!report.totals)throw Error("Unsupported context report");this.report=report;
      }
    }catch{if(this.client===client&&generation===this.generation)this.error=true;}
    finally{if(generation===this.generation)this.loading=false;}
  }
  render(){const report=this.report;return html`<details class="oc-usage__context" @toggle=${(event:Event)=>{if((event.currentTarget as HTMLDetailsElement).open&&!this.report)void this.load();}}>
    <summary>${t("settings.usage.contextReport")}</summary><p>${t("settings.usage.contextReportHint")}</p>
    <button type="button" class="btn btn--sm" ?disabled=${!this.connected||this.loading} @click=${this.load}>${this.loading?t("chat.board.refreshing"):t("chat.board.refresh")}</button>
    ${this.error?html`<p role="status">${t("settings.usage.contextReportUnavailable")}</p>`:nothing}
    ${report?html`<dl class="oc-usage__context-summary"><dt>${t("settings.usage.contextPrimary")}</dt><dd>${report.primary??"—"}</dd>
      <dt>${t("settings.usage.contextRetention")}</dt><dd>${report.retention??t("settings.usage.contextNative")}</dd>
      <dt>${t("settings.usage.contextDescription")}</dt><dd>${report.totals.descriptionChars} chars</dd>
      <dt>${t("settings.usage.contextEntries")}</dt><dd>${report.totals.entryBytes.toLocaleString()} B</dd>
      <dt>${t("settings.usage.contextToolSchema")}</dt><dd>${report.toolSchemaChars} chars</dd></dl>
      ${report.duplicateFallbacks.length?html`<p class="oc-usage__context-warning">${t("settings.usage.contextDuplicate")} ${report.duplicateFallbacks.join(", ")}</p>`:nothing}
      <table><thead><tr><th>${t("settings.usage.contextSkill")}</th><th>${t("settings.usage.contextDescription")}</th><th>${t("settings.usage.contextEntries")}</th></tr></thead>
        <tbody>${report.skills.map(row=>html`<tr><td>${row.name}</td><td>${row.descriptionChars}</td><td>${row.entryBytes} B</td></tr>`)}</tbody></table>
      <p class="oc-usage__context-digest">${t("settings.usage.contextFingerprint")}: <code>${report.catalogueDigest.slice(0,16)}</code></p>`:nothing}
    </details>`;}
}
