import {LitElement,html,nothing,type PropertyValues} from 'lit';
import {customElement} from 'lit/decorators.js';
import type {ChatProps} from '../views/chat.ts';
import {icons} from '../icons.ts';
import {t} from '../i18n.ts';
import {KNOWN_THINKING_LEVELS} from '../chat/thinking-levels.ts';
import {bucketModelsByOrg,loadModelOrg} from '../views/settings/model-org.lib.ts';
import {placePopover} from '../utils/popover-placement.ts';
const levelLabel=(level:string)=>(KNOWN_THINKING_LEVELS as readonly string[]).includes(level)?t(`chat.thinkLevel.${level}`):level;
let nextMenuId=0;
@customElement('oc-model-picker')
export class OcModelPicker extends LitElement{
 static properties={props:{attribute:false},value:{type:String},pane:{state:true},open:{state:true},busy:{state:true},query:{state:true},pageHeight:{state:true}};
 props:ChatProps|null=null;value:string|null=null;private pane='models';private open=false;private busy=false;private query='';private pageHeight=200;private observer:ResizeObserver|null=null;
 /** 声明式 invoker 需要一个稳定的面板 id：点击、Esc、外部点击都走浏览器同一条开关路径。 */
 private readonly menuId=`model-picker-menu-${++nextMenuId}`;
 createRenderRoot(){return this;}
 private get menu(){return this.querySelector<HTMLElement>('.model-picker__menu');}
 private get trigger(){return this.querySelector<HTMLButtonElement>('.model-picker__trigger');}
 /**
  以触发器为锚点自适应定位：优先向上（输入框在底部），放不下换边，再在视口内夹取；
  `avoid` 带上触发器自身，任何候选边都不得盖住触发按钮。返回的 side 同时驱动入场/退场方向。
  */
 private position=()=>{
  const trigger=this.trigger,menu=this.menu;
  if(!trigger||!menu||!this.open)return;
  const anchor=trigger.getBoundingClientRect(),viewport={width:window.innerWidth,height:window.innerHeight};
  const width=Math.min(348,viewport.width-24);
  menu.style.width=`${width}px`;
  const header=this.querySelector<HTMLElement>('.model-picker__header'),page=this.querySelector<HTMLElement>(`.model-picker__page[data-page=${this.pane}]`);
  const headerHeight=header?.getBoundingClientRect().height??0,gap=8,padding=12;
  const natural=page?page.scrollHeight:this.pageHeight;
  // 页面内容高度按「最近一侧可用空间」收敛，翻到另一侧时不至于顶出窗口。
  const room=Math.max(anchor.top-gap-padding,viewport.height-anchor.bottom-gap-padding);
  const height=Math.min(natural,Math.max(120,room-headerHeight-16));
  if(Math.abs(height-this.pageHeight)>1)this.pageHeight=height;
  const panel={width,height:Math.min(height+headerHeight+16,viewport.height-24)};
  const placement=placePopover({anchor,panel,viewport,gap,padding,candidates:[{side:'top',align:'start'},{side:'bottom',align:'start'}],avoid:[anchor]});
  menu.style.left=`${placement.left}px`;
  menu.style.top=`${placement.top}px`;
  menu.style.bottom='auto';
  menu.dataset.side=placement.side;
  menu.dataset.align=placement.align;
 };
 private closeOther=()=>{if(!this.open)return;this.menu?.hidePopover();this.open=false;this.query='';};
 connectedCallback(){super.connectedCallback();document.addEventListener('cryoclaw:compose-other-menu',this.closeOther);window.addEventListener('resize',this.position);window.addEventListener('scroll',this.position,true);}
 disconnectedCallback(){try{this.menu?.hidePopover();}catch{}document.removeEventListener('cryoclaw:compose-other-menu',this.closeOther);this.observer?.disconnect();window.removeEventListener('resize',this.position);window.removeEventListener('scroll',this.position,true);super.disconnectedCallback();}
 protected updated(changed:PropertyValues){
  if(changed.has('props')){const before=changed.get('props') as ChatProps|null;if(before&&before.sessionKey!==this.props?.sessionKey){this.menu?.hidePopover();this.pane='models';this.query='';}}
  if(!this.observer){this.observer=new ResizeObserver(this.position);for(const e of this.querySelectorAll('.model-picker__page'))this.observer.observe(e);}
  this.position();
 }
 /** 打开前通知输入框收起加号菜单，两个浮层不并排。 */
 private onBeforeToggle=(event:ToggleEvent)=>{
  if(event.newState!=='open')return;
  this.dispatchEvent(new CustomEvent('cryoclaw:compose-menu',{bubbles:true,composed:true}));
  this.pane='models';
  this.query='';
 };
 /** 原生 toggle 是唯一开关来源：再次点击触发器由浏览器关闭，不再用 click 读 :popover-open 反推。 */
 private onToggle=(event:ToggleEvent)=>{
  this.open=event.newState==='open';
  if(!this.open){this.query='';return;}
  this.position();
  requestAnimationFrame(this.position);
  void this.updateComplete.then(()=>this.menu?.querySelector<HTMLElement>('[data-page=models] [aria-checked=true]')?.focus());
 };
 private close(){this.menu?.hidePopover();this.open=false;this.query='';this.trigger?.focus();}
 private key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.close();return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...this.querySelectorAll<HTMLButtonElement>(`.model-picker__header button,.model-picker__page[data-page=${this.pane}] button`)].filter(b=>!b.disabled),current=buttons.indexOf(document.activeElement as HTMLButtonElement),index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[index]?.focus();};
 render(){const p=this.props;if(!p)return nothing;const models=p.configuredModels??[],active=models.find(m=>m.key===this.value),level=p.thinkingToggleLevel??'off',fast=p.fastMode!==false&&p.fastMode!==undefined;
  const options=models.some(m=>m.key===this.value)||!this.value?models:[...models,{key:this.value,name:this.value,provider:'',isDefault:false}],query=this.query.trim().toLocaleLowerCase();
  const filtered=query?options.filter(m=>`${m.name} ${m.provider} ${m.key}`.toLocaleLowerCase().includes(query)):options;
  return html`<button class="model-picker__trigger" type="button" popovertarget=${this.menuId} popovertargetaction="toggle" aria-haspopup="menu" aria-label=${`${t('chat.modelPicker.title')}: ${active?.name??this.value??t('chat.modelPicker.title')}`} aria-expanded=${String(this.open)} ?disabled=${!p.connected}><span>${active?.name??this.value??t('chat.modelPicker.title')}</span>${level!=='off'?html`<span class="model-picker__level">${levelLabel(level)}</span>`:nothing}${icons.chevronDown}</button>
    <div class="model-picker__menu" id=${this.menuId} popover="auto" role="menu" aria-label=${t('chat.modelPicker.title')} @keydown=${this.key} @beforetoggle=${this.onBeforeToggle} @toggle=${this.onToggle}>
     <header class="model-picker__header"><span>${t('chat.modelPicker.title')}</span><button class="model-picker__fast" type="button" role="switch" aria-checked=${String(fast)} aria-label=${t('chat.modelPicker.fast')} ?disabled=${!p.connected||this.busy} @click=${async()=>{if(this.busy)return;this.busy=true;try{await p.onFastModeChange?.(!fast);}finally{this.busy=false;}}}>${this.busy?t('chat.modelPicker.saving'):t('chat.modelPicker.fast')}<i><b></b></i></button></header>
     <div class="model-picker__pages" style=${`height:${this.pageHeight}px`}><div class="model-picker__track ${this.pane==='thinking'?'is-thinking':''}">
       <section class="model-picker__page" data-page="models" ?inert=${this.pane!=='models'}>
        ${options.length>5?html`<label class="model-picker__search">${icons.search}<input type="search" aria-label=${t('chat.modelPicker.search')} placeholder=${t('chat.modelPicker.searchPlaceholder')} .value=${this.query} @input=${(e:Event)=>{this.query=(e.target as HTMLInputElement).value;}}></label>`:nothing}
        <div class="model-picker__list">${filtered.length?bucketModelsByOrg(filtered,loadModelOrg()).map(bucket=>html`${bucket.group?html`<p class="model-picker__group">${bucket.group.name}</p>`:nothing}${bucket.models.map(m=>html`<button type="button" role="menuitemradio" aria-checked=${String(m.key===this.value)} @click=${()=>{p.onModelChange?.(m.key);this.close();}}><span>${m.name}</span>${m.key===this.value?icons.check:nothing}</button>`)}`):html`<p class="model-picker__empty">${t('chat.modelPicker.noMatches')}</p>`}</div>
        <button class="model-picker__thinking" type="button" ?disabled=${!p.thinkingToggleLevels?.length} @click=${()=>{this.pane='thinking';void this.updateComplete.then(()=>this.querySelector<HTMLElement>('[data-page=thinking] [aria-checked=true]')?.focus());}}><span>${t('chat.thinkingPicker')}</span><span>${levelLabel(level)} ${icons.chevronRight}</span></button>
       </section>
       <section class="model-picker__page" data-page="thinking" ?inert=${this.pane!=='thinking'}><button class="model-picker__back" type="button" @click=${()=>{this.pane='models';void this.updateComplete.then(()=>this.querySelector<HTMLElement>('.model-picker__thinking')?.focus());}}>${icons.chevronRight}${t('chat.thinkingPicker')}</button>${(p.thinkingToggleLevels??[]).map(option=>html`<button type="button" role="menuitemradio" aria-checked=${String(option===level)} @click=${()=>{p.onThinkingLevelChange?.(option);this.close();}}><span>${levelLabel(option)}</span>${option===level?icons.check:nothing}</button>`)}</section>
     </div></div>
    </div>`;
 }
}
