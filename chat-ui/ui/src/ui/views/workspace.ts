import {html,nothing,type TemplateResult} from "lit";
import type {AppViewState} from "../app-view-state.ts";
import {isTextFile,navigateWorkspaceUp,navigateWorkspaceHistory,openWorkspaceDirectory,loadWorkspaceDirectory,loadWorkspaceFile,workspaceViewState,workspaceRelativePath,persistWorkspacePreferences,setWorkspaceSearch,updateWorkspaceDraft,saveWorkspaceFile,discardWorkspaceDraft,closeWorkspaceFile,workspaceDirty} from "../controllers/workspace.ts";
import {t,getLocale} from "../i18n.ts";
import {icons} from "../icons.ts";
import {copyText} from "../chat/transcript-export.ts";
import "../components/oc-resizable-divider.ts";
import "../components/toggle-switch.ts";
export type WorkspaceViewOptions={gitSlot:TemplateResult;worktreesSlot:TemplateResult;onSelectGitNode:()=>void;onOpenFiles:()=>void;onRepoChange:(path:string)=>void;onRefreshFiles:()=>void;onOpenRootFolder:()=>void;onOpenItemFolder:(path:string)=>void;onChooseRoot:()=>void;onDefaultRoot:()=>void;onAttachFile:(path:string,name:string)=>void;onPinRoot:()=>void};
const text=(cn:string,en:string)=>getLocale().startsWith("zh")?cn:en;
const ws=workspaceViewState;
function handleNavResize(event:Event){const ratio=(event as CustomEvent).detail?.splitRatio;if(typeof ratio!=="number" || !Number.isFinite(ratio))return;ws.navRatio=Math.max(.16,Math.min(.45,ratio));(event.currentTarget as HTMLElement).closest<HTMLElement>(".wk-layout")?.style.setProperty("--wk-nav-ratio",String(ws.navRatio));persistWorkspacePreferences();}
function renderBreadcrumb(state:AppViewState){
  if(!ws.root)return nothing;const path=ws.selectedFile??ws.currentPath??ws.root,relative=workspaceRelativePath(ws.root,path),segments=relative.split(/[/\\]/).filter(Boolean);
  return html`<nav class="wk-preview__breadcrumbs" aria-label=${text("文件路径", "File path")}><button @click=${()=>void loadWorkspaceDirectory(state,ws.root!)}>${ws.root.split(/[/\\]/).filter(Boolean).at(-1)??ws.root}</button>${segments.map((segment,index)=>{
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
  const locations=[...state.gitRepoOptions.map(repo=>({path:repo.path,name:repo.kind==="workspace"?t("git.repoWorkspace"):`${t("git.repoWorktree")} · ${repo.branch||repo.path}`})),...state.settings.pinnedWorkspaces.map(root=>({path:root.path,name:`${root.icon} ${root.name}`}))];
  if(ws.root && !locations.some(root=>root.path===ws.root))locations.unshift({path:ws.root,name:ws.root.split(/[/\\]/).at(-1)??ws.root});
  const copy=async(value:string)=>{try{const result=await copyText(value);ws.draftStatus=result?text("已复制", "Copied"):text("复制失败", "Copy failed");}catch{ws.draftStatus=text("复制失败", "Copy failed");}state.requestUpdate();};
  return html`<div class="wk-layout" style=${`--wk-nav-ratio:${ws.navRatio}`} @keydown=${(event:KeyboardEvent)=>{
    if((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==="s" && ws.mode==="files" && (ws.editing||workspaceDirty())){event.preventDefault();void saveWorkspaceFile(state);}
    if((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==="f" && ws.mode==="files"){event.preventDefault();document.querySelector<HTMLInputElement>(".wk-file-search")?.focus();}
  }}><aside class="wk-nav">
    <div class="wk-nav__location"><select class="wk-nav__repo" aria-label=${text("当前工作区或仓库", "Current workspace or repository")} .value=${ws.root??""} ?disabled=${ws.fileSaving} @change=${(event:Event)=>{const value=(event.target as HTMLSelectElement).value;if(value==="__choose__")opts.onChooseRoot();else if(value==="__default__")opts.onDefaultRoot();else opts.onRepoChange(value);}}>
      ${locations.filter((root,index,array)=>array.findIndex(other=>other.path===root.path)===index).map(root=>html`<option value=${root.path}>${root.name}</option>`)}<option value="__default__">${text("返回默认工作区", "Default workspace")}</option><option value="__choose__">${text("选择其他文件夹…", "Choose another folder…")}</option></select></div>
    <div class="wk-nav__search"><input type="search" aria-label=${text("搜索工作区文件", "Search workspace files")} placeholder=${text("搜索文件或路径", "Find files or paths")} .value=${ws.search} @input=${(event:Event)=>setWorkspaceSearch(state,(event.target as HTMLInputElement).value)} @keydown=${(event:KeyboardEvent)=>{if(event.key==="Escape")setWorkspaceSearch(state,"");}} /></div>
    <div class="wk-nav__node ${ws.mode==="files"?"active":""}" role="button" tabindex="0" @click=${opts.onOpenFiles} @keydown=${(event:KeyboardEvent)=>{if(event.key==="Enter" || event.key===" "){event.preventDefault();opts.onOpenFiles();}}}>
      ${icons.folder}<span>${t("workspace.files")}</span><span class="wk-nav__node-actions"><button class="icon-btn icon-btn--xs" aria-label=${t("workspace.refresh")} title=${t("workspace.refresh")} @click=${(event:Event)=>{event.stopPropagation();opts.onRefreshFiles();}}>${icons.refreshCw}</button><button class="icon-btn icon-btn--xs" aria-label=${t("workspace.openRoot")} title=${t("workspace.openRoot")} @click=${(event:Event)=>{event.stopPropagation();opts.onOpenRootFolder();}}>${icons.folderOpen}</button></span>
    </div>
    <div class="wk-nav__hidden"><oc-toggle-switch .checked=${ws.showHidden} .label=${text("隐藏与生成文件", "Hidden and generated files")} @change=${(event:CustomEvent)=>{ws.showHidden=!!event.detail.checked;persistWorkspacePreferences();if(ws.search)setWorkspaceSearch(state,ws.search);else if(ws.currentPath)void loadWorkspaceDirectory(state,ws.currentPath,true);}}></oc-toggle-switch></div>
    <div class="wk-nav__tree" aria-busy=${ws.loading||ws.searchLoading}>
      ${!isAtRoot && !ws.search?html`<button class="wk-nav__item wk-nav__item--back" @click=${()=>navigateWorkspaceUp(state)}>..</button>`:nothing}
      ${ws.loading || ws.searchLoading?html`<div class="wk-nav__hint" role="status">${t("workspace.loading")}</div>`:nothing}
      ${ws.error?html`<div class="wk-nav__hint" role="alert">${ws.error}</div>`:nothing}
      ${items.slice(0,ws.search?200:ws.visibleLimit).map(item=>html`<div class="wk-nav__file-row ${ws.selectedFile===item.path?"active":""}"><button class="wk-nav__item ${item.isDir?"wk-nav__item--dir":""}" title=${item.relativePath??item.name} ?disabled=${ws.fileSaving} @click=${()=>openWorkspaceDirectory(state,item)}><span class="wk-nav__item-icon">${item.isDir?icons.folder:icons.fileText}</span><span class="wk-nav__item-name">${item.name}${item.relativePath?html`<small>${item.relativePath}</small>`:nothing}</span></button><button class="icon-btn icon-btn--xs wk-nav__item-action" aria-label=${t("workspace.openFolder")} @click=${()=>opts.onOpenItemFolder(item.path)}>${icons.folderOpen}</button></div>`)}
      ${!ws.search && items.length>ws.visibleLimit?html`<button class="btn btn--sm" @click=${()=>{ws.visibleLimit+=200;state.requestUpdate();}}>${text("显示更多", "Show more")} (${Math.min(ws.visibleLimit,items.length)}/${items.length})</button>`:nothing}
      ${!items.length && !ws.loading && !ws.searchLoading && !ws.error?html`<div class="wk-nav__hint">${ws.search?text("没有匹配文件", "No matching files"):text("此文件夹为空", "This folder is empty")}</div>`:nothing}
      ${(ws.search?ws.searchTruncated:ws.truncated)?html`<div class="wk-nav__hint">${text("结果较多，请缩小搜索范围", "More results exist; refine your search")}</div>`:nothing}
    </div>
    <button class="wk-nav__node wk-nav__node--git ${ws.mode==="git"?"active":""}" @click=${opts.onSelectGitNode}>${icons.diff}<span>${t("git.title")}</span></button>
    <section class="wk-nav__section"><div class="wk-nav__section-title">${t("worktrees.title")}</div>${opts.worktreesSlot}</section>
  </aside><oc-resizable-divider .splitRatio=${ws.navRatio} .minRatio=${.16} .maxRatio=${.45} @resize=${handleNavResize}></oc-resizable-divider>
  <section class="wk-main">${ws.mode==="git"?opts.gitSlot:html`
    <div class="wk-browser-toolbar"><div class="wk-browser-history"><button class="btn btn--sm" aria-label=${text("后退", "Back")} ?disabled=${ws.historyIndex<=0} @click=${()=>navigateWorkspaceHistory(state,-1)}>${icons.arrowLeft}</button><button class="btn btn--sm" aria-label=${text("前进", "Forward")} ?disabled=${ws.historyIndex>=ws.history.length-1} @click=${()=>navigateWorkspaceHistory(state,1)}>${icons.arrowRight}</button></div>${renderBreadcrumb(state)}<button class="btn btn--sm" ?disabled=${!ws.root || state.settings.pinnedWorkspaces.some(root=>root.path===ws.root)} @click=${opts.onPinRoot}>${text("固定工作区", "Pin workspace")}</button></div>
    ${ws.recentFiles.length?html`<nav class="wk-file-tabs" role="tablist" aria-label=${text("打开的文件", "Open files")}>${ws.recentFiles.map((file,index)=>html`<div class="wk-file-tab ${file.path===ws.selectedFile?"active":""}"><button role="tab" id=${`workspace-tab-${index}`} aria-controls="workspace-preview-panel" aria-selected=${file.path===ws.selectedFile} ?disabled=${ws.fileSaving} @click=${()=>void loadWorkspaceFile(state,file.path,file.name)}>${file.name}${file.path===ws.selectedFile && workspaceDirty()?" •":""}</button><button aria-label=${text("关闭文件标签", "Close file tab")} ?disabled=${ws.fileSaving} @click=${()=>closeWorkspaceFile(state,file.path)}>${icons.x}</button></div>`)}</nav>`:nothing}
    <div class="wk-preview" id="workspace-preview-panel" role="tabpanel">${ws.selectedFile?html`
      <div class="wk-file-toolbar"><div class="wk-file-toolbar__actions"><button class="btn btn--sm" @click=${()=>opts.onAttachFile(ws.selectedFile!,ws.selectedFileName??"")}>${text("在对话中引用", "Use in chat")}</button><button class="btn btn--sm" @click=${()=>opts.onOpenItemFolder(ws.selectedFile!)}>${text("在文件夹中显示", "Show in folder")}</button>
        ${ws.fileContent!==null?html`<button class="btn btn--sm" @click=${()=>void copy(ws.draft)}>${text("复制内容", "Copy content")}</button><button class="btn btn--sm" aria-pressed=${ws.wrap} @click=${()=>{ws.wrap=!ws.wrap;state.requestUpdate();}}>${text("自动换行", "Wrap")}</button><button class="btn btn--sm" ?disabled=${!ws.fileHash||ws.fileSaving} @click=${()=>{ws.editing=!ws.editing;state.requestUpdate();}}>${ws.editing?text("预览文件", "View file"):text("编辑", "Edit")}</button>${ws.editing || workspaceDirty()?html`<button class="btn btn--sm primary" ?disabled=${!workspaceDirty()||ws.fileSaving} @click=${()=>void saveWorkspaceFile(state)}>${ws.fileSaving?text("保存中…", "Saving…"):text("保存文件", "Save file")}</button><button class="btn btn--sm" ?disabled=${ws.fileSaving} @click=${()=>void discardWorkspaceDraft(state)}>${text("放弃草稿/重新加载", "Discard draft / reload")}</button>`:nothing}`:nothing}
      </div>${canPreview?html`<input class="wk-file-search" type="search" placeholder=${text("在文件内查找（Ctrl+F）", "Find in file (Ctrl+F)")} aria-label=${text("在文件内查找", "Find in file")} .value=${ws.fileQuery} @input=${(event:Event)=>{ws.fileQuery=(event.target as HTMLInputElement).value;state.requestUpdate();}} />`:nothing}</div>
      ${ws.fileError?html`<div class="wk-file-error" role="alert">${ws.fileError}</div>`:nothing}
      <div class="wk-preview__content">${ws.fileLoading?html`<div class="wk-preview__placeholder" role="status">${t("workspace.loading")}</div>`:ws.fileContent!==null?ws.editing?html`<textarea class="wk-editor" aria-label=${text("工作区文件编辑器", "Workspace file editor")} spellcheck="false" wrap=${ws.wrap?"soft":"off"} ?disabled=${ws.fileSaving} .value=${ws.draft} @input=${(event:Event)=>updateWorkspaceDraft(state,(event.target as HTMLTextAreaElement).value)}></textarea>`:html`<pre class="wk-preview__text ${ws.wrap?"wk-preview__text--wrap":""}">${highlighted(ws.draft,ws.fileQuery)}</pre>`:ws.imagePreview?html`<div class="wk-image-preview"><img src=${ws.imagePreview} alt=${ws.selectedFileName??""} /></div>`:html`<div class="wk-preview__placeholder">${t("workspace.noPreview")}</div>`}</div>
      <footer class="wk-file-status"><span>${ws.fileContent!==null?`${lineCount(ws.draft)} ${text("行", "lines")} · ${(ws.fileSize/1024).toFixed(1)} KiB`:ws.selectedFileName}</span><span role="status">${ws.draftStatus}</span></footer>
    `:html`<div class="empty-state"><span class="empty-state__icon">${icons.fileText}</span><div class="empty-state__title">${t("workspace.selectFile")}</div><div class="empty-state__desc">${text("搜索、预览或编辑文件，也可以把它引用到当前对话。", "Find, preview or edit a file, or attach it to the current conversation.")}</div><button class="btn" @click=${opts.onChooseRoot}>${text("打开工作区文件夹", "Open a workspace folder")}</button></div>`}</div>
  `}</section></div>`;
}
