import {icons} from "./icons.ts";
import {html,nothing} from "lit";
import {applyAppearance,exportAppearance,readAppearancePackage,normalizeAppearance,getAppliedAppearance,COMPONENT_SELECTORS,type AppearanceProfile} from "./appearance-profile.ts";
import type {AppViewState} from "./app-view-state.ts";
import {getLocale} from "./i18n.ts";
import "./components/range-control.ts";
import {scheduleAppearancePreview,cancelAppearancePreview} from "./appearance-preview-scheduler.ts";
import {saveGeneratedTheme} from "./theme-library.ts";
import {showToast} from "./app-toast.ts";
import {runExitAnimation} from "./utils/exit-anim.ts";

type Preview={name:string;description?:string;editorVisible:boolean;source:"manual"|"agent"|"imported";profile:AppearanceProfile;original:AppearanceProfile;savedKey:string;picking:boolean;target:string|null;timer:ReturnType<typeof setTimeout>|null;tab:"layout"|"style"|"text";history:AppearanceProfile[];future:AppearanceProfile[];baseline:AppearanceProfile|null;geometry:{width:number;height:number};previousFocus:HTMLElement|null;leaving:boolean};
const copy=(profile:AppearanceProfile)=>normalizeAppearance(JSON.parse(JSON.stringify(profile)));
function beginChange(preview:Preview){preview.baseline??=copy(preview.profile);}
function commitChange(preview:Preview){if(preview.baseline && JSON.stringify(preview.baseline)!==JSON.stringify(preview.profile)){preview.history.push(preview.baseline);if(preview.history.length>30)preview.history.shift();preview.future=[];}preview.baseline=null;}
const previews=new WeakMap<AppViewState,Preview>();
const detachments=new WeakMap<AppViewState,()=>void>();
/** 用户开始手动调整后，不再用 Agent 预览的 60s 自动恢复丢弃这些编辑。 */
function pauseAutoRestore(preview:Preview):void{if(preview.timer){clearTimeout(preview.timer);preview.timer=null;}}
export function hasThemePreview(host:AppViewState):boolean{return !!previews.get(host) && !previews.get(host)?.leaving;}
export function updateActiveThemePreview(host:AppViewState,profile:AppearanceProfile,preserveComponents=true):boolean {
  const preview=previews.get(host);if(!preview || preview.leaving)return false;
  preview.profile=normalizeAppearance({...profile,...(preserveComponents?{components:preview.profile.components}:{})});applyAppearance(preview.profile);pauseAutoRestore(preview);return true;
}
const text=(cn:string,en:string)=>getLocale().startsWith("zh")?cn:en;
function selectedNode(id:string|null):HTMLElement|undefined{return id?Array.from(document.querySelectorAll<HTMLElement>("[data-theme-node]")).find(node=>node.dataset.themeNode===id):undefined;}
export function endThemePreview(host:AppViewState,save=false,animate=true):void {
  const preview=previews.get(host);if(!preview)return;
  if(preview.leaving){if(!animate){previews.delete(host);host.requestUpdate();}return;}
  cancelAppearancePreview(host);
  if(preview.timer)clearTimeout(preview.timer);
  if(save){
    host.applySettings({...host.settings,theme:preview.profile.mode??host.settings.theme,appearance:normalizeAppearance(preview.profile)});
    if(preview.source==="agent")try{saveGeneratedTheme(preview.name,preview.profile,preview.description??"");showToast(host,text("主题已应用并加入主题库", "Theme applied and added to your library"));}
    catch{showToast(host,text("主题已应用；主题库暂未保存，可在外观设置导出备份。", "Theme applied. The library could not be saved; export a copy in Appearance settings."));}
  }
  else applyAppearance(preview.savedKey===JSON.stringify({appearance:host.settings.appearance,theme:host.settings.theme})?preview.original:{...normalizeAppearance(host.settings.appearance),mode:host.settings.theme});
  document.querySelectorAll("[data-theme-selected]").forEach(node=>node.removeAttribute("data-theme-selected"));
  const finish=()=>{if(previews.get(host)===preview){previews.delete(host);host.requestUpdate();const focus=preview.previousFocus;if(focus?.isConnected)requestAnimationFrame(()=>focus.focus());}};
  preview.leaving=true;host.requestUpdate();
  if(animate)runExitAnimation([document.querySelector(".theme-editor"),document.querySelector(".theme-preview-banner")],finish);else finish();
}
export function startThemeEditor(host:AppViewState,profile:unknown=host.settings.appearance,name=text("可视化主题编辑", "Visual theme editor"),expires=true,editorVisible=true,source:Preview["source"]="manual",description=""):void {
  endThemePreview(host,false,false);
  document.querySelectorAll(".theme-editor.cc-leaving,.theme-preview-banner.cc-leaving").forEach(element=>element.classList.remove("cc-leaving"));
  const current=getAppliedAppearance();
  const original={...current,mode:current.mode??host.settings.theme};
  const preview:Preview={name,description:description||undefined,editorVisible,source,profile:normalizeAppearance(profile),original,savedKey:JSON.stringify({appearance:host.settings.appearance,theme:host.settings.theme}),picking:false,target:null,timer:null,tab:"layout",history:[],future:[],baseline:null,geometry:{width:200,height:40},previousFocus:document.activeElement instanceof HTMLElement?document.activeElement:null,leaving:false};
  if(expires)preview.timer=setTimeout(()=>endThemePreview(host),60000);
  previews.set(host,preview);applyAppearance(preview.profile);host.requestUpdate();
  requestAnimationFrame(()=>{if(previews.get(host)!==preview || preview.leaving)return;const panel=document.querySelector<HTMLElement>(preview.editorVisible?".theme-editor":".theme-preview-banner");if(panel?.isConnected)panel.focus();});
}
export function previewImportedTheme(host:AppViewState,profile:AppearanceProfile,name:string,description=""):void {startThemeEditor(host,profile,name,true,false,"imported",description);}
export function attachThemeUi(host:AppViewState):void {
  detachThemeUi(host);
  const bridge=(window as any).cryoclaw;
  let picked:HTMLElement|null=null;
  let pickExpires=0;
  const blockPickedClick=(event:MouseEvent)=>{if(!previews.has(host) || Date.now()>pickExpires){picked=null;return;}if(picked && event.target instanceof Node && picked.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();picked=null;}};
  const unsubscribe=bridge?.onThemeRequest?.((request:{id:string;payload:any})=>{
    try {
      const payload=request.payload;
      if(payload.action==="preview") {
        const pkg=readAppearancePackage(JSON.stringify(payload.theme));
        startThemeEditor(host,pkg.appearance,pkg.name||"Agent theme preview",true,true,"agent",pkg.description);
      } else if(payload.action==="restore")endThemePreview(host);
      else if(payload.action!=="inspect")throw new Error("Unknown theme action");
      bridge.themeResult({id:request.id,value:{theme:JSON.parse(exportAppearance(hasThemePreview(host)?previews.get(host)!.profile:getAppliedAppearance(),previews.get(host)?.name??"Current theme",previews.get(host)?.description??"")),targets:Object.keys(COMPONENT_SELECTORS),elements:Array.from(document.querySelectorAll<HTMLElement>("[data-theme-node]")).map(element=>element.dataset.themeNode).slice(0,100),preview:hasThemePreview(host),expiresInSeconds:hasThemePreview(host) && previews.get(host)?.timer?60:0}});
    } catch(error){bridge.themeResult({id:request.id,error:error instanceof Error?error.message:String(error)});}
  });
  const pick=(event:PointerEvent)=>{
    const preview=previews.get(host);if(!preview?.picking || preview.leaving)return;
    const target=(event.target as HTMLElement)?.closest<HTMLElement>("[data-theme-node]");
    if(!target || target.closest(".theme-editor,.theme-preview-banner"))return;
    event.preventDefault();event.stopImmediatePropagation();
    picked=target;
    pickExpires=Date.now()+500;
    document.querySelectorAll("[data-theme-selected]").forEach(node=>node.removeAttribute("data-theme-selected"));
    preview.target=target.dataset.themeNode!;preview.picking=false;target.dataset.themeSelected="true";
    pauseAutoRestore(preview);
    const rect=target.getBoundingClientRect();preview.geometry={width:rect.width,height:rect.height};
    const radius=parseFloat(getComputedStyle(target).borderRadius)||12;
    (preview.profile.components??={})[preview.target]??={x:0,y:0,radius};host.requestUpdate();
  };
  const escape=(event:KeyboardEvent)=>{if(event.ctrlKey && event.altKey && !event.getModifierState("AltGraph") && event.code==="Digit0" && !event.repeat){endThemePreview(host);host.applySettings({...host.settings,appearance:normalizeAppearance(undefined),theme:"light"});return;}if(event.key==="Escape" && previews.has(host)){event.preventDefault();endThemePreview(host);}};
  document.addEventListener("pointerdown",pick,true);document.addEventListener("click",blockPickedClick,true);document.addEventListener("keydown",escape,true);
  detachments.set(host,()=>{unsubscribe?.();document.removeEventListener("pointerdown",pick,true);document.removeEventListener("click",blockPickedClick,true);document.removeEventListener("keydown",escape,true);endThemePreview(host,false,false);});
}
export function detachThemeUi(host:AppViewState):void {detachments.get(host)?.();detachments.delete(host);}

export function renderThemeUi(host:AppViewState){
  const preview=previews.get(host);if(!preview)return nothing;
  const part=preview.target?preview.profile.components?.[preview.target]:undefined;
  const update=(inFrame=false)=>{pauseAutoRestore(preview);const apply=()=>{applyAppearance(preview.profile);host.requestUpdate();};if(inFrame){cancelAppearancePreview(host);apply();}else scheduleAppearancePreview(host,apply);};
  const undo=(redo=false)=>{commitChange(preview);const from=redo?preview.future:preview.history,to=redo?preview.history:preview.future;const value=from.pop();if(!value)return;to.push(copy(preview.profile));preview.profile=value;update();};
  const drag=(event:PointerEvent,resize=false)=>{
    if(!part)return;event.preventDefault();beginChange(preview);const handle=event.currentTarget as HTMLElement;
    const start={x:event.clientX,y:event.clientY,dx:resize?part.width??preview.geometry.width:part.x,dy:resize?part.height??preview.geometry.height:part.y};handle.setPointerCapture(event.pointerId);
    const move=(moveEvent:PointerEvent)=>{const snap=moveEvent.shiftKey?8:moveEvent.altKey ? .1 : 1,scale=moveEvent.altKey ? .1 : 1;const x=Math.round((start.dx+(moveEvent.clientX-start.x)*scale)/snap)*snap,y=Math.round((start.dy+(moveEvent.clientY-start.y)*scale)/snap)*snap;if(resize){part.width=Math.max(24,Math.min(3200,x));part.height=Math.max(20,Math.min(1600,y));}else{part.x=Math.max(-600,Math.min(600,x));part.y=Math.max(-600,Math.min(600,y));}update();};
    const stop=()=>{commitChange(preview);update();handle.removeEventListener("pointermove",move);handle.removeEventListener("pointerup",stop);handle.removeEventListener("pointercancel",stop);};
    handle.addEventListener("pointermove",move);handle.addEventListener("pointerup",stop);handle.addEventListener("pointercancel",stop);
  };
  return html`<section class="theme-preview-banner" role="region" tabindex="-1" aria-label=${text("主题预览", "Theme preview")}><span><strong title=${preview.name}>${Array.from(preview.name).length>40?Array.from(preview.name).slice(0,40).join("")+"…":preview.name}</strong> · ${preview.timer?text("预览中；60 秒后自动恢复", "Preview; restores after 60 seconds"):text("预览中；按 Esc 撤销", "Preview; Escape reverts changes")}</span><button class="btn primary" @click=${()=>endThemePreview(host,true)}>${text("保留主题", "Keep theme")}</button><button class="btn" @click=${()=>endThemePreview(host)}>${text("撤销", "Revert")}</button></section>
  ${preview.editorVisible?html`<aside class="theme-editor" tabindex="-1" aria-label=${text("可视化主题编辑", "Visual theme editor")}><div class="theme-editor__heading"><span><small>${text("Theme Studio · 实时编辑", "Theme Studio · Live")}</small><h3>${text("让界面适合你", "Make the interface yours")}</h3></span><span class="theme-editor__history"><button class="btn btn--sm" ?disabled=${!preview.history.length} @click=${()=>undo()}>${text("撤销", "Undo")}</button><button class="btn btn--sm" ?disabled=${!preview.future.length} @click=${()=>undo(true)}>${text("重做", "Redo")}</button><button class="icon-btn theme-editor__close" aria-label=${text("关闭编辑器并撤销预览", "Close editor and revert preview")} title=${text("关闭并撤销预览（Esc）", "Close and revert (Escape)")} @click=${()=>endThemePreview(host)}>${icons.x}</button></span></div><details class="theme-editor__help"><summary>${text("操作与快捷键", "Controls and shortcuts")}</summary><p>${text("拖动移动，Shift 对齐 8px 网格，Alt 精调。方向键微调滑块，Shift 精细、Alt 加速；直接输入数值可精确定位。Esc 撤销预览，Ctrl+Alt+0 恢复默认外观。", "Drag to move; Shift snaps to an 8px grid, Alt adjusts finely. Arrow keys adjust sliders, Shift is finer, Alt faster. Enter exact values directly. Escape reverts; Ctrl+Alt+0 restores defaults.")}</p></details>
  <button class="btn" @click=${()=>{preview.picking=!preview.picking;host.requestUpdate();}}>${preview.picking?text("现在点击需要调整的元素…", "Click the element to adjust…"):text("选择界面元素", "Pick an element")}</button>
  ${part?html`<div class="theme-editor__selection"><strong>${selectedNode(preview.target)?.getAttribute("aria-label") || selectedNode(preview.target)?.getAttribute("placeholder") || selectedNode(preview.target)?.textContent?.trim().slice(0,40) || text("所选控件", "Selected control")}</strong><details><summary>${text("元素标识", "Element identifier")}</summary><code>${preview.target}</code></details></div><div class="theme-editor__handles"><button class="btn theme-editor__drag" @pointerdown=${(event:PointerEvent)=>drag(event)}>${icons.move}${text("拖动移动", "Move")}</button><button class="btn theme-editor__drag" @pointerdown=${(event:PointerEvent)=>drag(event,true)}>${icons.resize}${text("拖动缩放", "Resize")}</button></div>
    <div class="theme-editor__tabs">${(["layout","style","text"] as const).map(tab=>html`<button class="btn btn--sm" aria-pressed=${preview.tab===tab} @click=${()=>{preview.tab=tab;host.requestUpdate();}}>${tab==="layout"?text("布局", "Layout"):tab==="style"?text("外观", "Style"):text("文字", "Type")}</button>`)}</div>
    ${(
      preview.tab==="layout"?[{key:"x",label:text("水平位置", "Horizontal"),min:-600,max:600,value:part.x},{key:"y",label:text("垂直位置", "Vertical"),min:-600,max:600,value:part.y},{key:"width",label:text("宽度", "Width"),min:24,max:3200,value:part.width??preview.geometry.width},{key:"height",label:text("高度", "Height"),min:20,max:1600,value:part.height??preview.geometry.height},{key:"padding",label:text("内边距", "Padding"),min:0,max:96,value:part.padding??12},{key:"zIndex",label:text("层级", "Layer"),min:0,max:100,value:part.zIndex??0}]:
      preview.tab==="style"?[{key:"radius",label:text("圆角", "Corners"),min:0,max:96,value:part.radius},{key:"borderWidth",label:text("边框", "Border"),min:0,max:12,value:part.borderWidth??1},{key:"opacity",label:text("不透明度", "Opacity"),min:0,max:1,value:part.opacity??1},{key:"gap",label:text("内部间距", "Gap"),min:0,max:96,value:part.gap??0},{key:"margin",label:text("外边距", "Margin"),min:0,max:96,value:part.margin??0},...(preview.target?.includes('/icon/')?[{key:"strokeWidth",label:text("图标线宽", "Icon stroke"),min:0,max:6,value:part.strokeWidth??1.75},{key:"iconSize",label:text("图标尺寸", "Icon size"),min:8,max:96,value:part.iconSize??20}]:[])]:
      [{key:"fontSize",label:text("字号", "Font size"),min:10,max:72,value:part.fontSize??14},{key:"fontWeight",label:text("字重", "Weight"),min:100,max:900,value:part.fontWeight??400}]
    ).map(control=>html`<oc-range-control .label=${control.label} .min=${control.min} .max=${control.max} .value=${control.value} .precision=${control.key==="zIndex"?0:control.key==="opacity"?3:2} .fineStep=${control.key==="zIndex"?1:control.key==="opacity" ? .01 : .1} .unit=${["opacity","fontWeight","zIndex"].includes(control.key)?"":"px"} @value-change=${(event:CustomEvent)=>{beginChange(preview);(part as any)[control.key]=control.key==="zIndex"?Math.round(event.detail.value):event.detail.value;if(event.detail.commit)commitChange(preview);update(event.detail.frame);}}></oc-range-control>`)}
    ${preview.tab!=="layout"?html`<div class="theme-editor__colors">${(preview.tab==="text"?["color"] as const:["background","borderColor"] as const).map(key=>html`<label>${key==="background"?text("背景色", "Background"):key==="borderColor"?text("边框颜色", "Border"):text("文字颜色", "Text")}<input type="color" .value=${part[key]??"#808080"} @input=${(event:Event)=>{beginChange(preview);part[key]=(event.target as HTMLInputElement).value;update();}} @change=${()=>{commitChange(preview);update();}} /></label>`)}</div>`:nothing}
    ${preview.tab==="text"?html`<label>${text("字形", "Style")}<select class="oc-settings__select" .value=${part.fontStyle??""} @change=${(event:Event)=>{beginChange(preview);const value=(event.target as HTMLSelectElement).value;if(value==="normal" || value==="italic")part.fontStyle=value;else delete part.fontStyle;commitChange(preview);update();}}><option value="">${text("继承", "Inherit")}</option><option value="normal">${text("常规", "Normal")}</option><option value="italic">${text("斜体", "Italic")}</option></select></label><div class="theme-editor__tabs">${(["left","center","right"] as const).map(align=>html`<button class="btn btn--sm" aria-pressed=${part.textAlign===align} @click=${()=>{beginChange(preview);part.textAlign=align;commitChange(preview);update();}}>${align==="left"?text("左对齐", "Left"):align==="center"?text("居中", "Center"):text("右对齐", "Right")}</button>`)}</div>`:nothing}
    ${preview.tab==="style"?html`<label>${text("边框样式", "Border style")}<select class="oc-settings__select" .value=${part.borderStyle??'solid'} @change=${(event:Event)=>{beginChange(preview);part.borderStyle=(event.target as HTMLSelectElement).value as 'solid'|'dashed'|'none';commitChange(preview);update();}}><option value="solid">${text("实线", "Solid")}</option><option value="dashed">${text("虚线", "Dashed")}</option><option value="none">${text("无边框", "None")}</option></select></label>`:nothing}
    <div class="btn-row"><button class="btn" @click=${()=>{beginChange(preview);if(preview.target)delete preview.profile.components?.[preview.target];commitChange(preview);preview.target=null;update();}}>${text("重置此元素", "Reset element")}</button></div>`:html`<div class="theme-editor__empty">${text("从任意页面选择按钮、输入框、标题或面板，独立调整它们。", "Select buttons, inputs, headings or panels on any page to adjust them independently.")}</div>`}
  </aside>`:nothing}`;
}
