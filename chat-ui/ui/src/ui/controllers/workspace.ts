import type {GatewayBrowserClient} from "../gateway.ts";
import type {AppViewState} from "../app-view-state.ts";
import {t} from "../i18n.ts";
import {showConfirm} from "../views/confirm-dialog.ts";

export type WorkspaceGatewayState={client:GatewayBrowserClient|null;connected:boolean};
const rootCache=new WeakMap<GatewayBrowserClient,Map<string,{at:number;value?:string|null;pending?:Promise<string|null>}>>();
export async function resolveAgentWorkspacePath(state:WorkspaceGatewayState,agentId:string,force=false):Promise<string|null>{
  if(!state.client || !state.connected)return null;
  let cache=rootCache.get(state.client);if(!cache){cache=new Map();rootCache.set(state.client,cache);}
  const previous=cache.get(agentId);if(previous?.pending)return previous.pending;
  if(!force && previous?.value && Date.now()-previous.at<60000)return previous.value;
  const entry:{at:number;value?:string|null;pending?:Promise<string|null>}={at:Date.now()};
  const pending=state.client.request<{workspace?:string}>("agents.files.list",{agentId}).then(result=>typeof result?.workspace==="string"?result.workspace:null);
  entry.pending=pending;cache.set(agentId,entry);
  try{entry.value=await pending;entry.at=Date.now();return entry.value;}catch(error){cache.delete(agentId);throw error;}finally{entry.pending=undefined;}
}
export const TEXT_EXTENSIONS=new Set([".md",".txt",".json",".yaml",".yml",".toml",".xml",".csv",".log",".ts",".js",".jsx",".tsx",".py",".sh",".bash",".zsh",".html",".css",".scss",".less",".go",".rs",".java",".c",".cpp",".h",".hpp",".rb",".php",".sql",".env",".conf",".cfg",".ini",".properties",".gitignore",".dockerignore",".editorconfig",".svg"]);
export function isTextFile(name:string):boolean{const ext=name.includes(".")?"."+name.split(".").pop()!.toLowerCase():"";return !ext || TEXT_EXTENSIONS.has(ext);}
export function workspaceRelativePath(root:string,current:string):string {
  const base=root.replace(/\\/g,"/").replace(/\/$/,""),target=current.replace(/\\/g,"/");
  const insensitive=/^[a-z]:/i.test(base),left=insensitive?base.toLowerCase():base,right=insensitive?target.toLowerCase():target;
  return right===left?"":right.startsWith(left+"/")?target.slice(base.length+1):current;
}
export type WorkspaceFileItem={name:string;path:string;isDir:boolean;relativePath?:string};
type FileDraft={content:string;baseHash:string};
function readPreferences():Record<string,any>{try{const value=JSON.parse(localStorage.getItem("cryoclaw.workspace.browser.v1")??"{}");return value && typeof value==="object" && !Array.isArray(value)?value:{};}catch{return {};}}
const preferences=readPreferences();
export const workspaceViewState={
  root:null as string|null,currentPath:null as string|null,customRoot:false,agentRoot:null as string|null,
  items:[] as WorkspaceFileItem[],loading:false,error:null as string|null,truncated:false,visibleLimit:200,
  selectedFile:null as string|null,selectedFileName:null as string|null,fileContent:null as string|null,fileLoading:false,fileError:null as string|null,
  imagePreview:null as string|null,fileHash:"",baseHash:"",fileSize:0,draft:"",editing:false,fileSaving:false,draftStatus:"",
  recentFiles:[] as WorkspaceFileItem[],mode:"files" as "files"|"git",showHidden:preferences.showHidden===true,
  navRatio:typeof preferences.navRatio==="number" && preferences.navRatio>=.16 && preferences.navRatio<=.45?preferences.navRatio:.26,
  search:"",searchLoading:false,searchResults:[] as WorkspaceFileItem[],searchTruncated:false,
  fileQuery:"",wrap:false,history:[] as string[],historyIndex:-1,
};
export type WorkspaceViewState=typeof workspaceViewState;
const ws=workspaceViewState;
let dirLoadSeq=0,fileLoadSeq=0,initSeq=0,searchSeq=0;
let searchTimer:ReturnType<typeof setTimeout>|null=null,draftTimer:ReturnType<typeof setTimeout>|null=null;
let preferenceTimer:ReturnType<typeof setTimeout>|null=null;
const drafts=new Map<string,FileDraft>(),draftWrites=new Map<string,Promise<boolean>>();
let rootWrites:Promise<void>=Promise.resolve();
const directoryCache=new Map<string,{at:number;items:WorkspaceFileItem[];truncated:boolean}>();
export function persistWorkspacePreferences():void{
  if(preferenceTimer)clearTimeout(preferenceTimer);
  preferenceTimer=setTimeout(()=>{try{localStorage.setItem("cryoclaw.workspace.browser.v1",JSON.stringify({root:ws.root,currentPath:ws.currentPath,customRoot:ws.customRoot,showHidden:ws.showHidden,navRatio:ws.navRatio}));}catch{}},200);
}
export function workspaceDirty():boolean{return ws.selectedFile!==null && ws.fileContent!==null && ws.draft!==ws.fileContent;}
function rememberDraft(state:AppViewState):Promise<boolean>{
  const path=ws.selectedFile;if(!path || !ws.baseHash || ws.fileContent===null)return Promise.resolve(true);
  const value={content:ws.draft,baseHash:ws.baseHash},dirty=workspaceDirty();if(dirty)drafts.set(path,value);else drafts.delete(path);
  const previous=draftWrites.get(path)??Promise.resolve();
  const writing=previous.catch(()=>{}).then(async()=>{
    const result=await window.cryoclaw?.workspaceSaveDraft?.({path,draft:dirty?value.content:null,baseHash:value.baseHash});
    if(!result?.success)throw new Error(result?.message??t("workspace.draft.unavailable"));
    if(drafts.size>8){const oldest=[...drafts.keys()].find(key=>key!==ws.selectedFile);if(oldest)drafts.delete(oldest);}
    if(ws.selectedFile===path && ws.draft===value.content){ws.draftStatus=dirty?t("workspace.draft.backedUp"):t("workspace.draft.clean");state.requestUpdate();}
    return true;
  }).catch(error=>{if(ws.selectedFile===path){ws.draftStatus=t("workspace.draft.backupFailed");ws.fileError=String(error);state.requestUpdate();}return !dirty;});
  draftWrites.set(path,writing);void writing.finally(()=>{if(draftWrites.get(path)===writing)draftWrites.delete(path);});return writing;
}
async function flushDraft(state:AppViewState):Promise<boolean>{
  const path=ws.selectedFile;
  do {
    if(draftTimer)clearTimeout(draftTimer);draftTimer=null;
    const content=ws.draft;
    if(!await rememberDraft(state))return false;
    if(ws.selectedFile!==path || ws.draft===content)return true;
    // Editing can continue while the backup IPC is pending. Flush that revision too.
  }while(true);
}
export function updateWorkspaceDraft(state:AppViewState,value:string){ws.draft=value;ws.draftStatus=t("workspace.draft.unsaved");if(draftTimer)clearTimeout(draftTimer);draftTimer=setTimeout(()=>{draftTimer=null;void rememberDraft(state);},400);state.requestUpdate();}
export function selectWorkspaceMode(mode:"files"|"git"){ws.mode=mode;}
export async function loadWorkspaceDirectory(state:AppViewState,dirPath:string,force=false,record=true){
  if(!window.cryoclaw?.workspaceListDir || ws.fileSaving)return;
  const seq=++dirLoadSeq,key=dirPath+":"+ws.showHidden,cached=directoryCache.get(key);
  ws.loading=true;ws.error=null;if(ws.currentPath!==dirPath){ws.items=[];ws.visibleLimit=200;}ws.currentPath=dirPath;state.requestUpdate();
  try {
    const result=!force && cached && Date.now()-cached.at<5000?{success:true,data:cached}:await window.cryoclaw.workspaceListDir(dirPath,{showHidden:ws.showHidden});
    if(seq!==dirLoadSeq)return;
    if(!result?.success || !result.data)throw new Error(result?.message??t("workspace.error"));
    ws.items=result.data.items??[];ws.truncated=result.data.truncated===true;
    directoryCache.set(key,{at:Date.now(),items:ws.items,truncated:ws.truncated});if(directoryCache.size>30)directoryCache.delete(directoryCache.keys().next().value!);
    if(record && ws.history[ws.historyIndex]!==dirPath){ws.history=ws.history.slice(0,ws.historyIndex+1);ws.history.push(dirPath);ws.historyIndex=ws.history.length-1;}
    persistWorkspacePreferences();
  }catch(error){if(seq===dirLoadSeq)ws.error=error instanceof Error?error.message:String(error);}
  finally{if(seq===dirLoadSeq){ws.loading=false;state.requestUpdate();}}
}
export async function setWorkspaceRoot(state:AppViewState,root:string,custom=true):Promise<boolean>{
  if(ws.fileSaving)return false;const generation=++initSeq;if(!await flushDraft(state)){if(generation===initSeq){ws.loading=false;state.requestUpdate();}return false;}if(generation!==initSeq)return false;
  let result:{success:boolean;message?:string}|undefined;
  // Root selection mutates main-process state, so ignoring a stale response alone is insufficient.
  const writing=rootWrites.then(()=>generation===initSeq?window.cryoclaw?.workspaceSetRoot?.(root):undefined);
  rootWrites=writing.then(()=>{},()=>{});
  try{result=await writing;}catch(error){if(generation===initSeq){ws.error=error instanceof Error?error.message:String(error);ws.loading=false;state.requestUpdate();}return false;}
  if(generation!==initSeq)return false;
  if(!result?.success){ws.error=result?.message??t("workspace.error");ws.loading=false;state.requestUpdate();return false;}
  if(ws.root!==root){++fileLoadSeq;++dirLoadSeq;++searchSeq;if(searchTimer)clearTimeout(searchTimer);ws.root=root;ws.currentPath=root;ws.items=[];ws.history=[];ws.historyIndex=-1;ws.selectedFile=null;ws.fileContent=null;ws.imagePreview=null;ws.recentFiles=[];ws.editing=false;ws.fileLoading=false;ws.fileError=null;ws.search="";ws.searchResults=[];ws.searchLoading=false;}
  ws.customRoot=custom;await loadWorkspaceDirectory(state,ws.currentPath??root,true);return true;
}
export async function initWorkspace(state:AppViewState,force=false){
  if(ws.customRoot && ws.root){await loadWorkspaceDirectory(state,ws.currentPath??ws.root,force);return;}
  const seq=++initSeq,client=state.client;ws.loading=true;ws.error=null;state.requestUpdate();
  try {
    const root=await resolveAgentWorkspacePath(state,"main",force);if(seq!==initSeq || state.client!==client)return;
    if(root)ws.agentRoot=root;
    const remembered=!ws.root && preferences.customRoot===true && typeof preferences.root==="string"?preferences.root:null;
    const chosen=remembered??root??ws.root;if(!chosen)throw new Error(t("workspace.error"));
    if(await setWorkspaceRoot(state,chosen,!!remembered)){
      if(remembered && typeof preferences.currentPath==="string" && workspaceRelativePath(chosen,preferences.currentPath)!==preferences.currentPath)await loadWorkspaceDirectory(state,preferences.currentPath,false);
    }
  }catch(error){if(seq===initSeq)ws.error=error instanceof Error?error.message:String(error);}
  finally{if(seq===initSeq){ws.loading=false;state.requestUpdate();}}
}
export async function loadWorkspaceFile(state:AppViewState,filePath:string,fileName:string){
  if(ws.fileSaving)return;const seq=++fileLoadSeq;if(!await flushDraft(state) || seq!==fileLoadSeq)return;
  ws.selectedFile=filePath;ws.selectedFileName=fileName;ws.fileContent=null;ws.imagePreview=null;ws.fileLoading=true;ws.fileError=null;ws.editing=false;ws.fileHash="";ws.baseHash="";ws.draftStatus="";ws.fileQuery="";ws.mode="files";
  if(!ws.recentFiles.some(file=>file.path===filePath))ws.recentFiles=[...ws.recentFiles,{path:filePath,name:fileName,isDir:false}].slice(-8);state.requestUpdate();
  try {
    if(isTextFile(fileName)){
      const result=await window.cryoclaw?.workspaceReadFile?.(filePath);if(seq!==fileLoadSeq)return;
      if(!result?.success || !result.data)throw new Error(result?.message??t("workspace.error"));
      const data=result.data;ws.fileContent=data.content;ws.fileHash=data.hash??"";ws.fileSize=data.size??data.content.length;
      let recovered=drafts.get(filePath)??(typeof data.draft==="string"?{content:data.draft,baseHash:data.draftBaseHash}:null);
      if(recovered?.content===data.content){recovered=null;drafts.delete(filePath);}
      ws.baseHash=recovered?.baseHash??ws.fileHash;ws.draft=recovered?.content??data.content;ws.editing=!!recovered;
      if(recovered){ws.draftStatus=t("workspace.draft.recovered");if(recovered.baseHash!==ws.fileHash)ws.fileError=t("workspace.draft.conflict");}
    }else if(/\.(png|jpe?g|webp|gif|bmp)$/i.test(fileName)){
      const result=await (window as any).cryoclaw?.fileThumbnail?.(filePath);if(seq!==fileLoadSeq)return;ws.imagePreview=typeof result==="string"?result:null;
    }
  }catch(error){if(seq===fileLoadSeq)ws.fileError=error instanceof Error?error.message:String(error);}
  finally{if(seq===fileLoadSeq){ws.fileLoading=false;state.requestUpdate();}}
}
export async function openWorkspaceDirectory(state:AppViewState,item:WorkspaceFileItem){if(ws.fileSaving)return;if(item.isDir){const seq=++fileLoadSeq;if(!await flushDraft(state) || seq!==fileLoadSeq)return;ws.selectedFile=null;ws.fileContent=null;ws.imagePreview=null;ws.editing=false;ws.fileLoading=false;await loadWorkspaceDirectory(state,item.path);}else await loadWorkspaceFile(state,item.path,item.name);}
export function navigateWorkspaceUp(state:AppViewState){if(!ws.currentPath || !ws.root || ws.currentPath===ws.root)return;const parent=ws.currentPath.replace(/[/\\][^/\\]+[/\\]?$/,"");void loadWorkspaceDirectory(state,parent.length>=ws.root.length?parent:ws.root);}
export function navigateWorkspaceHistory(state:AppViewState,direction:number){const next=ws.historyIndex+direction;if(next<0 || next>=ws.history.length)return;ws.historyIndex=next;void loadWorkspaceDirectory(state,ws.history[next],false,false);}
export function setWorkspaceSearch(state:AppViewState,query:string){ws.search=query;++searchSeq;if(searchTimer)clearTimeout(searchTimer);if(!query.trim()){ws.searchResults=[];ws.searchLoading=false;state.requestUpdate();return;}const generation=searchSeq;searchTimer=setTimeout(async()=>{
  if(!ws.root || generation!==searchSeq)return;ws.searchLoading=true;state.requestUpdate();try{const result=await window.cryoclaw?.workspaceFindFiles?.({root:ws.root,query:query.trim(),showHidden:ws.showHidden});if(generation!==searchSeq)return;if(!result?.success)throw new Error(result?.message);ws.searchResults=result.data?.items??[];ws.searchTruncated=result.data?.truncated===true;}catch(error){if(generation===searchSeq)ws.error=String(error);}finally{if(generation===searchSeq){ws.searchLoading=false;state.requestUpdate();}}
},200);state.requestUpdate();}
export async function saveWorkspaceFile(state:AppViewState){
  if(!ws.selectedFile || !workspaceDirty() || ws.fileSaving || !ws.baseHash)return;ws.fileSaving=true;ws.fileError=null;state.requestUpdate();
  const path=ws.selectedFile,content=ws.draft,baseHash=ws.baseHash;
  try{await flushDraft(state);const result=await window.cryoclaw?.workspaceWriteFile?.({path,content,baseHash});if(!result?.success)throw new Error(result?.message??t("workspace.draft.saveFailed"));
    if(ws.selectedFile===path){ws.fileContent=content;ws.baseHash=result.data.hash;ws.fileHash=result.data.hash;ws.fileSize=result.data.size;ws.draftStatus=t("workspace.draft.saved");drafts.delete(path);}
  }catch(error){ws.fileError=error instanceof Error?error.message:String(error);}finally{ws.fileSaving=false;state.requestUpdate();}
}
export async function discardWorkspaceDraft(state:AppViewState){
  if(!ws.selectedFile || ws.fileSaving)return;
  const path=ws.selectedFile,seq=fileLoadSeq,baseHash=ws.baseHash,draft=ws.draft;
  const current=()=>ws.selectedFile===path && seq===fileLoadSeq && ws.draft===draft;
  if(workspaceDirty() && !await showConfirm(state,t("workspace.draft.confirmDiscard")))return;
  if(!current())return;
  if(draftTimer)clearTimeout(draftTimer);draftTimer=null;
  // A later auto-backup must run after this clear, or the clear can erase the new edit.
  const previous=draftWrites.get(path)??Promise.resolve(true);
  const clearing=previous.catch(()=>false).then(async()=>{
    if(!current())return false;
    const result=await window.cryoclaw?.workspaceSaveDraft?.({path,draft:null,baseHash});
    if(!result?.success)throw new Error(result?.message??t("workspace.draft.unavailable"));
    return true;
  });
  draftWrites.set(path,clearing);
  try{if(!await clearing || !current())return;drafts.delete(path);ws.editing=false;ws.draft=ws.fileContent??"";await loadWorkspaceFile(state,path,ws.selectedFileName??"");}
  catch(error){if(current()){ws.fileError=String(error);state.requestUpdate();}}
  finally{if(draftWrites.get(path)===clearing)draftWrites.delete(path);}
}
export async function closeWorkspaceFile(state:AppViewState,path:string){
  if(ws.fileSaving)return;
  if(ws.selectedFile!==path){ws.recentFiles=ws.recentFiles.filter(file=>file.path!==path);state.requestUpdate();return;}
  const seq=++fileLoadSeq;if(!await flushDraft(state) || seq!==fileLoadSeq)return;
  ws.recentFiles=ws.recentFiles.filter(file=>file.path!==path);ws.selectedFile=null;ws.fileContent=null;ws.imagePreview=null;ws.editing=false;ws.fileLoading=false;
  const next=ws.recentFiles.at(-1);if(next)await loadWorkspaceFile(state,next.path,next.name);state.requestUpdate();
}
export function leaveWorkspace(state:AppViewState):void{void flushDraft(state);if(searchTimer)clearTimeout(searchTimer);++searchSeq;ws.searchLoading=false;persistWorkspacePreferences();}
