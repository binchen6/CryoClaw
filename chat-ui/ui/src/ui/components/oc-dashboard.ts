import {LitElement,html,nothing,type PropertyValues} from 'lit';
import {customElement} from 'lit/decorators.js';
import {repeat} from 'lit/directives/repeat.js';
import {styleMap} from 'lit/directives/style-map.js';
import {guard} from 'lit/directives/guard.js';
import type {GatewayBrowserClient} from '../gateway.ts';
import {icons} from '../icons.ts';
import {t} from '../i18n.ts';
import {bound,dashboardSize,arrangeDashboardCards,dashboardFrameUrl,reorderDashboardCards,type Dashboard,type DashboardCard,type DashboardSnapshot,type SystemSample} from '../dashboard-model.ts';
import './oc-dashboard-tasks.ts';
import type {ChatProps} from '../views/chat.ts';
import {renderDashboardCompose} from '../views/dashboard-compose.ts';
import {resetComposeTransient} from '../views/chat-compose.ts';
import {dashboardTransform} from '../dashboard-motion.ts';
import {isViewTransitionActive} from '../utils/view-transition.ts';
import {dashboardElementTarget,dashboardNodeSelector,type DashboardSelection} from '../dashboard-selection.ts';
import {placePopover} from '../utils/popover-placement.ts';
import './oc-dashboard-library.ts';

type Gesture={kind:'drag'|'resize';id:string;pointerId:number;x:number;y:number;dx:number;dy:number;w:number;h:number;target:string;before:DashboardCard[]};
type DragTarget={id:string;element:HTMLElement;x:number;y:number};
@customElement('oc-dashboard')
export class OcDashboard extends LitElement{
  static properties={client:{attribute:false},connected:{type:Boolean},settings:{attribute:false},onAskModel:{attribute:false},onOpenTasks:{attribute:false},onError:{attribute:false},composeProps:{attribute:false},onOpenChat:{attribute:false},composerOpen:{state:true},composerLeaving:{state:true},morphing:{state:true},cardRefreshVersion:{state:true},taskCard:{state:true},boards:{state:true},selected:{state:true},loading:{state:true},error:{state:true},editing:{state:true},expanded:{state:true},compact:{state:true},focusMode:{state:true},dialog:{state:true},titleDraft:{state:true},descriptionDraft:{state:true},templateDraft:{state:true},tabMenu:{state:true},selection:{state:true},libraryOpen:{state:true},gesture:{state:true},sample:{state:true},measuring:{state:true},sampleCount:{state:true},saving:{state:true},preparingArchive:{state:true},layoutUndo:{state:true},showArchived:{state:true},refreshNonce:{state:true},frameMountVersion:{state:true}};
  client:GatewayBrowserClient|null=null;connected=false;settings={gatewayUrl:''};onAskModel?:(prompt:string)=>void;onOpenTasks?:()=>void;onError?:(message:string)=>void;
  private boards:Dashboard[]=[];private selected='';private loading=false;private error='';private editing=false;private expanded='';private compact=false;private focusMode=false;
  private dialog:''|'create'|'rename'|'archive'|'delete'|'remove'='';private titleDraft='';private gesture:Gesture|null=null;private sample:SystemSample|null=null;private measuring=false;private sampleCount=0;private saving=false;private showArchived=false;private refreshNonce=0;private preparingArchive=false;
  private taskCard='';private layoutUndo:{boardId:string;cards:DashboardCard[]}|null=null;
  private dialogBoardId='';private dialogCardId='';private descriptionDraft='';private templateDraft='';private tabMenu:{boardId:string;x:number;y:number}|null=null;private menuFocus:HTMLElement|null=null;private selection:DashboardSelection|null=null;private libraryOpen=false;
  private pendingLayouts=new Map<string,{boardId:string;layouts:Array<{cardId:string;w:number;h:number;order:number;free?:boolean}>}>();private mutationRequest:Promise<unknown>|null=null;private suppressSelectionUntil=0;
  private composerOpen=false;private composerLeaving=false;private composerEpoch=0;private composerAnimation:Animation|null=null;
  composeProps:ChatProps|null=null;onOpenChat?:()=>void;
  private moveFrame=0;private latestMove:PointerEvent|null=null;private dragTargets:DragTarget[]=[];
  private cardRefresh=new Map<string,number>();private cardRefreshVersion=0;private frameReady=new Set<string>();private frameMountVersion=0;private boardTransition:Animation|ViewTransition|null=null;private selectEpoch=0;
  private morphing=false;private morphingCard='';private morphEpoch=0;private morphAnimations:Animation[]=[];private layoutEpoch=0;private layoutAnimations:Animation[]=[];
  private readonly canvasScale=1;private resizeObserver:ResizeObserver|null=null;
  private visibilityObserver:IntersectionObserver|null=null;private prefetchObserver:IntersectionObserver|null=null;private observedFrames=new Set<HTMLIFrameElement>();
  private postFrameVisibility=(frame:HTMLIFrameElement)=>{frame.contentWindow?.postMessage({type:'cryoclaw:dashboard:visibility',active:!document.hidden&&frame.dataset.visible==='true'},'*');this.postInspector(frame);};
  private postInspector=(frame:HTMLIFrameElement)=>frame.contentWindow?.postMessage({type:'cryoclaw:dashboard:inspect',active:this.editing&&!this.board?.archived,selector:this.selection&&this.selection.cardId===frame.dataset.cardId?this.selection.selector:null,color:getComputedStyle(this).getPropertyValue('--accent').trim()},'*');
  private pageVisibility=()=>{for(const frame of this.querySelectorAll<HTMLIFrameElement>('.dashboard-card iframe'))this.postFrameVisibility(frame);};
  private fitFrame=0;
  private fitCanvas=()=>{const height=`${this.querySelector<HTMLElement>('.dashboard-compose')?.offsetHeight??0}px`;if(this.style.getPropertyValue('--dashboard-compose-height')!==height)this.style.setProperty('--dashboard-compose-height',height);};
  private queueFitCanvas=()=>{if(!this.fitFrame)this.fitFrame=requestAnimationFrame(()=>{this.fitFrame=0;if(!this.retired)this.fitCanvas();});};
  private revision=-1;private epoch=0;private operation=0;private polling:ReturnType<typeof setInterval>|null=null;private pending=false;private retired=false;private lastFrameRefresh=0;private lastExternalOpen=0;private previousFocus:HTMLElement|null=null;private morphOrigin:{id:string;rect:DOMRect;scrollTop:number}|null=null;private frameRates=new WeakMap<HTMLIFrameElement,{at:number;count:number}>();private mountQueue:string[]=[];private mountPump=0;private wheelPending=0;private wheelFrame=0;private prefetchTimer:ReturnType<typeof setTimeout>|null=null;private prefetched='';
  createRenderRoot(){return this;}
  protected willUpdate(changed:PropertyValues){if(changed.has('selected')){this.frameReady.clear();this.mountQueue=[];if(this.mountPump)cancelAnimationFrame(this.mountPump);this.mountPump=0;this.wheelPending=0;this.prefetched='';if(this.prefetchTimer){clearTimeout(this.prefetchTimer);this.prefetchTimer=null;}}}
  private mountFrame(frame:HTMLIFrameElement,immediate=false){const key=`${this.selected}/${frame.dataset.cardId}`;if(this.frameReady.has(key)||this.mountQueue.includes(key))return;if(immediate)this.mountQueue.unshift(key);else this.mountQueue.push(key);this.pumpMounts();}
  private pumpMounts(){if(this.mountPump||!this.mountQueue.length)return;this.mountPump=requestAnimationFrame(()=>{this.mountPump=0;if(this.retired)return;const key=this.mountQueue.shift();if(!key)return;this.frameReady.add(key);this.frameMountVersion++;if(this.mountQueue.length)this.pumpMounts();});}
  private queueWheel(delta:number){if(!Number.isFinite(delta)||!delta)return;this.wheelPending+=Math.max(-1200,Math.min(1200,delta));if(this.wheelFrame)return;this.wheelFrame=requestAnimationFrame(()=>{this.wheelFrame=0;const pending=this.wheelPending;this.wheelPending=0;if(!pending||this.retired)return;const scroller=this.querySelector<HTMLElement>('.dashboard-workspace__scroll');if(!scroller)return;const max=Math.max(0,scroller.scrollHeight-scroller.clientHeight);scroller.scrollTop=Math.max(0,Math.min(max,scroller.scrollTop+pending));});}
  connectedCallback(){super.connectedCallback();this.retired=false;try{this.selected=localStorage.getItem('cryoclaw.dashboard.selected')??'';}catch{}
    window.addEventListener('pointermove',this.move);window.addEventListener('pointerup',this.finish);window.addEventListener('pointercancel',this.cancel);window.addEventListener('keydown',this.key);window.addEventListener('message',this.frameMessage);document.addEventListener('focusin',this.trapFocus);document.addEventListener('pointerdown',this.dismissTabMenu,true);this.addEventListener('pointerdown',this.inspectNative,true);this.addEventListener('click',this.inspectNative,true);
    this.polling=setInterval(()=>{if(!document.hidden&&!this.gesture&&!this.saving)void this.load();},2500);
  }
  disconnectedCallback(){this.closeExpandedLayer();this.persistQueuedLayout();this.composerEpoch++;this.composerAnimation?.cancel();this.cancelBoardTransition();this.cancelLayoutMotion();this.morphEpoch++;for(const animation of this.morphAnimations)animation.cancel();this.morphAnimations=[];this.cancel();if(this.composeProps)resetComposeTransient(this.composeProps);this.retired=true;this.epoch++;if(this.mountPump)cancelAnimationFrame(this.mountPump);this.mountPump=0;if(this.wheelFrame)cancelAnimationFrame(this.wheelFrame);this.wheelFrame=0;this.mountQueue=[];this.wheelPending=0;this.prefetched='';if(this.prefetchTimer){clearTimeout(this.prefetchTimer);this.prefetchTimer=null;}if(this.polling)clearInterval(this.polling);this.polling=null;this.resizeObserver?.disconnect();this.resizeObserver=null;this.visibilityObserver?.disconnect();this.visibilityObserver=null;this.prefetchObserver?.disconnect();this.prefetchObserver=null;this.observedFrames=new Set();document.removeEventListener('visibilitychange',this.pageVisibility);window.removeEventListener('resize',this.fitCanvas);window.removeEventListener('pointermove',this.move);window.removeEventListener('pointerup',this.finish);window.removeEventListener('pointercancel',this.cancel);window.removeEventListener('keydown',this.key);window.removeEventListener('message',this.frameMessage);document.removeEventListener('focusin',this.trapFocus);document.removeEventListener('pointerdown',this.dismissTabMenu,true);this.removeEventListener('pointerdown',this.inspectNative,true);this.removeEventListener('click',this.inspectNative,true);super.disconnectedCallback();}
  protected updated(changed:PropertyValues){
    if(this.retired)return;
    if(!this.resizeObserver){this.resizeObserver=new ResizeObserver(this.queueFitCanvas);for(const element of this.querySelectorAll('.dashboard-workspace__scroll,.dashboard-canvas,.dashboard-compose'))this.resizeObserver.observe(element);window.addEventListener('resize',this.fitCanvas);this.fitCanvas();}
    for(const element of this.querySelectorAll('.dashboard-workspace__scroll,.dashboard-canvas,.dashboard-compose'))this.resizeObserver.observe(element);
    // Prewarm near the viewport without waking offscreen card animations.
    if(!this.visibilityObserver){this.visibilityObserver=new IntersectionObserver(entries=>{if(this.retired)return;for(const entry of entries){const frame=entry.target as HTMLIFrameElement;if(!frame.isConnected||!this.observedFrames.has(frame))continue;if(entry.isIntersecting)this.mountFrame(frame,true);frame.dataset.visible=String(entry.isIntersecting);this.postFrameVisibility(frame);}},{root:this.querySelector('.dashboard-workspace__scroll'),rootMargin:'0px',threshold:0.01});document.addEventListener('visibilitychange',this.pageVisibility);}
    if(!this.prefetchObserver)this.prefetchObserver=new IntersectionObserver(entries=>{if(this.retired)return;for(const entry of entries){const frame=entry.target as HTMLIFrameElement;if(entry.isIntersecting&&frame.isConnected&&this.observedFrames.has(frame))this.mountFrame(frame,true);}},{root:this.querySelector('.dashboard-workspace__scroll'),rootMargin:'900px 0px',threshold:0.01});
    for(const frame of this.observedFrames)if(!frame.isConnected){this.visibilityObserver.unobserve(frame);this.prefetchObserver.unobserve(frame);this.observedFrames.delete(frame);}
    for(const frame of this.querySelectorAll<HTMLIFrameElement>('.dashboard-card iframe'))if(!this.observedFrames.has(frame)){this.observedFrames.add(frame);this.visibilityObserver.observe(frame);this.prefetchObserver.observe(frame);}
    if(this.prefetched!==this.selected&&!this.prefetchTimer&&!this.mountQueue.length&&!this.gesture){this.prefetchTimer=setTimeout(()=>{this.prefetchTimer=null;if(this.retired||this.gesture)return;this.prefetched=this.selected;for(const frame of this.querySelectorAll<HTMLIFrameElement>('.dashboard-card iframe'))if(!frame.getAttribute('src'))this.mountFrame(frame);},900);}
    if(changed.has('editing')||changed.has('selection'))for(const frame of this.querySelectorAll<HTMLIFrameElement>('.dashboard-card iframe'))this.postInspector(frame);
    if(changed.has('editing')||changed.has('selection')){for(const element of this.querySelectorAll('[data-dashboard-selected-element]'))element.removeAttribute('data-dashboard-selected-element');if(this.editing&&this.selection?.selector){const root=this.querySelector(`[data-card-id="${this.selection.cardId}"] .dashboard-card__content`);try{root?.querySelector(this.selection.selector)?.setAttribute('data-dashboard-selected-element','');}catch{}}}
    if(changed.has('client')||changed.has('connected')){this.epoch++;this.operation++;this.pending=false;this.saving=false;this.pendingLayouts.clear();if(this.connected){this.revision=-1;void this.load(true);}else{this.loading=false;this.editing=false;this.selection=null;}}
    const dialog=this.querySelector<HTMLDialogElement>(':scope > .dashboard-workspace > .dashboard-dialog');if(this.dialog&&dialog&&!dialog.open){dialog.showModal();void Promise.resolve().then(()=>{const input=dialog.querySelector<HTMLInputElement>('input');input?.focus();if(this.dialog==='create')input?.select();});}else if(!this.dialog&&dialog?.open)dialog.close();
    if(changed.has('expanded')&&this.expanded)this.querySelector<HTMLButtonElement>('[data-expanded="true"] [data-card-close]')?.focus({preventScroll:true});
  }
  private get board(){return this.boards.find(b=>b.id===this.selected);}
  private async load(force=false){
    if(!this.client||!this.connected||this.pending||this.retired)return;const client=this.client,epoch=this.epoch,operation=this.operation;this.pending=true;if(!this.boards.length)this.loading=true;
    try{
      const snapshot=await client.request<DashboardSnapshot>('cryoclaw.dashboards.list',{...!force?{sinceRevision:this.revision}:{},includeArchived:true});
      if(this.retired||client!==this.client||epoch!==this.epoch||this.gesture||this.saving||operation!==this.operation)return;
      if(!snapshot.unchanged){this.boards=(snapshot.boards??[]).map(b=>({...b,cards:[...b.cards].sort((a,b)=>a.layout.order-b.layout.order)}));this.revision=snapshot.revision;}
      if(!this.boards.length&&snapshot.revision===0){const created=await client.request<{board:{id:string}}>('cryoclaw.dashboards.mutate',{action:'seed'});if(this.retired||client!==this.client||epoch!==this.epoch)return;this.selected=created.board.id;this.pending=false;await this.load(true);return;}
      if(!this.board||this.board.archived&&!this.showArchived){const next=this.boards.find(b=>!b.archived)?.id??this.boards[0]?.id??'';if(next!==this.selected){this.clearBoardContext();this.selected=next;}}
      if(this.selection&&!this.board?.cards.some(card=>card.id===this.selection?.cardId))this.selection=null;
      if(this.expanded&&(this.board?.archived||!this.board?.cards.some(card=>card.id===this.expanded))){this.closeExpandedLayer();this.expanded='';}if(this.board?.archived){this.editing=false;this.selection=null;}
      if(this.tabMenu&&!this.boards.some(board=>board.id===this.tabMenu?.boardId))this.closeTabMenu();
      if(this.error===t('dashboard.loadFailed'))this.error='';
    }catch{if(client===this.client&&epoch===this.epoch)this.error=t('dashboard.loadFailed');}
    finally{if(client===this.client&&epoch===this.epoch){this.pending=false;this.loading=false;}}
  }
  private async mutate(params:Record<string,unknown>){
    if(!this.client||!this.connected||this.saving)return null;const client=this.client,epoch=this.epoch,operation=++this.operation;this.saving=true;
    try{const request=client.request<{board:{id:string}}>('cryoclaw.dashboards.mutate',{...params,requestId:crypto.randomUUID()});this.mutationRequest=request;const result=await request;if(client!==this.client||epoch!==this.epoch||this.retired)return null;this.error='';return result;}
    catch{if(client===this.client&&epoch===this.epoch)this.error=t('dashboard.saveFailed');return null;}
    finally{if(operation===this.operation&&client===this.client&&epoch===this.epoch){this.mutationRequest=null;this.saving=false;if(this.pendingLayouts.size)void this.flushLayout();else void this.load(true);}}
  }
  private cancelBoardTransition(){const transition=this.boardTransition;if(!transition)return;if('skipTransition'in transition)transition.skipTransition();else transition.cancel();this.boardTransition=null;}
  private clearBoardContext(){this.layoutUndo=null;this.morphOrigin=null;this.closeExpandedLayer();this.expanded='';this.selection=null;this.editing=false;this.libraryOpen=false;this.taskCard='';this.composerEpoch++;this.composerAnimation?.cancel();this.composerAnimation=null;this.composerOpen=false;this.composerLeaving=false;}
  private select(id:string){
    if(this.selected===id)return;
    this.clearBoardContext();this.closeTabMenu(false);
    this.cancelBoardTransition();this.cancelLayoutMotion();this.morphEpoch++;for(const animation of this.morphAnimations)animation.cancel();this.morphAnimations=[];this.morphing=false;this.cancel();this.expanded='';
    const epoch=++this.selectEpoch,apply=()=>{if(epoch!==this.selectEpoch)return;this.selected=id;try{localStorage.setItem('cryoclaw.dashboard.selected',id);}catch{}};
    const startViewTransition=(document as Document & {startViewTransition?: (update:()=>Promise<void>)=>ViewTransition}).startViewTransition;
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&!isViewTransitionActive()&&startViewTransition){
      try{const transition=startViewTransition.call(document,async()=>{apply();await this.updateComplete;});this.boardTransition=transition;
        void transition.ready.catch(()=>{});void transition.updateCallbackDone.catch(()=>{});
        void transition.finished.catch(()=>{}).finally(()=>{if(this.boardTransition===transition)this.boardTransition=null;});
        return;
      }catch{/* Fall back to the direct canvas transition when snapshots are unavailable. */}
    }
    apply();
    void this.updateComplete.then(()=>{if(this.selected!==id||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const viewport=this.querySelector<HTMLElement>('.dashboard-canvas-viewport');if(!viewport)return;const css=getComputedStyle(this),raw=css.getPropertyValue('--duration-normal').trim(),animation=viewport.animate([{opacity:.35,transform:'translateY(6px)'},{opacity:1,transform:'none'}],{duration:Math.max(120,(parseFloat(raw)||.2)*(raw.endsWith('ms')?1:1000)),easing:css.getPropertyValue('--ease-standard').trim()||'cubic-bezier(.2,.8,.2,1)'});this.boardTransition=animation;void animation.finished.catch(()=>{}).finally(()=>{if(this.boardTransition===animation)this.boardTransition=null;});});
  }
  private tabKey(event:KeyboardEvent,id:string){
    if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();this.openTabMenu(id,rect.left,rect.bottom);return;}
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const boards=this.boards.filter(board=>this.showArchived||!board.archived),index=boards.findIndex(board=>board.id===id);if(index<0||!boards.length)return;
    event.preventDefault();const next=event.key==='Home'?boards[0]:event.key==='End'?boards[boards.length-1]:boards[(index+(event.key==='ArrowRight'?1:-1)+boards.length)%boards.length];
    this.select(next.id);void this.updateComplete.then(()=>this.querySelector<HTMLButtonElement>(`[data-board-id="${next.id}"]`)?.focus());
  }
  private openDialog(kind:'create'|'rename'|'archive'|'delete',boardId=this.selected){const board=this.boards.find(board=>board.id===boardId);this.dialogBoardId=kind==='create'?'':boardId;this.titleDraft=kind==='create'?t('dashboard.untitled'):board?.title??'';this.descriptionDraft=kind==='create'?'':board?.description??'';this.templateDraft='';this.closeTabMenu(false);this.querySelector<HTMLDetailsElement>('.dashboard-menu')?.removeAttribute('open');this.dialog=kind;}
  private removeCard(card:DashboardCard){this.dialogBoardId=this.selected;this.dialogCardId=card.id;this.titleDraft=card.title;this.dialog='remove';}
  /**
   * 标签右键菜单锚在标签本身：先用 placePopover 选择落边（下方优先、放不下翻到上方），
   * 再在视口内夹取。指针坐标只决定「优先在标签下方还是上方」，菜单不会溢出窗口。
   */
  private openTabMenu(boardId:string,x:number,y:number){
    if(!this.boards.some(board=>board.id===boardId))return;
    const tab=this.querySelector<HTMLElement>(`[data-board-id="${boardId}"]`);
    this.menuFocus=tab;
    const width=220,height=96;
    const anchor=tab?tab.getBoundingClientRect():{left:x,top:y,width:0,height:0};
    // 指针在标签上方时优先向上展开（右键点上半部分），否则向下——保持菜单贴着指针那一侧。
    const preferTop=y<anchor.top+anchor.height/2;
    const placement=placePopover({
      anchor,
      panel:{width,height},
      viewport:{width:innerWidth,height:innerHeight},
      gap:4,
      padding:8,
      candidates:preferTop?[{side:'top',align:'start'},{side:'bottom',align:'start'}]:[{side:'bottom',align:'start'},{side:'top',align:'start'}],
      avoid:[anchor],
    });
    this.tabMenu={boardId,x:placement.left,y:placement.top};
    void this.updateComplete.then(()=>this.querySelector<HTMLButtonElement>('.dashboard-tab-menu button')?.focus());
  }
  private closeTabMenu(restore=true){if(!this.tabMenu)return;this.tabMenu=null;if(restore)this.menuFocus?.focus();}
  private dismissTabMenu=(event:PointerEvent)=>{if(this.tabMenu&&!(event.target as Element)?.closest('.dashboard-tab-menu'))this.closeTabMenu(false);};
  private menuKey(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.closeTabMenu();return;}if(event.key==='Tab'){this.closeTabMenu();return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...this.querySelectorAll<HTMLButtonElement>('.dashboard-tab-menu button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  private async submit(event:Event){
    event.preventDefault();if(this.saving||this.preparingArchive||!this.dialog)return;const kind=this.dialog,board=this.boards.find(board=>board.id===this.dialogBoardId),boardId=this.dialogBoardId;
    if(kind!=='create'&&!board)return;
    const result=await this.mutate(kind==='remove'?{action:'remove_card',boardId,cardId:this.dialogCardId}:kind==='archive'||kind==='delete'?{action:kind,boardId,...kind==='delete'?{confirmDelete:true}:{}}:{action:kind==='create'?(this.templateDraft==='showcase'?'create_example':this.templateDraft?'create_template':'create'):'rename',boardId,title:this.titleDraft.trim(),description:this.descriptionDraft.trim(),...this.templateDraft?{templateId:this.templateDraft}:{}});
    if(result){if(kind==='create')this.select(result.board.id);else if(kind==='remove'&&this.selection?.cardId===this.dialogCardId)this.selection=null;else if(kind==='delete'){try{await (window as unknown as {cryoclaw?:{closeDashboardBoard?:(id:string)=>Promise<unknown>}}).cryoclaw?.closeDashboardBoard?.(boardId);}catch{}if(this.selected===boardId){this.selected='';this.selection=null;this.editing=false;}}this.dialog='';}
  }
  private replaceCards(cards:DashboardCard[]){this.boards=this.boards.map(b=>b.id===this.selected?{...b,cards}:b);}
  private captureCardRects(){return new Map([...this.querySelectorAll<HTMLElement>('.dashboard-card')].map(element=>[element.dataset.cardId!,element.getBoundingClientRect()] as const));}
  private cancelLayoutMotion(){this.layoutEpoch++;for(const animation of this.layoutAnimations)animation.cancel();this.layoutAnimations=[];}
  private commitReorder(cards:DashboardCard[],before=this.captureCardRects()){
    this.cancelLayoutMotion();const epoch=this.layoutEpoch;this.replaceCards(cards);if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    void this.updateComplete.then(()=>{if(epoch!==this.layoutEpoch||this.retired)return;const css=getComputedStyle(this),raw=css.getPropertyValue('--duration-normal').trim(),options={duration:Math.max(140,(parseFloat(raw)||.2)*(raw.endsWith('ms')?1:1000)),easing:css.getPropertyValue('--ease-standard').trim()||'cubic-bezier(.2,.8,.2,1)'},animations:Animation[]=[];
      for(const [id,rect]of before){const element=[...this.querySelectorAll<HTMLElement>('.dashboard-card')].find(card=>card.dataset.cardId===id);if(!element)continue;const from=dashboardTransform(rect,element.getBoundingClientRect(),this.canvasScale);if(!from)continue;animations.push(element.animate([{transform:from,transformOrigin:'0 0'},{transform:'none',transformOrigin:'0 0'}],options));}
      this.layoutAnimations=animations;void Promise.all(animations.map(animation=>animation.finished.catch(()=>{}))).finally(()=>{if(epoch===this.layoutEpoch)this.layoutAnimations=[];});
    });
  }
  private saveLayout(){const board=this.board;if(!board||board.archived)return;this.pendingLayouts.set(board.id,{boardId:board.id,layouts:board.cards.map(c=>({cardId:c.id,...c.layout}))});void this.flushLayout();}
  private async flushLayout(){if(this.saving||!this.pendingLayouts.size||!this.connected)return;const pending=this.pendingLayouts.values().next().value!;this.pendingLayouts.delete(pending.boardId);await this.mutate({action:'layout',...pending});}
  private persistQueuedLayout(){const pending=[...this.pendingLayouts.values()],client=this.client;if(!pending.length||!client||!this.connected)return;this.pendingLayouts.clear();void Promise.resolve(this.mutationRequest).catch(()=>{}).then(async()=>{for(const layout of pending)try{await client.request('cryoclaw.dashboards.mutate',{action:'layout',...layout,requestId:crypto.randomUUID()});}catch{this.onError?.(t('dashboard.saveFailed'));}});}
  private start(event:PointerEvent,card:DashboardCard,kind:'drag'|'resize'){
    if(event.button!==0||!this.connected||this.expanded||this.board?.archived)return;event.preventDefault();this.layoutUndo=null;this.cancelLayoutMotion();const canvas=this.querySelector<HTMLElement>('.dashboard-canvas'),element=(event.currentTarget as HTMLElement).closest<HTMLElement>('.dashboard-card'),gap=canvas?parseFloat(getComputedStyle(canvas).columnGap)||20:20,visibleWidth=kind==='resize'&&canvas&&element?(element.getBoundingClientRect().width+gap)/(canvas.getBoundingClientRect().width+gap)*12:card.layout.w;this.gesture={kind,id:card.id,pointerId:event.pointerId,x:event.clientX,y:event.clientY,dx:0,dy:0,w:dashboardSize(visibleWidth,2,12),h:card.layout.h,target:card.id,before:this.board?.cards??[]};
    this.dragTargets=kind==='drag'?[...this.querySelectorAll<HTMLElement>('.dashboard-card')].filter(el=>el.dataset.cardId!==card.id).map(element=>{const rect=element.getBoundingClientRect();return{id:element.dataset.cardId!,element,x:rect.left+rect.width/2,y:rect.top+rect.height/2};}):[];
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  private move=(event:PointerEvent)=>{if(!this.gesture||event.pointerId!==this.gesture.pointerId)return;event.preventDefault();this.latestMove=event;if(!this.moveFrame)this.moveFrame=requestAnimationFrame(()=>{this.moveFrame=0;this.flushMove();});};
  private flushMove=()=>{const event=this.latestMove;this.latestMove=null;const g=this.gesture;if(!event||!g||event.pointerId!==g.pointerId)return;const dx=event.clientX-g.x,dy=event.clientY-g.y;
    if(g.kind==='resize'){if(Math.abs(dx)+Math.abs(dy)<.5)return;const canvas=this.querySelector<HTMLElement>('.dashboard-canvas'),width=canvas?.getBoundingClientRect().width??1200,gap=canvas?parseFloat(getComputedStyle(canvas).columnGap)||20:20;this.replaceCards((this.board?.cards??[]).map(c=>c.id===g.id?{...c,layout:{...c.layout,free:true,w:dashboardSize(g.w+dx/((width+gap)/12),2,12),h:bound(g.h+dy/this.canvasScale,180,1000)}}:c));return;}
    let nearest=g.target,distance=Infinity;for(const target of this.dragTargets){const d=Math.hypot(event.clientX-target.x,event.clientY-target.y);if(d<distance){distance=d;nearest=target.id;}}
    const target=Math.hypot(dx,dy)>12?nearest:g.id;
    // Do not replace this reactive gesture per pointer frame; finish/cancel owns the commit.
    g.dx=dx;g.dy=dy;g.target=target;
    const active=this.querySelector<HTMLElement>(`[data-card-id="${g.id}"]`);if(active)active.style.transform=`translate(${dx/this.canvasScale}px,${dy/this.canvasScale}px)`;
    for(const candidate of this.dragTargets)candidate.element.classList.toggle('is-drop-target',candidate.id===target&&target!==g.id);
  };
  private finish=(event:PointerEvent)=>{if(!this.gesture||event.pointerId!==this.gesture.pointerId)return;this.latestMove=event;if(this.moveFrame)cancelAnimationFrame(this.moveFrame);this.moveFrame=0;this.flushMove();const g=this.gesture!;this.suppressSelectionUntil=Date.now()+200;if(g.kind==='drag'&&g.id!==g.target)this.commitReorder(reorderDashboardCards(this.board?.cards??[],g.id,g.target));this.gesture=null;this.dragTargets=[];this.saveLayout();};
  private cancel=()=>{if(this.moveFrame)cancelAnimationFrame(this.moveFrame);this.moveFrame=0;this.latestMove=null;if(this.gesture){this.replaceCards(this.gesture.before);this.gesture=null;}this.dragTargets=[];};
  private key=(event:KeyboardEvent)=>{if(event.key!=='Escape'||this.taskCard||this.dialog||this.libraryOpen)return;if(this.tabMenu){this.closeTabMenu();event.preventDefault();}else if(this.gesture){this.cancel();event.preventDefault();}else if(this.expanded){this.collapse();event.preventDefault();}else if(this.selection){this.selection=null;event.preventDefault();}else if(this.editing){this.toggleEditor();event.preventDefault();}else if(this.focusMode){this.focusMode=false;event.preventDefault();}};
  private cardKey(event:KeyboardEvent,card:DashboardCard,resize=false){
    if(this.board?.archived)return;
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const direction=['ArrowLeft','ArrowUp'].includes(event.key)?-1:1;
    if(resize){this.layoutUndo=null;const canvas=this.querySelector<HTMLElement>('.dashboard-canvas'),width=canvas?.clientWidth??1200,gap=canvas?parseFloat(getComputedStyle(canvas).columnGap)||20:20,step=event.shiftKey?50:10;this.replaceCards((this.board?.cards??[]).map(c=>c.id===card.id?{...c,layout:{...c.layout,free:true,...['ArrowLeft','ArrowRight'].includes(event.key)?{w:dashboardSize(c.layout.w+direction*step/((width+gap)/12),2,12)}:{h:bound(c.layout.h+direction*step,180,1000)}}}:c));}
    else{const cards=this.board?.cards??[],index=cards.findIndex(c=>c.id===card.id),other=cards[index+direction];if(other)this.commitReorder(reorderDashboardCards(cards,card.id,other.id));}this.saveLayout();
  }
  private expand(id:string){if(!this.expanded&&!this.morphing){this.previousFocus=document.activeElement as HTMLElement;const card=[...this.querySelectorAll<HTMLElement>('.dashboard-card')].find(element=>element.dataset.cardId===id),scroll=this.querySelector<HTMLElement>('.dashboard-workspace__scroll');this.morphOrigin=card&&scroll?{id,rect:card.getBoundingClientRect(),scrollTop:scroll.scrollTop}:null;}void this.morphCard(id);}
  private collapse(){void this.morphCard('');}
  private closeExpandedLayer(){for(const card of this.querySelectorAll<HTMLElement>('.dashboard-card[popover]')){if(card.matches(':popover-open'))card.hidePopover();card.removeAttribute('popover');}}
  private async morphCard(next:string){
    this.cancelBoardTransition();this.cancelLayoutMotion();
    const id=next||this.expanded||this.morphingCard;if(!id)return;
    const find=()=>[...this.querySelectorAll<HTMLElement>('.dashboard-card')].find(card=>card.dataset.cardId===id);
    const before=find()?.getBoundingClientRect(),backdrop=this.querySelector('.dashboard-expanded-backdrop');
    const opacity=backdrop?Number.parseFloat(getComputedStyle(backdrop).opacity):0;
    const epoch=++this.morphEpoch;for(const animation of this.morphAnimations)animation.cancel();this.morphAnimations=[];
    // Keep the live surface in the top layer for the entire return journey.
    // Removing the popover before shrinking puts it underneath the blurred shade.
    if(next)for(const card of this.querySelectorAll<HTMLElement>('.dashboard-card[popover]'))if(card.dataset.cardId!==next){if(card.matches(':popover-open'))card.hidePopover();card.removeAttribute('popover');}
    if(!next&&before){
      const card=find(),origin=this.morphOrigin?.id===id?this.morphOrigin:null,destination=origin?.rect??card?.parentElement?.getBoundingClientRect();
      this.morphingCard=id;this.morphing=!matchMedia('(prefers-reduced-motion: reduce)').matches;
      try{
        if(this.morphing&&card&&destination&&typeof card.animate==='function'){
          const css=getComputedStyle(this),raw=css.getPropertyValue('--duration-normal').trim();
          const options={duration:Math.max(140,Math.min(400,(parseFloat(raw)||.28)*(raw.endsWith('ms')?1:1000))),easing:css.getPropertyValue('--ease-standard').trim()||'cubic-bezier(.2,.8,.2,1)',fill:'forwards' as FillMode};
          const animation=card.animate([{right:'auto',bottom:'auto',left:`${before.left}px`,top:`${before.top}px`,width:`${before.width}px`,height:`${before.height}px`,transform:'none'},{right:'auto',bottom:'auto',left:`${destination.left}px`,top:`${destination.top}px`,width:`${destination.width}px`,height:`${destination.height}px`,transform:'none'}],options);
          this.morphAnimations=[animation];
          const shade=this.querySelector<HTMLElement>('.dashboard-expanded-backdrop');if(shade)this.morphAnimations.push(shade.animate([{opacity},{opacity:0}],options));
          await animation.finished;
        }
      }catch{/* A new gesture continues from the currently displayed geometry. */}
      finally{if(epoch===this.morphEpoch){this.closeExpandedLayer();this.expanded='';this.morphing=false;this.morphingCard='';await this.updateComplete;for(const animation of this.morphAnimations)animation.cancel();this.morphAnimations=[];if(origin){const scroll=this.querySelector<HTMLElement>('.dashboard-workspace__scroll');if(scroll)scroll.scrollTo({top:origin.scrollTop,behavior:'instant'});}this.morphOrigin=null;this.previousFocus?.focus({preventScroll:true});}}
      return;
    }
    this.expanded=next;this.morphingCard=id;this.morphing=!matchMedia('(prefers-reduced-motion: reduce)').matches;
    await this.updateComplete;if(epoch!==this.morphEpoch||this.retired)return;
    try{
      const card=find();
      // The top layer escapes transformed/contained grid ancestors without reparenting the live iframe.
      if(next&&card){card.popover='manual';card.tabIndex=-1;card.setAttribute('autofocus','');card.showPopover();card.removeAttribute('autofocus');const frame=card.querySelector<HTMLIFrameElement>('iframe');if(frame)this.mountFrame(frame);this.querySelector<HTMLButtonElement>('[data-expanded="true"] [data-card-close]')?.focus({preventScroll:true});card.removeAttribute('tabindex');}
      const after=card?.getBoundingClientRect();
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
    finally{if(epoch===this.morphEpoch){this.morphing=false;this.morphingCard='';this.morphAnimations=[];}}
  }
  private trapFocus=(event:FocusEvent)=>{if(this.tabMenu&&!(event.target as Element).closest('.dashboard-tab-menu'))this.closeTabMenu(false);if(!this.expanded||this.taskCard||this.dialog)return;const card=this.querySelector('[data-expanded="true"]');if(card&&!card.contains(event.target as Node))this.querySelector<HTMLButtonElement>('[data-expanded="true"] [data-card-close]')?.focus({preventScroll:true});};
  private frameMessage=async(event:MessageEvent)=>{
    const frame=[...this.querySelectorAll<HTMLIFrameElement>('.dashboard-card iframe')].find(el=>el.contentWindow===event.source);if(!frame||event.data?.type!=='cryoclaw:dashboard')return;
    if(event.data.action==='selectElement'){if(this.editing&&!this.board?.archived){const card=this.board?.cards.find(card=>card.id===frame.dataset.cardId);if(card)this.selection=dashboardElementTarget(event.data.value,card.id,card.title);}return;}
    if(event.data.action==='clearSelection'){if(this.expanded===frame.dataset.cardId)this.collapse();else if(this.editing)this.selection=null;return;}
    if(event.data.action==='compose'&&navigator.userActivation?.isActive&&document.activeElement===frame&&typeof event.data.value==='string'&&event.data.value.trim()&&event.data.value.length<=2000){this.onAskModel?.(event.data.value);this.ask();return;}
    if(event.data.action==='tasks'&&navigator.userActivation?.isActive&&document.activeElement===frame){this.taskCard=frame.dataset.cardId!;return;}
    if(event.data.action==='collapse'){if(this.expanded===frame.dataset.cardId)this.collapse();return;}
    if(event.data.action==='wheel'&&!this.expanded&&event.data.value&&Number.isFinite(event.data.value.dy)){this.queueWheel(event.data.value.dy);return;}
    if(event.data.action==='expand'&&navigator.userActivation?.isActive)this.expand(frame.dataset.cardId!);
    if(event.data.action==='refresh'&&Date.now()-this.lastFrameRefresh>15000){this.lastFrameRefresh=Date.now();this.refreshCard(frame.dataset.cardId!);}
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
    return html`<div class="dashboard-system"><div class="dashboard-system__intro"><h2>${t('dashboard.runTitle')}</h2><p>${t('dashboard.runDescription')}</p><button class="dashboard-system__run" ?disabled=${this.measuring||!this.connected} @click=${()=>this.measure()}>${this.measuring?t('dashboard.measuring'):s?t('dashboard.measureAgain'):t('dashboard.measure')}</button></div>
      <div class="dashboard-system__report"><h3>${s?`${s.platform} · ${t('dashboard.measureDone')}`:t('dashboard.measureReady')}</h3><p class="dashboard-system__stamp">${s?`${new Date(s.sampledAt).toLocaleTimeString()} · ${(s.elapsedMs/1000).toFixed(1)}s · ${t('dashboard.measureCount').replace('{n}',String(this.sampleCount))}`:'—'}</p>
      ${[['CPU',percent,s?`${s.cpuCount} ${t('dashboard.cores')} · ${s.cpuPercent===null?'—':s.cpuPercent.toFixed(0)+'%'}`:'—'],[t('dashboard.disk'),disk,s?.diskFree!==null&&s?.diskFree!==undefined?`${t('dashboard.available')} ${(s.diskFree/1024**3).toFixed(0)} GB`:'—'],[t('dashboard.system'),100,s?.platform??'—']].map(([label,value,detail])=>html`<div class="dashboard-system__row"><strong>${label}</strong><span class="dashboard-system__track"><i style=${styleMap({width:`${value}%`})}></i></span><span>${detail}</span></div>`)}</div></div>`;
  }
  private refreshCard(cardId:string){const key=`${this.selected}/${cardId}`;this.cardRefresh.set(key,(this.cardRefresh.get(key)??0)+1);this.cardRefreshVersion++;void this.load(true);}
  private async pin(card:DashboardCard){try{if(!this.client)return;const result=await this.client.request<{frameUrl:string}>('cryoclaw.dashboards.pin',{boardId:this.selected,cardId:card.id}),url=dashboardFrameUrl(this.settings.gatewayUrl,result.frameUrl);if(!url)throw Error('Invalid card URL');const bridge=(window as unknown as {cryoclaw?:{pinDashboardCard?:(params:unknown)=>Promise<unknown>}}).cryoclaw;if(!bridge?.pinDashboardCard)throw Error('Desktop bridge unavailable');await bridge.pinDashboardCard({id:`${this.selected}/${card.id}`,title:card.title,url,width:this.querySelector(`[data-card-id="${card.id}"]`)?.getBoundingClientRect().width??500,height:card.layout.h});}catch{this.error=t('dashboard.pinFailed');}}
  private arrange(){if(this.board?.archived||!this.connected||this.gesture)return;const board=this.board;if(!board?.cards.length)return;this.layoutUndo={boardId:board.id,cards:board.cards};this.commitReorder(arrangeDashboardCards(board.cards));this.compact=false;this.saveLayout();}
  private undoArrange(){const undo=this.layoutUndo;if(!undo||undo.boardId!==this.selected)return;const layouts=new Map(undo.cards.map(card=>[card.id,card.layout]));this.layoutUndo=null;this.commitReorder((this.board?.cards??[]).map(card=>({...card,layout:layouts.get(card.id)??card.layout})).sort((a,b)=>a.layout.order-b.layout.order).map((card,order)=>({...card,layout:{...card.layout,order}})));this.saveLayout();}
  private selectCard(card:DashboardCard){if(this.editing&&!this.board?.archived&&Date.now()>this.suppressSelectionUntil)this.selection={cardId:card.id,cardTitle:card.title};}
  private inspectNative=(event:Event)=>{if(!this.editing||this.board?.archived)return;const element=event.target as Element,root=element.closest?.('.dashboard-card__content'),article=root?.closest<HTMLElement>('.dashboard-card');if(!root||!article||root.querySelector('iframe'))return;event.preventDefault();event.stopImmediatePropagation();if(event.type!=='click')return;const card=this.board?.cards.find(card=>card.id===article.dataset.cardId);if(card)this.selection=dashboardElementTarget({selector:dashboardNodeSelector(element,root),tagName:element.localName,text:element.textContent??''},card.id,card.title);};
  private ask(){this.editing=true;void this.showComposer(true);void this.updateComplete.then(()=>this.querySelector<HTMLTextAreaElement>('.chat-compose__field textarea')?.focus());}
  private toggleEditor(){const open=!this.editing;this.editing=open;if(!open)this.selection=null;void this.showComposer(open);}
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
  private async startOnboarding(){const result=await this.mutate({action:'create_template',templateId:'onboarding'});if(result)this.select(result.board.id);}
  private card(card:DashboardCard){const g=this.gesture,expanded=this.expanded===card.id,url=dashboardFrameUrl(this.settings.gatewayUrl,card.frameUrl),frameKey=`${this.selected}/${card.id}`,frameReady=this.frameReady.has(frameKey);
    if(this.board?.archived)return html`<div class="dashboard-card-slot" data-free=${String(Boolean(card.layout.free))} style=${styleMap({'--card-columns':String(card.layout.w),'--card-min-columns':String(card.layout.free?card.layout.w:card.layout.w>6?12:6),height:`${Math.min(card.layout.h,240)}px`})}><article class="dashboard-card dashboard-card--archived"><span>${icons.layout}</span><h2>${card.title}</h2><p>${t('dashboard.archivedModule')}</p></article></div>`;
    return html`<div class="dashboard-card-slot" data-free=${String(Boolean(card.layout.free))} style=${styleMap({'--card-columns':String(card.layout.w),'--card-min-columns':String(card.layout.free?card.layout.w:card.layout.w>6?12:6),height:`${card.layout.h}px`})}><article class="dashboard-card dashboard-card--${card.accent} ${this.selection?.cardId===card.id?'is-selected':''} ${g?.id===card.id?'is-dragging':''} ${g?.target===card.id&&g.id!==card.id?'is-drop-target':''}" data-card-id=${card.id} data-expanded=${String(expanded)} role=${expanded?'dialog':'group'} aria-modal=${expanded?'true':nothing} aria-label=${card.title} @click=${(event:MouseEvent)=>{if(!(event.target as Element).closest('button'))this.selectCard(card);}}
      style=${styleMap({height:expanded?undefined:'100%',transform:g?.kind==='drag'&&g.id===card.id?`translate(${g.dx/this.canvasScale}px,${g.dy/this.canvasScale}px)`:undefined})}>
      <header class="dashboard-card__chrome"><span class="dashboard-card__title">${card.title}</span><button class="dashboard-card__drag" aria-label=${`${t('dashboard.drag')} ${card.title}`} title=${t('dashboard.dragHint')} @pointerdown=${(e:PointerEvent)=>this.start(e,card,'drag')} @keydown=${(e:KeyboardEvent)=>this.cardKey(e,card)}><span></span></button>
        <div class="dashboard-card__actions"><button title=${t('dashboard.pin')} aria-label=${t('dashboard.pin')} ?disabled=${!!this.board?.archived} @click=${()=>this.pin(card)}>${icons.pin}</button>${card.kind!=='system'?html`<button class="dashboard-card__refresh" title=${t('chat.board.refresh')} aria-label=${`${t('chat.board.refresh')} ${card.title}`} @click=${()=>this.refreshCard(card.id)}>${icons.rotateCcw}</button>`:nothing}<button class="dashboard-card__tasks" title=${t('dashboard.cardTasks')} aria-label=${t('dashboard.cardTasks')} ?disabled=${!!this.board?.archived} @click=${()=>{this.taskCard=card.id;}}>${icons.clock}${card.taskLinks?.length?html`<small>${card.taskLinks.length}</small>`:nothing}</button><button title=${expanded?t('chat.board.restore'):t('chat.board.expand')} aria-label=${expanded?t('chat.board.restore'):t('chat.board.expand')} data-card-close @click=${()=>expanded?this.collapse():this.expand(card.id)}>${expanded?icons.x:icons.focus}</button>${this.editing?html`<button class="dashboard-card__select" title=${t('dashboard.selectCard')} aria-label=${t('dashboard.selectCard')} aria-pressed=${String(this.selection?.cardId===card.id&&!this.selection?.selector)} @click=${()=>this.selectCard(card)}>${icons.edit}</button><button title=${t('dashboard.removeCard')} aria-label=${t('dashboard.removeCard')} ?disabled=${this.saving} @click=${()=>this.removeCard(card)}>${icons.trash}</button>`:nothing}</div></header>
      <div class="dashboard-card__content"><div class="dashboard-card__surface" data-frame-pending=${String(Boolean(url)&&card.kind!=='system'&&!frameReady)}>${card.kind==='system'?this.system():url?html`<iframe loading="lazy" data-card-id=${card.id} src=${frameReady?`${url}&refresh=${this.refreshNonce}-${this.cardRefresh.get(frameKey)??0}`:nothing} title=${card.title} sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" allow="autoplay" @load=${(e:Event)=>this.postFrameVisibility(e.target as HTMLIFrameElement)}></iframe>`:nothing}</div></div>
      ${!expanded?html`<button class="dashboard-card__resize" aria-label=${`${t('dashboard.resize')} ${card.title}`} title=${t('dashboard.resizeHint')} @pointerdown=${(e:PointerEvent)=>this.start(e,card,'resize')} @keydown=${(e:KeyboardEvent)=>this.cardKey(e,card,true)}><span></span></button>`:nothing}</article></div>`;
  }
  private choosePreset(value:string){const previous=this.templateDraft;this.templateDraft=value;if(this.titleDraft===t('dashboard.untitled')||previous&&this.titleDraft===t(`dashboard.preset.${previous}`))this.titleDraft=value?t(`dashboard.preset.${value}`):t('dashboard.untitled');if(!this.descriptionDraft||previous&&this.descriptionDraft===t(`dashboard.preset.${previous}Description`))this.descriptionDraft=value?t(`dashboard.preset.${value}Description`):'';}
  render(){const board=this.board,visible=this.boards.filter(b=>this.showArchived||!b.archived),destructive=this.dialog==='archive'||this.dialog==='delete'||this.dialog==='remove';
    return html`<section data-page-id="dashboard" data-load-state=${this.pending||this.loading?'loading':this.error?'error':!this.boards.length?'empty':'ready'} aria-busy=${this.pending||this.loading} class="dashboard-workspace ${this.compact?'is-compact':''} ${this.editing?'is-editing':''} ${board&&!board.archived&&this.composeProps&&(this.composerOpen||this.composerLeaving)?'has-composer':''} ${this.morphing?'is-morphing':''} ${this.focusMode?'is-focused':''} ${this.gesture?'is-gesturing':''}">
      <nav class="dashboard-tabs" aria-label=${t('dashboard.boards')}><div class="dashboard-tabs__list" role="tablist">${visible.map(b=>html`<button role="tab" aria-selected=${String(b.id===this.selected)} aria-controls="dashboard-panel" aria-haspopup="menu" tabindex=${b.id===this.selected?0:-1} data-board-id=${b.id} class=${b.id===this.selected?'is-active':''} @click=${()=>this.select(b.id)} @contextmenu=${(event:MouseEvent)=>{event.preventDefault();this.openTabMenu(b.id,event.clientX,event.clientY);}} @keydown=${(event:KeyboardEvent)=>this.tabKey(event,b.id)}><span>${b.title}</span>${b.archived?html`<small>${t('dashboard.archived')}</small>`:nothing}</button>`)}</div><button class="dashboard-tabs__add" aria-label=${t('dashboard.create')} title=${t('dashboard.create')} ?disabled=${!this.connected||this.saving} @click=${()=>this.openDialog('create')}>${icons.plus}</button></nav>
      ${this.tabMenu?html`<div class="dashboard-tab-menu" role="menu" aria-label=${t('dashboard.more')} style=${styleMap({left:`${this.tabMenu.x}px`,top:`${this.tabMenu.y}px`})} @keydown=${this.menuKey} @contextmenu=${(event:Event)=>event.preventDefault()}><button role="menuitem" ?disabled=${!this.connected||this.saving} @click=${()=>this.openDialog('rename',this.tabMenu!.boardId)}>${icons.edit}${t('dashboard.details')}</button><button role="menuitem" class="is-danger" ?disabled=${!this.connected||this.saving} @click=${()=>this.openDialog('delete',this.tabMenu!.boardId)}>${icons.trash}${t('dashboard.deleteBoard')}</button></div>`:nothing}
      ${this.error?html`<div class="dashboard-notice" role="status">${this.error}<button @click=${()=>void this.load(true)}>${t('chat.board.refresh')}</button></div>`:nothing}
      ${this.editing?html`<div class="dashboard-edit-hint" role="status"><span>${this.selection?`${t('dashboard.selectionTarget')} · ${this.selection.cardTitle}${this.selection.selector?` / ${this.selection.tagName}`:` / ${t('dashboard.wholeCard')}`}`:t('dashboard.editHint')}</span>${this.selection?html`<button @click=${()=>{this.selection=null;}}>${t('dashboard.clearSelection')}</button>`:nothing}</div>`:board?.archived?html`<div class="dashboard-edit-hint">${t('dashboard.readOnlyHint')}</div>`:nothing}
      <div class="dashboard-workspace__scroll" id="dashboard-panel" role="tabpanel" aria-label=${board?.title??t('dashboard.boards')}>${board?.cards.length?html`<div class="dashboard-canvas-viewport"><div class="dashboard-canvas" aria-busy=${this.loading}>${guard([board.id,board.cards,this.expanded,this.gesture,this.canvasScale,this.refreshNonce,this.cardRefreshVersion,this.frameMountVersion,this.editing,this.selection,this.sample,this.measuring],()=>repeat(board.cards,c=>`${board.id}/${c.id}`,c=>guard([c,this.expanded===c.id,(this.gesture?.id===c.id||this.gesture?.target===c.id)?this.gesture:null,this.canvasScale,this.refreshNonce,this.cardRefresh.get(`${this.selected}/${c.id}`)??0,this.frameReady.has(`${this.selected}/${c.id}`),this.editing,this.selection?.cardId===c.id?this.selection:null,c.kind==='system'?this.sample:null,c.kind==='system'?this.measuring:null],()=>this.card(c))))}</div></div>`:html`<div class="dashboard-empty"><span>${icons.layout}</span><h1>${this.loading?t('dashboard.loading'):t('dashboard.emptyBoard')}</h1><p>${t('dashboard.emptySteps')}</p><button class="dashboard-empty__start" ?disabled=${!this.connected||this.saving||!board||board.archived} @click=${()=>void this.startOnboarding()}>${t('dashboard.emptyStart')}</button><span class="dashboard-empty__start-hint">${t('dashboard.emptyStartHint')}</span><div class="dashboard-empty__ideas">${['focus','briefing','projects'].map(key=>html`<button ?disabled=${!this.connected||!board||board.archived} @click=${()=>{this.onAskModel?.(t(`dashboard.idea.${key}`));this.ask();}}>${t(`dashboard.idea.${key}`)}</button>`)}</div></div>`}</div>
      ${board&&!board.archived&&this.composeProps&&(this.composerOpen||this.composerLeaving)?html`<aside class="dashboard-compose" aria-label=${t('dashboard.askModel')}>${renderDashboardCompose(this.composeProps,board.id,board.title,this.onOpenChat,{description:board.description,selection:this.selection,onClearSelection:()=>{this.selection=null;}})}</aside>`:nothing}
      ${board?html`<div class="dashboard-floatbar" role="toolbar" aria-label=${t('dashboard.tools')}><button class="dashboard-floatbar__edit" title=${t(this.editing?'dashboard.finishEditing':'dashboard.edit')} aria-label=${t(this.editing?'dashboard.finishEditing':'dashboard.edit')} aria-pressed=${String(this.editing)} ?disabled=${!this.connected||board.archived} @click=${()=>this.toggleEditor()}>${icons.edit}<span>${t(this.editing?'dashboard.finishEditing':'dashboard.edit')}</span></button><button title=${t('dashboard.arrange')} aria-label=${t('dashboard.arrange')} ?disabled=${!this.connected||board.archived} @click=${()=>this.arrange()}>${icons.layout}</button><button title=${t('chat.board.refresh')} aria-label=${t('chat.board.refresh')} @click=${()=>{this.refreshNonce++;void this.load(true);}}>${icons.rotateCcw}</button><button title=${t('dashboard.focus')} aria-label=${t('dashboard.focus')} aria-pressed=${String(this.focusMode)} @click=${()=>{this.focusMode=!this.focusMode;}}>${icons.focus}</button><details class="dashboard-menu"><summary aria-label=${t('dashboard.more')} title=${t('dashboard.more')}>${icons.moreHorizontal}</summary><div><button class="dashboard-menu__add" ?disabled=${!this.connected||this.saving||board.archived||board.cards.length>=24} @click=${()=>{this.querySelector<HTMLDetailsElement>('.dashboard-menu')?.removeAttribute('open');this.libraryOpen=true;}}>${icons.plus}${t('dashboard.addModule')}</button><button ?disabled=${!this.connected||this.saving} @click=${()=>this.openDialog('rename')}>${t('dashboard.details')}</button><button @click=${()=>{this.compact=!this.compact;}}>${t('dashboard.compact')}</button><button @click=${()=>{this.showArchived=!this.showArchived;}}>${t('dashboard.showArchived')}</button>${!board.archived?html`<button ?disabled=${!this.connected||this.saving} @click=${()=>this.openDialog('archive')}>${t('dashboard.archive')}</button>`:nothing}</div></details>${this.layoutUndo?html`<button class="dashboard-floatbar__undo" title=${t('dashboard.arrangedHint')} @click=${()=>this.undoArrange()}>${t('dashboard.undoArrange')}</button>`:nothing}${this.saving?html`<span class="dashboard-save-state" role="status">${t('dashboard.saving')}</span>`:nothing}</div>`:nothing}
      ${this.expanded||this.morphing?html`<div class="dashboard-expanded-backdrop" @click=${()=>this.collapse()}></div>`:nothing}
      ${this.taskCard?html`<oc-dashboard-tasks .client=${this.client} .boardId=${this.selected} .card=${board?.cards.find(c=>c.id===this.taskCard)??null} .onClose=${()=>{this.taskCard='';}} .onChanged=${()=>void this.load(true)} .onManage=${()=>{this.taskCard='';this.onOpenTasks?.();}}></oc-dashboard-tasks>`:nothing}
      ${this.libraryOpen&&board?html`<oc-dashboard-library .client=${this.client} .gatewayUrl=${this.settings?.gatewayUrl??''} .onClose=${()=>{this.libraryOpen=false;}} .onAdd=${async(templateId:string)=>{const boardId=board.id;return Boolean(await this.mutate({action:'add_template',boardId,templateId}));}}></oc-dashboard-library>`:nothing}
      <dialog class="dashboard-dialog" aria-labelledby="dashboard-dialog-title" @cancel=${(event:Event)=>{if(this.saving||this.preparingArchive)event.preventDefault();else this.dialog='';}} @close=${()=>{this.dialog='';}}><form @submit=${this.submit}>
        <h2 id="dashboard-dialog-title">${t(this.dialog==='create'?'dashboard.create':this.dialog==='archive'?'dashboard.archive':this.dialog==='delete'?'dashboard.delete':this.dialog==='remove'?'dashboard.removeCard':'dashboard.details')}</h2>
        ${destructive?html`<strong class="dashboard-dialog__target">${this.titleDraft}</strong><p>${t(this.dialog==='remove'?'dashboard.removeCardHint':this.dialog==='delete'?'dashboard.deleteHint':'dashboard.archiveHint')}</p>`:html`
          ${this.dialog==='create'?html`<label>${t('dashboard.startFrom')}<select .value=${this.templateDraft} @change=${(event:Event)=>this.choosePreset((event.target as HTMLSelectElement).value)}><option value="">${t('dashboard.blankBoard')}</option>${['onboarding','productivity','briefing','creative','showcase'].map(id=>html`<option value=${id}>${t(`dashboard.preset.${id}`)}</option>`)}</select></label>`:nothing}
          <label>${t('dashboard.name')}<input maxlength="80" required .value=${this.titleDraft} @input=${(e:Event)=>{this.titleDraft=(e.target as HTMLInputElement).value;}}></label>
          <label>${t('dashboard.boardDescription')}<textarea maxlength="240" rows="4" .value=${this.descriptionDraft} placeholder=${t('dashboard.descriptionPlaceholder')} @input=${(event:Event)=>{this.descriptionDraft=(event.target as HTMLTextAreaElement).value;}}></textarea></label><p class="dashboard-dialog__hint">${t('dashboard.descriptionHint')}<span>${this.descriptionDraft.length}/240</span></p>`}
        <footer><button type="button" class="btn" ?disabled=${this.saving||this.preparingArchive} @click=${()=>{this.dialog='';}}>${t('settings.cancel')}</button><button type="submit" class="btn ${this.dialog==='delete'||this.dialog==='remove'?'danger':'btn--primary'}" ?disabled=${!this.connected||this.saving||this.preparingArchive||!destructive&&!this.titleDraft.trim()}>${this.saving||this.preparingArchive?t('dashboard.saving'):this.dialog==='delete'?t('dashboard.deleteBoard'):this.dialog==='remove'?t('dashboard.removeCard'):this.dialog==='archive'?t('dashboard.archive'):t('dashboard.saveDetails')}</button></footer>
      </form></dialog>
    </section>`;
  }
}
