import {LitElement,html,nothing,type PropertyValues} from 'lit';
import {customElement} from 'lit/decorators.js';
import {styleMap} from 'lit/directives/style-map.js';
import {keyed} from 'lit/directives/keyed.js';
import type {GatewayBrowserClient} from '../gateway.ts';
import {getLocale,t} from '../i18n.ts';
import {icons} from '../icons.ts';
import {dashboardFrameUrl} from '../dashboard-model.ts';

type Template={id:string;title:string;titleEn:string;description:string;descriptionEn:string;category:string;layout:{w:number;h:number}};
type PreviewSize='compact'|'wide';
const previewHeights:Record<string,number>={'quick-notes':360,'todo-habits':620,pomodoro:540,'system-check':360,'disk-space':540,'fx-rates':460,'market-watch':460,'release-gallery':540,'audio-lab':620,'pattern-lab':520,'style-lab':460};

@customElement('oc-dashboard-library')
export class OcDashboardLibrary extends LitElement{
 static properties={client:{attribute:false},gatewayUrl:{attribute:false},onClose:{attribute:false},onAdd:{attribute:false},items:{state:true},selected:{state:true},category:{state:true},previewHtml:{state:true},previewUrl:{state:true},loading:{state:true},busy:{state:true},error:{state:true},previewLoading:{state:true},previewSize:{state:true},previewDimensions:{state:true}};
 client:GatewayBrowserClient|null=null;
 gatewayUrl='';
 onClose?:()=>void;
 onAdd?:(id:string)=>Promise<boolean>;
 private items:Template[]=[];
 private selected='';
 private category='productivity';
 private previewHtml='';
 private previewUrl='';
 private loading=true;
 private previewLoading=false;
 private busy=false;
 private error='';
 private errorSource:'catalog'|'preview'|'add'='catalog';
 private previewSize:PreviewSize='wide';
 private previewDimensions='';
 private generation=0;
 private previewGeneration=0;
 private previousFocus:HTMLElement|null=null;
 private sizeObserver:ResizeObserver|null=null;
 private observedFrame:HTMLElement|null=null;

 createRenderRoot(){return this;}
 connectedCallback(){super.connectedCallback();this.previousFocus=document.activeElement as HTMLElement;}
 disconnectedCallback(){
  this.generation++;this.previewGeneration++;
  this.sizeObserver?.disconnect();this.sizeObserver=null;this.observedFrame=null;
  if(this.previousFocus?.isConnected)this.previousFocus.focus();
  super.disconnectedCallback();
 }
 protected updated(changed:PropertyValues){
  const dialog=this.querySelector('dialog');
  if(dialog&&!dialog.open)dialog.showModal();
  if(changed.has('client')&&this.client)void this.load();
  else if(changed.has('gatewayUrl')&&this.selected&&this.client)void this.preview(this.selected);
  const frame=this.querySelector<HTMLElement>('.dashboard-library__frame');
  if(frame&&frame!==this.observedFrame){
   this.sizeObserver?.disconnect();this.observedFrame=frame;
   this.sizeObserver=new ResizeObserver(entries=>{
    const rect=entries[0]?.contentRect;
    if(rect)this.previewDimensions=`${Math.round(rect.width)} × ${Math.round(rect.height)}`;
   });
   this.sizeObserver.observe(frame);
  }
 }
 private label(item:Template,key:'title'|'description'){return getLocale()==='zh'?item[key]:item[`${key}En`];}
 private async load(){
  const generation=++this.generation,client=this.client;
  this.previewGeneration++;
  if(!client)return;
  this.loading=true;this.error='';
  try{
   const result=await client.request<{cards:Template[]}>('cryoclaw.dashboards.templates',{});
   if(generation!==this.generation||client!==this.client)return;
   this.items=result.cards;
   const selected=this.items.find(item=>item.id===this.selected)??this.items[0];
   this.category=selected?.category??'productivity';
   if(selected)void this.preview(selected.id);
  }catch{
   if(generation===this.generation&&client===this.client){this.error=t('dashboard.templatesFailed');this.errorSource='catalog';}
  }finally{if(generation===this.generation)this.loading=false;}
 }
 private async preview(id:string){
  const generation=++this.previewGeneration,client=this.client;
  if(!client)return;
  this.selected=id;this.previewHtml='';this.previewUrl='';this.previewLoading=true;this.error='';
  try{
   const result=await client.request<{html:string;previewPath?:string}>('cryoclaw.dashboards.templates',{templateId:id});
   if(generation!==this.previewGeneration||client!==this.client)return;
   const previewUrl=this.gatewayUrl?dashboardFrameUrl(this.gatewayUrl,result.previewPath??null):null;
   if(this.gatewayUrl&&(!previewUrl||!result.previewPath?.startsWith(`/__cryoclaw__/dashboards/preview/${id}?`)))throw Error('Invalid template preview URL');
   this.previewUrl=previewUrl??'';this.previewHtml=result.html;
  }catch{
   if(generation===this.previewGeneration&&client===this.client){this.error=t('dashboard.templatesFailed');this.errorSource='preview';}
  }finally{if(generation===this.previewGeneration)this.previewLoading=false;}
 }
 private chooseCategory(category:string){
  this.category=category;
  const first=this.items.find(item=>item.category===category);
  if(first&&first.id!==this.selected)void this.preview(first.id);
 }
 private async add(){
  if(this.busy||!this.selected)return;
  this.busy=true;this.error='';
  try{
   if(await this.onAdd?.(this.selected))this.onClose?.();
   else{this.error=t('dashboard.saveFailed');this.errorSource='add';}
  }catch{this.error=t('dashboard.saveFailed');this.errorSource='add';}
  finally{this.busy=false;}
 }
 private retry(){
  if(this.errorSource==='preview')void this.preview(this.selected);
  else if(this.errorSource==='add')void this.add();
  else void this.load();
 }
 render(){
  const selected=this.items.find(item=>item.id===this.selected);
  const hasPreview=Boolean(this.previewUrl||!this.gatewayUrl&&this.previewHtml);
  const sampleData=selected?.category==='data'||selected?.id==='system-check'||selected?.id==='disk-space';
  const frameHeight=selected?.id==='system-check'&&this.previewSize==='compact'?600:previewHeights[selected?.id??'']??Math.max(280,Math.min(620,(selected?.layout.h??420)-36));
  return html`<dialog class="dashboard-library" aria-labelledby="dashboard-library-title" @cancel=${(event:Event)=>{event.preventDefault();if(!this.busy)this.onClose?.();}}>
   <header><div><h2 id="dashboard-library-title">${t('dashboard.addModule')}</h2><p>${t('dashboard.libraryHint')}</p></div><button class="dashboard-library__close" aria-label=${t('settings.cancel')} ?disabled=${this.busy} @click=${this.onClose}>${icons.x}</button></header>
   <div class="dashboard-library__body">
    <aside>
     <div class="dashboard-library__categories" role="group" aria-label=${t('dashboard.templateCategories')}>${['productivity','data','creative'].map(category=>html`<button aria-pressed=${String(this.category===category)} ?disabled=${this.loading} @click=${()=>this.chooseCategory(category)}>${t(`dashboard.category.${category}`)}</button>`)}</div>
     <div class="dashboard-library__list" aria-busy=${this.loading}>${this.loading?html`<p role="status">${t('dashboard.loading')}</p>`:this.items.filter(item=>item.category===this.category).map(item=>html`<button aria-pressed=${String(this.selected===item.id)} @click=${()=>{if(item.id!==this.selected)void this.preview(item.id);}}><strong>${this.label(item,'title')}</strong><span>${this.label(item,'description')}</span></button>`)}</div>
    </aside>
    <section class="dashboard-library__preview" aria-label=${t('dashboard.templatePreview')}>
     <div class="dashboard-library__preview-heading"><div><h3>${selected?this.label(selected,'title'):t('dashboard.templatePreview')}</h3><p>${selected?this.label(selected,'description'):t('dashboard.previewSizeHint')}</p></div><span class="dashboard-library__badge">${sampleData?t('dashboard.previewSample'):t('dashboard.previewSandbox')}</span></div>
     <div class="dashboard-library__preview-toolbar"><div class="dashboard-library__sizes" role="group" aria-label=${t('dashboard.previewSize')}>${(['compact','wide'] as const).map(size=>html`<button aria-pressed=${String(this.previewSize===size)} @click=${()=>{this.previewSize=size;}}>${t(`dashboard.previewSize.${size}`)}</button>`)}</div><output class="dashboard-library__dimensions" aria-label=${t('dashboard.previewDimensions')}>${this.previewDimensions}</output><button class="btn btn--sm btn--text dashboard-library__reset" aria-label=${t('dashboard.previewReset')} title=${t('dashboard.previewReset')} ?disabled=${!hasPreview||this.previewLoading} @click=${()=>void this.preview(this.selected)}>${icons.rotateCcw}<span>${t('dashboard.previewReset')}</span></button></div>
     <div class="dashboard-library__stage" data-size=${this.previewSize} style=${styleMap({'--dashboard-preview-height':`${frameHeight}px`})}>
      <div class="dashboard-library__frame" aria-busy=${this.previewLoading}>${hasPreview?keyed(this.previewGeneration,this.previewUrl?html`<iframe title=${selected?`${this.label(selected,'title')} · ${t('dashboard.templatePreview')}`:t('dashboard.templatePreview')} src=${this.previewUrl} credentialless sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe>`:html`<iframe title=${selected?`${this.label(selected,'title')} · ${t('dashboard.templatePreview')}`:t('dashboard.templatePreview')} .srcdoc=${this.previewHtml} sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe>`):html`<span role="status">${this.previewLoading?t('dashboard.loading'):t('dashboard.templatePreview')}</span>`}</div>
     </div>
     <div class="dashboard-library__preview-note">${icons.info}<p>${sampleData?t('dashboard.previewSampleHint'):t('dashboard.previewHint')}</p></div>
    </section>
   </div>
   ${this.error?html`<p class="dashboard-library__error" role="alert">${this.error}<button ?disabled=${this.busy} @click=${()=>this.retry()}>${t('dashboard.retry')}</button></p>`:nothing}
   <footer><span>${t('dashboard.localTemplateHint')}</span><button class="btn" ?disabled=${this.busy} @click=${this.onClose}>${t('settings.cancel')}</button><button class="btn primary" ?disabled=${!selected||!hasPreview||this.busy||this.loading} @click=${()=>void this.add()}>${this.busy?t('dashboard.saving'):t('dashboard.addToBoard')}</button></footer>
  </dialog>`;
 }
}
