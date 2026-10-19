import {html,nothing,type TemplateResult} from "lit";
import type {AppViewState} from "../app-view-state.ts";
import {isTextFile,navigateWorkspaceUp,navigateWorkspaceHistory,openWorkspaceDirectory,loadWorkspaceDirectory,loadWorkspaceFile,workspaceViewState,workspaceRelativePath,persistWorkspacePreferences,setWorkspaceSearch,updateWorkspaceDraft,saveWorkspaceFile,discardWorkspaceDraft,closeWorkspaceFile,workspaceDirty} from "../controllers/workspace.ts";
import {t} from "../i18n.ts";
import {icons} from "../icons.ts";
import {tabListKeydown} from "../a11y.ts";
import {copyText} from "../chat/transcript-export.ts";
import "../components/oc-resizable-divider.ts";
import "../components/toggle-switch.ts";
export type WorkspaceViewOptions={gitSlot:TemplateResult;worktreesSlot:TemplateResult;onSelectGitNode:()=>void;onOpenFiles:()=>void;onRepoChange:(path:string)=>void;onRefreshFiles:()=>void;onOpenRootFolder:()=>void;onOpenItemFolder:(path:string)=>void;onChooseRoot:()=>void;onDefaultRoot:()=>void;onAttachFile:(path:string,name:string)=>void;onPinRoot:()=>void};
const ws=workspaceViewState;
function handleNavResize(event:Event){const ratio=(event as CustomEvent).detail?.splitRatio;if(typeof ratio!=="number" || !Number.isFinite(ratio))return;ws.navRatio=Math.max(.16,Math.min(.45,ratio));(event.currentTarget as HTMLElement).closest<HTMLElement>(".wk-layout")?.style.setProperty("--wk-nav-ratio",String(ws.navRatio));persistWorkspacePreferences();}
function renderBreadcrumb(state:AppViewState){
  if(!ws.root)return nothing;const path=ws.selectedFile??ws.currentPath??ws.root,relative=workspaceRelativePath(ws.root,path),segments=relative.split(/[/\\]/).filter(Boolean);
  return html`<nav class="wk-preview__breadcrumbs" aria-label=${t("workspace.browser.filePath")}><button @click=${()=>void loadWorkspaceDirectory(state,ws.root!)}>${ws.root.split(/[/\\]/).filter(Boolean).at(-1)??ws.root}</button>${segments.map((segment,index)=>{
    const last=index===segments.length-1;const target=ws.root!.replace(/[/\\]$/,"")+(ws.root!.includes("\\")?"\\":"/")+segments.slice(0,index+1).join(ws.root!.includes("\\")?"\\":"/");
    return html`<span aria-hidden="true">›</span>${last && ws.selectedFile?html`<strong>${segment}</strong>`:html`<button @click=${()=>void loadWorkspaceDirectory(state,target)}>${segment}</button>`}`;
  })}</nav>`;
}
function highlighted(content:string,query:string){
  if(!query)return content;const regex=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"giu");const parts:unknown[]=[];let end=0,count=0,match:RegExpExecArray|null;
  while((match=regex.exec(content)) && count++<300){parts.push(content.slice(end,match.index),html`<mark>${match[0]}</mark>`);end=match.index+match[0].length;}
  parts.push(content.slice(end));return parts;
}
let lastContent:string|null=null,lastLines=0;
function lineCount(content:string){if(content!==lastContent){lastContent=content;lastLines=1+(content.match(/\n/g)?.length??0);}return lastLines;}
export function renderWorkspaceView(state:AppViewState,opts:WorkspaceViewOptions){
  const isAtRoot=!ws.currentPath || !ws.root || ws.currentPath===ws.root;
  const canPreview=ws.selectedFileName?isTextFile(ws.selectedFileName):false;
  const items=ws.search.trim()?ws.searchResults:ws.items;
  const activeTab=Math.max(0,ws.recentFiles.findIndex(file=>file.path===ws.selectedFile));
  const locations=[...state.gitRepoOptions.map(repo=>({path:repo.path,name:repo.kind==="workspace"?t("git.repoWorkspace"):`${t("git.repoWorktree")} · ${repo.branch||repo.path}`})),...state.settings.pinnedWorkspaces.map(root=>({path:root.path,name:`${root.icon} ${root.name}`}))];
  if(ws.root && !locations.some(root=>root.path===ws.root))locations.unshift({path:ws.root,name:ws.root.split(/[/\\]/).at(-1)??ws.root});
  const copy=async(value:string)=>{try{const result=await copyText(value);ws.draftStatus=result?t("workspace.browser.copied"):t("workspace.browser.copyFailed");}catch{ws.draftStatus=t("workspace.browser.copyFailed");}state.requestUpdate();};
  return html`<div class="wk-layout" style=${`--wk-nav-ratio:${ws.navRatio}`} @keydown=${(event:KeyboardEvent)=>{
    if(event.isComposing || event.defaultPrevented)return;
    if((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==="s" && ws.mode==="files" && (ws.editing||workspaceDirty())){event.preventDefault();void saveWorkspaceFile(state);}
    if((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==="f" && ws.mode==="files"){event.preventDefault();document.querySelector<HTMLInputElement>(".wk-file-search")?.focus();}
  }}><aside class="wk-nav">
    <div class="wk-nav__location"><select class="wk-nav__repo" aria-label=${t("workspace.browser.rootLabel")} .value=${ws.root??""} ?disabled=${ws.fileSaving} @change=${(event:Event)=>{const value=(event.target as HTMLSelectElement).value;if(value==="__choose__")opts.onChooseRoot();else if(value==="__default__")opts.onDefaultRoot();else opts.onRepoChange(value);}}>
      ${locations.filter((root,index,array)=>array.findIndex(other=>other.path===root.path)===index).map(root=>html`<option value=${root.path}>${root.name}</option>`)}<option value="__default__">${t("workspace.browser.defaultRoot")}</option><option value="__choose__">${t("workspace.browser.chooseRoot")}</option></select></div>
    <div class="wk-nav__search"><input type="search" aria-label=${t("workspace.browser.searchLabel")} placeholder=${t("workspace.browser.searchPlaceholder")} .value=${ws.search} @input=${(event:Event)=>setWorkspaceSearch(state,(event.target as HTMLInputElement).value)} @keydown=${(event:KeyboardEvent)=>{if(event.key==="Escape")setWorkspaceSearch(state,"");}} /></div>
    <div class="wk-nav__node ${ws.mode==="files"?"active":""}">
      <button type="button" class="wk-nav__open" @click=${opts.onOpenFiles}>${icons.folder}<span>${t("workspace.files")}</span></button><span class="wk-nav__node-actions"><button class="icon-btn icon-btn--xs" aria-label=${t("workspace.refresh")} title=${t("workspace.refresh")} @click=${opts.onRefreshFiles}>${icons.refreshCw}</button><button class="icon-btn icon-btn--xs" aria-label=${t("workspace.openRoot")} title=${t("workspace.openRoot")} @click=${opts.onOpenRootFolder}>${icons.folderOpen}</button></span>
    </div>
    <div class="wk-nav__hidden"><oc-toggle-switch .checked=${ws.showHidden} .label=${t("workspace.browser.showHidden")} @change=${(event:CustomEvent)=>{ws.showHidden=!!event.detail.checked;persistWorkspacePreferences();if(ws.search)setWorkspaceSearch(state,ws.search);else if(ws.currentPath)void loadWorkspaceDirectory(state,ws.currentPath,true);}}></oc-toggle-switch></div>
    <div class="wk-nav__tree" aria-busy=${ws.loading||ws.searchLoading}>
      ${!isAtRoot && !ws.search?html`<button class="wk-nav__item wk-nav__item--back" @click=${()=>navigateWorkspaceUp(state)}>..</button>`:nothing}
      ${ws.loading || ws.searchLoading?html`<div class="wk-nav__hint" role="status">${t("workspace.loading")}</div>`:nothing}
      ${ws.error?html`<div class="wk-nav__hint" role="alert">${ws.error}</div>`:nothing}
      ${items.slice(0,ws.search?200:ws.visibleLimit).map(item=>html`<div class="wk-nav__file-row ${ws.selectedFile===item.path?"active":""}"><button class="wk-nav__item ${item.isDir?"wk-nav__item--dir":""}" title=${item.relativePath??item.name} ?disabled=${ws.fileSaving} @click=${()=>openWorkspaceDirectory(state,item)}><span class="wk-nav__item-icon">${item.isDir?icons.folder:icons.fileText}</span><span class="wk-nav__item-name">${item.name}${item.relativePath?html`<small>${item.relativePath}</small>`:nothing}</span></button><button class="icon-btn icon-btn--xs wk-nav__item-action" aria-label=${t("workspace.openFolder")} @click=${()=>opts.onOpenItemFolder(item.path)}>${icons.folderOpen}</button></div>`)}
      ${!ws.search && items.length>ws.visibleLimit?html`<button class="btn btn--sm" @click=${()=>{ws.visibleLimit+=200;state.requestUpdate();}}>${t("workspace.browser.showMore")} (${Math.min(ws.visibleLimit,items.length)}/${items.length})</button>`:nothing}
      ${!items.length && !ws.loading && !ws.searchLoading && !ws.error?html`<div class="wk-nav__hint">${ws.search?t("workspace.browser.noMatches"):t("workspace.browser.empty")}</div>`:nothing}
      ${(ws.search?ws.searchTruncated:ws.truncated)?html`<div class="wk-nav__hint">${t("workspace.browser.refineSearch")}</div>`:nothing}
    </div>
    <button class="wk-nav__node wk-nav__node--git ${ws.mode==="git"?"active":""}" @click=${opts.onSelectGitNode}>${icons.diff}<span>${t("git.title")}</span></button>
    <section class="wk-nav__section"><div class="wk-nav__section-title">${t("worktrees.title")}</div>${opts.worktreesSlot}</section>
  </aside><oc-resizable-divider .splitRatio=${ws.navRatio} .minRatio=${.16} .maxRatio=${.45} @resize=${handleNavResize}></oc-resizable-divider>
  <section class="wk-main">${ws.mode==="git"?opts.gitSlot:html`
    <div class="wk-browser-toolbar"><div class="wk-browser-history"><button class="btn btn--sm" aria-label=${t("workspace.browser.back")} ?disabled=${ws.historyIndex<=0} @click=${()=>navigateWorkspaceHistory(state,-1)}>${icons.arrowLeft}</button><button class="btn btn--sm" aria-label=${t("workspace.browser.forward")} ?disabled=${ws.historyIndex>=ws.history.length-1} @click=${()=>navigateWorkspaceHistory(state,1)}>${icons.arrowRight}</button></div>${renderBreadcrumb(state)}<button class="btn btn--sm" ?disabled=${!ws.root || state.settings.pinnedWorkspaces.some(root=>root.path===ws.root)} @click=${opts.onPinRoot}>${t("workspace.browser.pinRoot")}</button></div>
    ${ws.recentFiles.length?html`<nav class="wk-file-tabs" @keydown=${tabListKeydown} role="tablist" aria-label=${t("workspace.browser.openFiles")}>${ws.recentFiles.map((file,index)=>html`<div class="wk-file-tab ${file.path===ws.selectedFile?"active":""}"><button role="tab" tabindex=${index===activeTab?0:-1} id=${`workspace-tab-${index}`} aria-controls="workspace-preview-panel" aria-selected=${file.path===ws.selectedFile} ?disabled=${ws.fileSaving} @click=${()=>void loadWorkspaceFile(state,file.path,file.name)}>${file.name}${file.path===ws.selectedFile && workspaceDirty()?" •":""}</button><button aria-label=${t("workspace.browser.closeTab")} ?disabled=${ws.fileSaving} @click=${()=>closeWorkspaceFile(state,file.path)}>${icons.x}</button></div>`)}</nav>`:nothing}
    <div class="wk-preview" id="workspace-preview-panel" role="tabpanel" aria-labelledby=${ws.selectedFile?`workspace-tab-${activeTab}`:nothing}>${ws.selectedFile?html`
      <div class="wk-file-toolbar"><div class="wk-file-toolbar__actions"><button class="btn btn--sm" @click=${()=>opts.onAttachFile(ws.selectedFile!,ws.selectedFileName??"")}>${t("workspace.browser.useInChat")}</button><button class="btn btn--sm" @click=${()=>opts.onOpenItemFolder(ws.selectedFile!)}>${t("workspace.browser.showInFolder")}</button>
        ${ws.fileContent!==null?html`<button class="btn btn--sm" @click=${()=>void copy(ws.draft)}>${t("workspace.browser.copyContent")}</button><button class="btn btn--sm" aria-pressed=${ws.wrap} @click=${()=>{ws.wrap=!ws.wrap;state.requestUpdate();}}>${t("workspace.browser.wrap")}</button><button class="btn btn--sm" ?disabled=${!ws.fileHash||ws.fileSaving} @click=${()=>{ws.editing=!ws.editing;state.requestUpdate();}}>${ws.editing?t("workspace.browser.viewFile"):t("workspace.browser.editFile")}</button>${ws.editing || workspaceDirty()?html`<button class="btn btn--sm primary" ?disabled=${!workspaceDirty()||ws.fileSaving} @click=${()=>void saveWorkspaceFile(state)}>${ws.fileSaving?t("workspace.browser.saving"):t("workspace.browser.saveFile")}</button><button class="btn btn--sm" ?disabled=${ws.fileSaving} @click=${()=>void discardWorkspaceDraft(state)}>${t("workspace.browser.discardReload")}</button>`:nothing}`:nothing}
      </div>${canPreview?html`<input class="wk-file-search" type="search" placeholder=${t("workspace.browser.findHint")} aria-label=${t("workspace.browser.findLabel")} .value=${ws.fileQuery} @input=${(event:Event)=>{ws.fileQuery=(event.target as HTMLInputElement).value;state.requestUpdate();}} />`:nothing}</div>
      ${ws.fileError?html`<div class="wk-file-error" role="alert">${ws.fileError}</div>`:nothing}
      <div class="wk-preview__content">${ws.fileLoading?html`<div class="wk-preview__placeholder" role="status">${t("workspace.loading")}</div>`:ws.fileContent!==null?ws.editing?html`<textarea class="wk-editor" aria-label=${t("workspace.browser.editor")} spellcheck="false" wrap=${ws.wrap?"soft":"off"} ?disabled=${ws.fileSaving} .value=${ws.draft} @input=${(event:Event)=>updateWorkspaceDraft(state,(event.target as HTMLTextAreaElement).value)}></textarea>`:html`<pre class="wk-preview__text ${ws.wrap?"wk-preview__text--wrap":""}">${highlighted(ws.draft,ws.fileQuery)}</pre>`:ws.imagePreview?html`<div class="wk-image-preview"><img src=${ws.imagePreview} alt=${ws.selectedFileName??""} /></div>`:html`<div class="wk-preview__placeholder">${t("workspace.noPreview")}</div>`}</div>
      <footer class="wk-file-status"><span>${ws.fileContent!==null?`${lineCount(ws.draft)} ${t("workspace.browser.lines")} · ${(ws.fileSize/1024).toFixed(1)} KiB`:ws.selectedFileName}</span><span role="status">${ws.draftStatus}</span></footer>
    `:html`<div class="empty-state"><span class="empty-state__icon">${icons.fileText}</span><div class="empty-state__title">${t("workspace.selectFile")}</div><div class="empty-state__desc">${t("workspace.browser.emptyHint")}</div><button class="btn" @click=${opts.onChooseRoot}>${t("workspace.browser.openRoot")}</button></div>`}</div>
  `}</section></div>`;
}
