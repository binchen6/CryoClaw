import {html, render} from "../../chat-ui/ui/node_modules/lit/index.js";
import {installAnchoredOverlays} from "../../chat-ui/ui/src/ui/utils/anchored-overlays.ts";
import {disclosure} from "../../chat-ui/ui/src/ui/utils/disclosure.ts";
import "../../chat-ui/ui/src/ui/components/oc-file-open-menu.ts";
import "../../chat-ui/ui/src/ui/components/oc-resizable-divider.ts";
import "../../chat-ui/ui/src/styles.css";

const root=document.querySelector<HTMLElement>('#app')!;
let open=false, commits=0;
function draw(){render(html`
  <section class="wk-layout fixture-workspace" style="height:100px"><aside class="wk-nav"><input id="workspace-input" placeholder="Workspace search"/></aside><oc-resizable-divider .splitRatio=${.26} .minRatio=${.16} .maxRatio=${.45}></oc-resizable-divider><div class="wk-main"><oc-file-open-menu id="open-one" .path=${"/fixture/ONE.md"}></oc-file-open-menu></div></section>
  <section class="fixture-split" style="height:150px;display:flex;width:100%"><div class="chat-main" style="flex:0 1 60%">Chat</div><oc-resizable-divider .splitRatio=${.6} @resize=${()=>{commits++;}}></oc-resizable-divider><div class="chat-sidebar">Dock</div></section>
  <button id="toggle-controlled" @click=${()=>{open=!open;draw();}}>Toggle</button>${disclosure(open,()=>html`<div id="controlled-body" style="height:120px">Lazy controlled content</div>`)}
  <details id="native-details"><summary>Advanced settings</summary><div style="height:120px">Native content</div></details>
  <div id="tool-focus" class="chat-tool-card chat-tool-card--clickable" tabindex="0" role="button">Tool details</div>
  <div class="fixture-edge" style="position:fixed;right:16px;bottom:16px"><oc-file-open-menu id="open-two" .path=${"/fixture/TWO.md"}></oc-file-open-menu></div>
`,root);}
installAnchoredOverlays(root);draw();
(window as any).__interactionQa={get commits(){return commits;},draw};
