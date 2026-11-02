/** Standalone real Files view; no app connection, gateway or user configuration. */
import {render} from "../../chat-ui/ui/node_modules/lit/index.js";
import {renderDockFiles} from "../../chat-ui/ui/src/ui/views/dock-files.ts";
import {setWorkspaceRoot,workspaceViewState} from "../../chat-ui/ui/src/ui/controllers/workspace.ts";
import "../../chat-ui/ui/src/styles.css";

const w=window as any;
let queued=false;
const state:any={client:null,connected:false,requestUpdate(){
  if(queued)return;queued=true;
  queueMicrotask(()=>{queued=false;render(renderDockFiles(state,options),document.querySelector('#app')!);});
}};
const info=await w.cryoclaw.dockFilesQaInfo();
workspaceViewState.showHidden=false;
const options={
  onAttachFile:(path:string,name:string)=>{w.__dockFilesFixture.attached={path,name};},
  onOpenItemFolder:(path:string)=>{w.__dockFilesFixture.opened=path;},
  onChooseRoot:()=>void setWorkspaceRoot(state,workspaceViewState.root===info.roots.current?info.roots.alternate:info.roots.current,true),
};
w.__dockFilesFixture={
  roots:info.roots,
  switchRoot:(name:"current"|"alternate")=>setWorkspaceRoot(state,info.roots[name],true),
  snapshot:()=>({root:workspaceViewState.root,currentPath:workspaceViewState.currentPath,selectedFile:workspaceViewState.selectedFile,search:workspaceViewState.search}),
  refresh:()=>state.requestUpdate(),
};
state.requestUpdate();
