import {LitElement,html,nothing,type PropertyValues} from 'lit';
import {customElement} from 'lit/decorators.js';
import {repeat} from 'lit/directives/repeat.js';
import {styleMap} from 'lit/directives/style-map.js';
import {guard} from 'lit/directives/guard.js';
import type {GatewayBrowserClient} from '../gateway.ts';
import {icons} from '../icons.ts';
import {t} from '../i18n.ts';
import {bound,dashboardFrameUrl,reorderDashboardCards,type Dashboard,type DashboardCard,type DashboardSnapshot,type SystemSample} from '../dashboard-model.ts';
import './oc-dashboard-tasks.ts';
import type {ChatProps} from '../views/chat.ts';
import {renderDashboardCompose} from '../views/dashboard-compose.ts';
import {resetComposeTransient} from '../views/chat-compose.ts';
import {dashboardTransform} from '../dashboard-motion.ts';
import {pauseDashboardUpdates} from '../dashboard-tasks.ts';

type Gesture={kind:'drag'|'resize';id:string;pointerId:number;x:number;y:number;dx:number;dy:number;w:number;h:number;target:string;before:DashboardCard[]};
@customElement('oc-dashboard')
export class OcDashboard extends LitElement{
  static properties={client:{attribute:false},connected:{type:Boolean},settings:{attribute:false},onAskModel:{attribute:false},onOpenTasks:{attribute:false},composeProps:{attribute:false},onOpenChat:{attribute:false},composerOpen:{state:true},composerLeaving:{state:true},morphing:{state:true},cardRefreshVersion:{state:true},taskCard:{state:true},boards:{state:true},selected:{state:true},loading:{state:true},error:{state:true},editing:{state:true},expanded:{state:true},compact:{state:true},focusMode:{state:true},dialog:{state:true},titleDraft:{state:true},gesture:{state:true},sample:{state:true},measuring:{state:true},sampleCount:{state:true},saving:{state:true},preparingArchive:{state:true},showArchived:{state:true},refreshNonce:{state:true},canvasScale:{state:true},canvasHeight:{state:true},expandedScale:{state:true}};
  client:GatewayBrowserClient|null=null;connected=false;settings={gatewayUrl:''};onAskModel?:(prompt:string)=>void;onOpenTasks?:()=>void;
  private boards:Dashboard[]=[];private selected='';private loading=false;private error='';private editing=false;private expanded='';private compact=false;private focusMode=false;
  private dialog:''|'create'|'rename'|'archive'|'delete'='';private titleDraft='';private gesture:Gesture|null=null;private sample:SystemSample|null=null;private measuring=false;private sampleCount=0;private saving=false;private showArchived=false;private refreshNonce=0;private preparingArchive=false;
  private taskCard='';
  private composerOpen=false;private composerLeaving=false;private composerEpoch=0;private composerAnimation:Animation|null=null;
  composeProps:ChatProps|null=null;onOpenChat?:()=>void;
  private moveFrame=0;private latestMove:PointerEvent|null=null;
  private cardRefresh=new Map<string,number>();private cardRefreshVersion=0;
  private morphing=false;private morphingCard='';private morphEpoch=0;private morphAnimations:Animation[]=[];
  private canvasScale=1;private canvasHeight=900;private expandedScale=1;private resizeObserver:ResizeObserver|null=null;
  private visibilityObserver:IntersectionObserver|null=null;private observedFrames=new Set<HTMLIFrameElement>();
  private postFrameVisibility=(frame:HTMLIFrameElement)=>frame.contentWindow?.postMessage({type:'cryoclaw:dashboard:visibility',active:!document.hidden&&frame.dataset.visible==='true'},'*');
  private pageVisibility=()=>{for(const frame of this.querySelectorAll<HTMLIFrameElement>('iframe'))this.postFrameVisibility(frame);};
  private fitCanvas=()=>{const scroll=this.querySelector<HTMLElement>('.dashboard-workspace__scroll'),canvas=this.querySelector<HTMLElement>('.dashboard-canvas');this.style.setProperty('--dashboard-compose-height',`${this.querySelector<HTMLElement>('.dashboard-compose')?.offsetHeight??0}px`);if(!scroll||!canvas)return;const css=getComputedStyle(scroll),width=scroll.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);this.canvasScale=Math.max(.1,Math.min(1,width/1600));this.canvasHeight=canvas.offsetHeight;this.expandedScale=Math.max(.1,Math.min((innerWidth-62)/1600,(innerHeight-117)/900));};
  private revision=-1;private epoch=0;private operation=0;private polling:ReturnType<typeof setInterval>|null=null;private pending=false;private retired=false;private lastFrameRefresh=0;private lastExternalOpen=0;private previousFocus:HTMLElement|null=null;private frameRates=new WeakMap<HTMLIFrameElement,{at:number;count:number}>();
  createRenderRoot(){return this;}
  connectedCallback(){super.connectedCallback();this.retired=false;try{this.selected=localStorage.getItem('cryoclaw.dashboard.selected')??'';}catch{}
    window.addEventListener('pointermove',this.move);window.addEventListener('pointerup',this.finish);window.addEventListener('pointercancel',this.cancel);window.addEventListener('keydown',this.key);window.addEventListener('message',this.frameMessage);document.addEventListener('focusin',this.trapFocus);
    this.polling=setInterval(()=>{if(!document.hidden&&!this.gesture&&!this.saving)void this.load();},2500);
  }
  disconnectedCallback(){this.composerEpoch++;this.composerAnimation?.cancel();this.morphEpoch++;for(const animation of this.morphAnimations)animation.cancel();this.morphAnimations=[];this.cancel();if(this.composeProps)resetComposeTransient(this.composeProps);this.retired=true;this.epoch++;if(this.polling)clearInterval(this.polling);this.polling=null;this.resizeObserver?.disconnect();this.resizeObserver=null;this.visibilityObserver?.disconnect();this.visibilityObserver=null;this.observedFrames=new Set();document.removeEventListener('visibilitychange',this.pageVisibility);window.removeEventListener('resize',this.fitCanvas);window.removeEventListener('pointermove',this.move);window.removeEventListener('pointerup',this.finish);window.removeEventListener('pointercancel',this.cancel);window.removeEventListener('keydown',this.key);window.removeEventListener('message',this.frameMessage);document.removeEventListener('focusin',this.trapFocus);super.disconnectedCallback();}
  protected updated(changed:PropertyValues){
    if(this.retired)return;
    if(!this.resizeObserver){this.resizeObserver=new ResizeObserver(this.fitCanvas);for(const element of this.querySelectorAll('.dashboard-workspace__scroll,.dashboard-canvas,.dashboard-compose'))this.resizeObserver.observe(element);window.addEventListener('resize',this.fitCanvas);this.fitCanvas();}
    for(const element of this.querySelectorAll('.dashboard-workspace__scroll,.dashboard-canvas,.dashboard-compose'))this.resizeObserver.observe(element);
    if(!this.visibilityObserver){this.visibilityObserver=new IntersectionObserver(entries=>{for(const entry of entries){const frame=entry.target as HTMLIFrameElement;frame.dataset.visible=String(entry.isIntersecting);this.postFrameVisibility(frame);}},{threshold:0.01});document.addEventListener('visibilitychange',this.pageVisibility);}
    for(const frame of this.observedFrames)if(!frame.isConnected){this.visibilityObserver.unobserve(frame);this.observedFrames.delete(frame);}
    for(const frame of this.querySelectorAll<HTMLIFrameElement>('iframe'))if(!this.observedFrames.has(frame)){this.observedFrames.add(frame);this.visibilityObserver.observe(frame);}
    if(changed.has('client')||changed.has('connected')){this.epoch++;this.pending=false;if(this.connected){this.revision=-1;void this.load(true);}else this.loading=false;}
    const dialog=this.querySelector<HTMLDialogElement>('dialog');if(this.dialog&&dialog&&!dialog.open){dialog.showModal();void Promise.resolve().then(()=>dialog.querySelector<HTMLInputElement>('input')?.focus());}else if(!this.dialog&&dialog?.open)dialog.close();
    if(changed.has('expanded')&&this.expanded)this.querySelector<HTMLButtonElement>('[data-expanded="true"] [data-card-close]')?.focus();
  }
  private get board(){return this.boards.find(b=>b.id===this.selected);}
  private async load(force=false){
    if(!this.client||!this.connected||this.pending||this.retired)return;const client=this.client,epoch=this.epoch,operation=this.operation;this.pending=true;if(!this.boards.length)this.loading=true;
    try{
      const snapshot=await client.request<DashboardSnapshot>('cryoclaw.dashboards.list',{...!force?{sinceRevision:this.revision}:{},includeArchived:true});
      if(this.retired||client!==this.client||epoch!==this.epoch||this.gesture||this.saving||operation!==this.operation)return;
      if(!snapshot.unchanged){this.boards=(snapshot.boards??[]).map(b=>({...b,cards:[...b.cards].sort((a,b)=>a.layout.order-b.layout.order)}));this.revision=snapshot.revision;}
      if(!this.boards.length&&snapshot.revision===0){const created=await client.request<{board:{id:string}}>('cryoclaw.dashboards.mutate',{action:'seed'});if(this.retired||client!==this.client||epoch!==this.epoch)return;this.selected=created.board.id;this.pending=false;await this.load(true);return;}
      if(!this.board||this.board.archived&&!this.showArchived)this.selected=this.boards.find(b=>!b.archived)?.id??this.boards[0]?.id??'';
      this.error='';if(this.board?.cards.some(c=>c.kind==='system')&&!this.sample&&!this.measuring)void this.measure();
    }catch{if(client===this.client&&epoch===this.epoch)this.error=t('dashboard.loadFailed');}
    finally{if(client===this.client&&epoch===this.epoch){this.pending=false;this.loading=false;}}
  }
  private async mutate(params:Record<string,unknown>){
    if(!this.client||!this.connected||this.saving)return null;const client=this.client,epoch=this.epoch,operation=++this.operation;this.saving=true;
    try{const result=await client.request<{board:{id:string}}>('cryoclaw.dashboards.mutate',{...params,requestId:crypto.randomUUID()});if(client!==this.client||epoch!==this.epoch||this.retired)return null;return result;}
    catch{if(client===this.client&&epoch===this.epoch)this.error=t('dashboard.saveFailed');return null;}
    finally{if(operation===this.operation&&client===this.client&&epoch===this.epoch){this.saving=false;void this.load(true);}}
  }
  private select(id:string){this.morphEpoch++;for(const animation of this.morphAnimations)animation.cancel();this.morphAnimations=[];this.morphing=false;this.cancel();this.expanded='';this.selected=id;try{localStorage.setItem('cryoclaw.dashboard.selected',id);}catch{}}
  private tabKey(event:KeyboardEvent,id:string){
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const boards=this.boards.filter(board=>this.showArchived||!board.archived),index=boards.findIndex(board=>board.id===id);if(index<0||!boards.length)return;
    event.preventDefault();const next=event.key==='Home'?boards[0]:event.key==='End'?boards[boards.length-1]:boards[(index+(event.key==='ArrowRight'?1:-1)+boards.length)%boards.length];
    this.select(next.id);void this.updateComplete.then(()=>this.querySelector<HTMLButtonElement>(`[data-board-id="${next.id}"]`)?.focus());
  }
  private openDialog(kind:'create'|'rename'|'archive'|'delete'){this.titleDraft=kind==='create'?'':this.board?.title??'';this.dialog=kind;}
  private async submit(event:Event){
    event.preventDefault();if(this.saving||this.preparingArchive)return;const kind=this.dialog,board=this.board,client=this.client;
    if((kind==='archive'||kind==='delete')&&board&&client){this.preparingArchive=true;try{await pauseDashboardUpdates(client,board.id,board.cards.flatMap(c=>(c.taskLinks??[]).map(l=>l.jobId)),()=>{if(this.retired||client!==this.client||this.selected!==board.id||this.dialog!==kind)throw Error('Retired archive request');});}catch{this.error=t('dashboard.archiveTasksFailed');return;}finally{this.preparingArchive=false;}}
    const result=await this.mutate(kind==='archive'||kind==='delete'?{action:kind,boardId:this.selected,...kind==='delete'?{confirmDelete:true}:{}}:{action:kind==='create'?'create':'rename',boardId:this.selected,title:this.titleDraft.trim()});
    if(result){if(kind==='create')this.selected=result.board.id;else if(kind==='delete'){const boardId=this.selected;try{await (window as unknown as {cryoclaw?:{closeDashboardBoard?:(id:string)=>Promise<unknown>}}).cryoclaw?.closeDashboardBoard?.(boardId);}catch{}this.selected='';}this.dialog='';}
  }
  private replaceCards(cards:DashboardCard[]){this.boards=this.boards.map(b=>b.id===this.selected?{...b,cards}:b);}
  private saveLayout(){const board=this.board;if(board)void this.mutate({action:'layout',boardId:board.id,layouts:board.cards.map(c=>({cardId:c.id,...c.layout}))});}
  private start(event:PointerEvent,card:DashboardCard,kind:'drag'|'resize'){
    if(event.button!==0||this.expanded||this.board?.archived)return;event.preventDefault();this.gesture={kind,id:card.id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,dx:0,dy:0,w:card.layout.w,h:card.layout.h,target:card.id,before:this.board?.cards??[]};(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  private move=(event:PointerEvent)=>{if(!this.gesture||event.pointerId!==this.gesture.pointerId)return;event.preventDefault();this.latestMove=event;if(!this.moveFrame)this.moveFrame=requestAnimationFrame(()=>{this.moveFrame=0;this.flushMove();});};
  private flushMove=()=>{const event=this.latestMove;this.latestMove=null;const g=this.gesture;if(!event||!g||event.pointerId!==g.pointerId)return;const dx=event.clientX-g.x,dy=event.clientY-g.y;
    if(g.kind==='resize'){const width=this.querySelector('.dashboard-canvas')?.getBoundingClientRect().width??1600;this.replaceCards((this.board?.cards??[]).map(c=>c.id===g.id?{...c,layout:{...c.layout,w:bound(g.w+dx/(width/12),2,12),h:bound(g.h+dy/this.canvasScale,180,1000)}}:c));}
    else{const candidates=[...this.querySelectorAll<HTMLElement>('.dashboard-card')].filter(el=>el.dataset.cardId!==g.id);let nearest=g.target,distance=Infinity;for(const el of candidates){const r=el.getBoundingClientRect(),d=Math.hypot(event.clientX-(r.left+r.width/2),event.clientY-(r.top+r.height/2));if(d<distance){distance=d;nearest=el.dataset.cardId!;}}this.gesture={...g,dx,dy,target:Math.hypot(dx,dy)>12?nearest:g.id};}
  };
  private finish=(event:PointerEvent)=>{if(!this.gesture||event.pointerId!==this.gesture.pointerId)return;this.latestMove=event;if(this.moveFrame)cancelAnimationFrame(this.moveFrame);this.moveFrame=0;this.flushMove();const g=this.gesture!;if(g.kind==='drag'&&g.id!==g.target)this.replaceCards(reorderDashboardCards(this.board?.cards??[],g.id,g.target));this.gesture=null;this.saveLayout();};
  private cancel=()=>{if(this.moveFrame)cancelAnimationFrame(this.moveFrame);this.moveFrame=0;this.latestMove=null;if(this.gesture){this.replaceCards(this.gesture.before);this.gesture=null;}};
  private key=(event:KeyboardEvent)=>{if(event.key!=='Escape'||this.taskCard||this.dialog)return;if(this.gesture){this.cancel();event.preventDefault();}else if(this.expanded){this.collapse();event.preventDefault();}else if(this.focusMode){this.focusMode=false;event.preventDefault();}};
  private cardKey(event:KeyboardEvent,card:DashboardCard,resize=false){
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const direction=['ArrowLeft','ArrowUp'].includes(event.key)?-1:1;
    if(resize)this.replaceCards((this.board?.cards??[]).map(c=>c.id===card.id?{...c,layout:{...c.layout,...['ArrowLeft','ArrowRight'].includes(event.key)?{w:bound(c.layout.w+direction,2,12)}:{h:bound(c.layout.h+direction*20,180,1000)}}}:c));
    else{const cards=this.board?.cards??[],index=cards.findIndex(c=>c.id===card.id),other=cards[index+direction];if(other)this.replaceCards(reorderDashboardCards(cards,card.id,other.id));}this.saveLayout();
  }
  private expand(id:string){if(!this.expanded&&!this.morphing)this.previousFocus=document.activeElement as HTMLElement;void this.morphCard(id);}
  private collapse(){void this.morphCard('');}
  private async morphCard(next:string){
    const id=next||this.expanded||this.morphingCard;if(!id)return;
    const find=()=>[...this.querySelectorAll<HTMLElement>('.dashboard-card')].find(card=>card.dataset.cardId===id);
    const before=find()?.getBoundingClientRect(),backdrop=this.querySelector('.dashboard-expanded-backdrop');
    const opacity=backdrop?Number.parseFloat(getComputedStyle(backdrop).opacity):0;
    const epoch=++this.morphEpoch;for(const animation of this.morphAnimations)animation.cancel();this.morphAnimations=[];
    this.expanded=next;this.morphingCard=id;this.morphing=!matchMedia('(prefers-reduced-motion: reduce)').matches;
    await this.updateComplete;if(epoch!==this.morphEpoch||this.retired)return;
    try{
      const card=find(),after=card?.getBoundingClientRect();
      if(!this.morphing||!card||!before||!after||typeof card.animate!=='function')return;
      const from=dashboardTransform(before,after,next?1:this.canvasScale);if(!from)return;
      const css=getComputedStyle(this),raw=css.getPropertyValue('--duration-normal').trim();
      const duration=Math.max(140,Math.min(400,(parseFloat(raw)||.28)*(raw.endsWith('ms')?1:1000)));
      const options={duration,easing:css.getPropertyValue('--ease-standard').trim()||'cubic-bezier(.2,.8,.2,1)'};
      const animation=card.animate([{transform:from,transformOrigin:'0 0'},{transform:'none',transformOrigin:'0 0'}],options);
      this.morphAnimations=[animation];const shade=this.querySelector<HTMLElement>('.dashboard-expanded-backdrop');
      if(shade)this.morphAnimations.push(shade.animate([{opacity},{opacity:next?1:0}],options));
      await animation.finished;
    }catch{/* Interruption cancels the previous animation; the next one starts at its measured geometry. */}
    finally{if(epoch===this.morphEpoch){this.morphing=false;this.morphingCard='';this.morphAnimations=[];if(!next)this.previousFocus?.focus();}}
  }
  private trapFocus=(event:FocusEvent)=>{if(!this.expanded||this.taskCard||this.dialog)return;const card=this.querySelector('[data-expanded="true"]');if(card&&!card.contains(event.target as Node))this.querySelector<HTMLButtonElement>('[data-expanded="true"] [data-card-close]')?.focus();};
  private frameMessage=async(event:MessageEvent)=>{
    const frame=[...this.querySelectorAll<HTMLIFrameElement>('.dashboard-card iframe')].find(el=>el.contentWindow===event.source);if(!frame||event.data?.type!=='cryoclaw:dashboard')return;
    if(event.data.action==='compose'&&navigator.userActivation?.isActive&&document.activeElement===frame&&typeof event.data.value==='string'&&event.data.value.trim()&&event.data.value.length<=2000){this.onAskModel?.(event.data.value);this.ask();return;}
    if(event.data.action==='tasks'&&navigator.userActivation?.isActive&&document.activeElement===frame){this.taskCard=frame.dataset.cardId!;return;}
    if(event.data.action==='collapse'){if(this.expanded===frame.dataset.cardId)this.collapse();return;}
    if(event.data.action==='expand'&&navigator.userActivation?.isActive)this.expand(frame.dataset.cardId!);
    if(event.data.action==='refresh'&&Date.now()-this.lastFrameRefresh>15000){this.lastFrameRefresh=Date.now();const key=`${this.selected}/${frame.dataset.cardId}`;this.cardRefresh.set(key,(this.cardRefresh.get(key)??0)+1);this.cardRefreshVersion++;void this.load(true);}
    if(event.data.action==='openLink'&&navigator.userActivation?.isActive&&document.activeElement===frame&&Date.now()-this.lastExternalOpen>5000&&typeof event.data.value==='string'){
      try{const url=new URL(event.data.value);if(url.protocol==='https:'&&!url.username&&!url.password){this.lastExternalOpen=Date.now();void (window as unknown as {cryoclaw?:{openExternal?:(url:string)=>void}}).cryoclaw?.openExternal?.(url.href);}}catch{}return;
    }
    if(!['getState','setState','data','system'].includes(event.data.action)||typeof event.data.requestId!=='string'||event.data.requestId.length>128||!this.client||!this.connected)return;
    let rate=this.frameRates.get(frame);if(!rate||Date.now()-rate.at>10000){rate={at:Date.now(),count:0};this.frameRates.set(frame,rate);}if(++rate.count>30)return;
    const client=this.client,epoch=this.epoch,boardId=this.selected,cardId=frame.dataset.cardId,src=frame.src,source=frame.contentWindow,requestId=event.data.requestId;
    const reply=(value:unknown,error?:string)=>{if(!this.retired&&client===this.client&&epoch===this.epoch&&boardId===this.selected&&frame.isConnected&&frame.src===src)source?.postMessage({type:'cryoclaw:dashboard:result',requestId,value,error},'*');};
    try{if(event.data.action==='setState'&&JSON.stringify(event.data.value).length>32768)throw Error('Card state exceeds 32 KiB');const value=await client.request(`cryoclaw.dashboards.${event.data.action}`,{boardId,cardId,...event.data.action==='data'?{id:event.data.value}:{},...event.data.action==='setState'?{value:event.data.value}:{}});reply(value);}catch(error){reply(undefined,error instanceof Error?error.message:'Card operation failed');}
  };
  private async measure(){if(!this.client||!this.connected||this.measuring)return;const client=this.client,epoch=this.epoch;this.measuring=true;try{const sample=await client.request<SystemSample>('cryoclaw.dashboards.system',{});if(client===this.client&&epoch===this.epoch&&!this.retired){this.sample=sample;this.sampleCount++;}}catch{if(client===this.client&&epoch===this.epoch)this.error=t('dashboard.measureFailed');}finally{if(client===this.client&&epoch===this.epoch)this.measuring=false;}}
  private system(){const s=this.sample,percent=s?.cpuPercent??0,disk=s?.diskTotal&&s.diskFree!==null?100*(1-s.diskFree/s.diskTotal):0;
    return html`<div class="dashboard-system"><div class="dashboard-system__intro"><h2>${t('dashboard.runTitle')}</h2><p>${t('dashboard.runDescription')}</p><button class="dashboard-system__run" ?disabled=${this.measuring||!this.connected} @click=${()=>this.measure()}>${this.measuring?t('dashboard.measuring'):t('dashboard.measureAgain')}</button></div>
      <div class="dashboard-system__report"><h3>${s?`${s.platform} · ${t('dashboard.measureDone')}`:t('dashboard.measureReady')}</h3><p class="dashboard-system__stamp">${s?`${new Date(s.sampledAt).toLocaleTimeString()} · ${(s.elapsedMs/1000).toFixed(1)}s · ${t('dashboard.measureCount').replace('{n}',String(this.sampleCount))}`:'—'}</p>
      ${[['CPU',percent,s?`${s.cpuCount} ${t('dashboard.cores')} · ${s.cpuPercent===null?'—':s.cpuPercent.toFixed(0)+'%'}`:'—'],[t('dashboard.disk'),disk,s?.diskFree!==null&&s?.diskFree!==undefined?`${t('dashboard.available')} ${(s.diskFree/1024**3).toFixed(0)} GB`:'—'],[t('dashboard.system'),100,s?.platform??'—']].map(([label,value,detail])=>html`<div class="dashboard-system__row"><strong>${label}</strong><span class="dashboard-system__track"><i style=${styleMap({width:`${value}%`})}></i></span><span>${detail}</span></div>`)}</div></div>`;
  }
  private async pin(card:DashboardCard){try{if(!this.client)return;const result=await this.client.request<{frameUrl:string}>('cryoclaw.dashboards.pin',{boardId:this.selected,cardId:card.id}),url=dashboardFrameUrl(this.settings.gatewayUrl,result.frameUrl);if(!url)throw Error('Invalid card URL');const bridge=(window as unknown as {cryoclaw?:{pinDashboardCard?:(params:unknown)=>Promise<unknown>}}).cryoclaw;if(!bridge?.pinDashboardCard)throw Error('Desktop bridge unavailable');await bridge.pinDashboardCard({id:`${this.selected}/${card.id}`,title:card.title,url,width:this.querySelector(`[data-card-id="${card.id}"]`)?.getBoundingClientRect().width??500,height:card.layout.h});}catch{this.error=t('dashboard.pinFailed');}}
  private arrange(){const cards=this.board?.cards??[],small=cards.filter(c=>c.layout.w<12).length;this.replaceCards(cards.map((c,index)=>({...c,layout:{...c.layout,order:index,w:c.layout.w===12?12:small>=3?4:6}})));this.compact=false;this.saveLayout();}
  private ask(){void this.showComposer(true);void this.updateComplete.then(()=>this.querySelector<HTMLTextAreaElement>('.chat-compose__field textarea')?.focus());}
  private async showComposer(open:boolean){
    if(!open&&!this.board?.cards.length)return;
    const element=this.querySelector<HTMLElement>('.dashboard-compose'),current=element?getComputedStyle(element):null;
    const from=current?{opacity:current.opacity,transform:current.transform}:{opacity:'0',transform:'translate(-50%,10px)'};
    const epoch=++this.composerEpoch;this.composerAnimation?.cancel();this.composerAnimation=null;
    this.composerOpen=open;this.composerLeaving=!open;await this.updateComplete;
    if(epoch!==this.composerEpoch||this.retired)return;
    const target=this.querySelector<HTMLElement>('.dashboard-compose');
    try{if(target&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
      this.composerAnimation=target.animate([from,{opacity:open?'1':'0',transform:open?'translate(-50%,0)':'translate(-50%,10px)'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});
      await this.composerAnimation.finished;
    }}catch{/* A reverse action continues from the visible position. */}
    finally{if(epoch===this.composerEpoch){this.composerLeaving=false;await this.updateComplete;this.composerAnimation?.cancel();this.composerAnimation=null;}}
  }
  private async createExample(){const result=await this.mutate({action:'create_example',title:'Hello World · 2'});if(result)this.select(result.board.id);}
  private card(card:DashboardCard){const g=this.gesture,expanded=this.expanded===card.id,url=dashboardFrameUrl(this.settings.gatewayUrl,card.frameUrl);
    return html`<div class="dashboard-card-slot" style=${styleMap({'grid-column':`span ${card.layout.w}`,height:`${card.layout.h}px`})}><article class="dashboard-card dashboard-card--${card.accent} ${g?.id===card.id?'is-dragging':''} ${g?.target===card.id&&g.id!==card.id?'is-drop-target':''}" data-card-id=${card.id} data-expanded=${String(expanded)} role=${expanded?'dialog':'group'} aria-modal=${expanded?'true':nothing} aria-label=${card.title}
      style=${styleMap({height:'100%',transform:g?.kind==='drag'&&g.id===card.id?`translate(${g.dx/this.canvasScale}px,${g.dy/this.canvasScale}px)`:undefined})}>
      <header class="dashboard-card__chrome"><span class="dashboard-card__title">${card.title}</span><button class="dashboard-card__drag" aria-label=${`${t('dashboard.drag')} ${card.title}`} title=${t('dashboard.dragHint')} @pointerdown=${(e:PointerEvent)=>this.start(e,card,'drag')} @keydown=${(e:KeyboardEvent)=>this.cardKey(e,card)}><span></span></button>
        <div class="dashboard-card__actions"><button title=${t('dashboard.pin')} aria-label=${t('dashboard.pin')} @click=${()=>this.pin(card)}>${icons.pin}</button><button class="dashboard-card__tasks" title=${t('dashboard.cardTasks')} aria-label=${t('dashboard.cardTasks')} @click=${()=>{this.taskCard=card.id;}}>${icons.clock}${card.taskLinks?.length?html`<small>${card.taskLinks.length}</small>`:nothing}</button><button title=${expanded?t('chat.board.restore'):t('chat.board.expand')} aria-label=${expanded?t('chat.board.restore'):t('chat.board.expand')} data-card-close @click=${()=>expanded?this.collapse():this.expand(card.id)}>${expanded?icons.x:icons.externalLink}</button>${this.editing?html`<button title=${t('dashboard.removeCard')} aria-label=${t('dashboard.removeCard')} @click=${()=>void this.mutate({action:'remove_card',boardId:this.selected,cardId:card.id})}>${icons.trash}</button>`:nothing}</div></header>
      <div class="dashboard-card__content"><div class="dashboard-card__surface" style=${styleMap({width:expanded?'1600px':'100%',height:expanded?'900px':'100%',transform:expanded?`scale(${this.expandedScale})`:'none'})}>${card.kind==='system'?this.system():url?html`<iframe loading="lazy" data-card-id=${card.id} src=${`${url}&refresh=${this.refreshNonce}-${this.cardRefresh.get(`${this.selected}/${card.id}`)??0}`} title=${card.title} sandbox="allow-scripts" referrerpolicy="no-referrer" allow="autoplay" @load=${(e:Event)=>this.postFrameVisibility(e.target as HTMLIFrameElement)}></iframe>`:nothing}</div></div>
      ${!expanded?html`<button class="dashboard-card__resize" aria-label=${`${t('dashboard.resize')} ${card.title}`} title=${t('dashboard.resizeHint')} @pointerdown=${(e:PointerEvent)=>this.start(e,card,'resize')} @keydown=${(e:KeyboardEvent)=>this.cardKey(e,card,true)}><span></span></button>`:nothing}</article></div>`;
  }
  render(){const board=this.board,visible=this.boards.filter(b=>this.showArchived||!b.archived);
    return html`<section class="dashboard-workspace ${this.compact?'is-compact':''} ${this.editing?'is-editing':''} ${this.composerOpen||this.composerLeaving||!board?.cards.length?'has-composer':''} ${this.morphing?'is-morphing':''} ${this.focusMode?'is-focused':''} ${this.gesture?'is-gesturing':''}">
      <nav class="dashboard-tabs" aria-label=${t('dashboard.boards')}><div class="dashboard-tabs__list" role="tablist">${visible.map(b=>html`<button role="tab" aria-selected=${String(b.id===this.selected)} aria-controls="dashboard-panel" tabindex=${b.id===this.selected?0:-1} data-board-id=${b.id} class=${b.id===this.selected?'is-active':''} @click=${()=>this.select(b.id)} @keydown=${(event:KeyboardEvent)=>this.tabKey(event,b.id)}>${icons.layout}<span>${b.title}</span>${b.archived?html`<small>${t('dashboard.archived')}</small>`:nothing}</button>`)}</div><button class="dashboard-tabs__add" aria-label=${t('dashboard.create')} title=${t('dashboard.create')} ?disabled=${!this.connected||this.saving} @click=${()=>this.openDialog('create')}>${icons.plus}</button><button class="dashboard-tabs__ask" title=${t('dashboard.askModel')} ?disabled=${!this.connected||this.saving||!board||board.archived} @click=${()=>this.ask()}>${icons.brain}<span>${t('dashboard.askModel')}</span></button></nav>
      ${this.error?html`<div class="dashboard-notice" role="status">${this.error}<button @click=${()=>void this.load(true)}>${t('chat.board.refresh')}</button></div>`:nothing}
      <div class="dashboard-workspace__scroll" id="dashboard-panel" role="tabpanel" aria-label=${board?.title??t('dashboard.boards')}>${board?.cards.length?html`<div class="dashboard-canvas-viewport" style=${styleMap({width:`${1600*this.canvasScale}px`,height:`${this.canvasHeight*this.canvasScale}px`})}><div class="dashboard-canvas" style=${styleMap({transform:this.expanded?'none':`scale(${this.canvasScale})`})} aria-busy=${this.loading}>${guard([board.id,board.cards,this.expanded,this.gesture,this.canvasScale,this.expandedScale,this.refreshNonce,this.cardRefreshVersion,this.editing,this.sample,this.measuring],()=>repeat(board.cards,c=>`${board.id}/${c.id}`,c=>this.card(c)))}</div></div>`:html`<div class="dashboard-empty"><span>${icons.layout}</span><h1>${this.loading?t('dashboard.loading'):t('dashboard.emptyBoard')}</h1><p>${t('dashboard.independentHint')}</p><div class="dashboard-empty__ideas">${['focus','briefing','projects'].map(key=>html`<button ?disabled=${!this.connected||!board} @click=${()=>{this.onAskModel?.(t(`dashboard.idea.${key}`));this.ask();}}>${t(`dashboard.idea.${key}`)}</button>`)}</div><button class="dashboard-empty__example" ?disabled=${!this.connected||this.saving} @click=${()=>this.createExample()}>${t('dashboard.createExample')} ${icons.arrowRight}</button></div>`}</div>
      ${board&&this.composeProps&&(this.composerOpen||this.composerLeaving||!board.cards.length)?html`<aside class="dashboard-compose" aria-label=${t('dashboard.askModel')}>${board.cards.length?html`<button class="dashboard-compose__close" aria-label=${t('settings.cancel')} @click=${()=>void this.showComposer(false)}>${icons.x}</button>`:nothing}${renderDashboardCompose(this.composeProps,board.id,board.title,this.onOpenChat)}</aside>`:nothing}
      ${board?html`<div class="dashboard-floatbar" role="toolbar" aria-label=${t('dashboard.tools')}><button class="dashboard-floatbar__edit" title=${t('dashboard.edit')} aria-label=${t('dashboard.edit')} aria-pressed=${String(this.editing)} @click=${()=>{this.editing=!this.editing;void this.showComposer(this.editing);}}>${icons.edit}</button><button title=${t('dashboard.arrange')} aria-label=${t('dashboard.arrange')} @click=${()=>this.arrange()}>${icons.layout}</button><button title=${t('chat.board.refresh')} aria-label=${t('chat.board.refresh')} @click=${()=>{this.refreshNonce++;void this.load(true);}}>${icons.rotateCcw}</button><button title=${t('dashboard.focus')} aria-label=${t('dashboard.focus')} aria-pressed=${String(this.focusMode)} @click=${()=>{this.focusMode=!this.focusMode;}}>${icons.externalLink}</button><details class="dashboard-menu"><summary aria-label=${t('dashboard.more')} title=${t('dashboard.more')}>${icons.moreHorizontal}</summary><div><button @click=${()=>this.createExample()}>${t('dashboard.createExample')}</button><button @click=${()=>this.openDialog('rename')}>${t('dashboard.rename')}</button><button @click=${()=>{this.compact=!this.compact;}}>${t('dashboard.compact')}</button><button @click=${()=>{this.showArchived=!this.showArchived;}}>${t('dashboard.showArchived')}</button>${board.archived?html`<button @click=${()=>void this.mutate({action:'restore',boardId:board.id})}>${t('dashboard.restore')}</button><button class="dashboard-menu__danger" @click=${()=>this.openDialog('delete')}>${t('dashboard.delete')}</button>`:html`<button @click=${()=>this.openDialog('archive')}>${t('dashboard.archive')}</button><button class="dashboard-menu__danger" @click=${()=>this.openDialog('delete')}>${t('dashboard.delete')}</button>`}</div></details>${this.saving?html`<span class="dashboard-save-state" role="status">${t('dashboard.saving')}</span>`:nothing}</div>`:nothing}
      ${this.expanded||this.morphing?html`<div class="dashboard-expanded-backdrop" @click=${()=>this.collapse()}></div>`:nothing}
      ${this.taskCard?html`<oc-dashboard-tasks .client=${this.client} .boardId=${this.selected} .card=${board?.cards.find(c=>c.id===this.taskCard)??null} .onClose=${()=>{this.taskCard='';}} .onChanged=${()=>void this.load(true)} .onManage=${()=>{this.taskCard='';this.onOpenTasks?.();}}></oc-dashboard-tasks>`:nothing}
      <dialog class="dashboard-dialog" @cancel=${()=>{this.dialog='';}} @close=${()=>{this.dialog='';}}><form @submit=${this.submit}><h2>${t(this.dialog==='create'?'dashboard.create':this.dialog==='archive'?'dashboard.archive':this.dialog==='delete'?'dashboard.delete':'dashboard.rename')}</h2>${this.dialog==='archive'||this.dialog==='delete'?html`<p>${t(this.dialog==='delete'?'dashboard.deleteHint':'dashboard.archiveHint')}</p>`:html`<label>${t('dashboard.name')}<input maxlength="80" required .value=${this.titleDraft} @input=${(e:Event)=>{this.titleDraft=(e.target as HTMLInputElement).value;}}></label>`}<footer><button type="button" class="btn" ?disabled=${this.preparingArchive} @click=${()=>{this.dialog='';}}>${t('settings.cancel')}</button><button type="submit" class="btn ${this.dialog==='delete'?'danger':'btn--primary'}" ?disabled=${this.saving||this.preparingArchive||this.dialog!=='archive'&&!this.titleDraft.trim()}>${this.saving?t('dashboard.saving'):this.dialog==='delete'?t('dashboard.delete'):t('settings.confirm')}</button></footer></form></dialog>
    </section>`;
  }
}
