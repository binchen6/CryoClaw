/** Runs inside the opaque card frame. No host DOM or credentials cross this bridge. */
export function inspectorScript(){return `
let inspectorActive=false,inspectorOverlay=null,inspectorSelected=null,inspectorHover=null,inspectorColor='Highlight';
const inspectorEscape=value=>Array.from(value).map(c=>/^[a-zA-Z0-9_-]$/.test(c)?c:'\\\\'+c.codePointAt(0).toString(16)+' ').join('');
function inspectorSelector(element){
 if(element.id){const selector='[id="'+element.id.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(selector).length===1)return selector;}catch{}}
 const parts=[];let node=element;while(node&&node.nodeType===1&&parts.join(' > ').length<600){const tag=node.localName;if(!tag)break;const siblings=node.parentElement?[...node.parentElement.children].filter(s=>s.localName===tag):[node];parts.unshift(tag+(siblings.length>1?':nth-of-type('+(siblings.indexOf(node)+1)+')':''));const selector=parts.join(' > ');try{if(document.querySelectorAll(selector).length===1)return selector;}catch{}node=node.parentElement;}return parts.join(' > ').slice(0,768);
}
function inspectorPaint(element){
 if(!element||!element.isConnected){if(inspectorOverlay)inspectorOverlay.hidden=true;return;}
 if(!inspectorOverlay){inspectorOverlay=document.createElement('div');inspectorOverlay.setAttribute('data-cryoclaw-inspector','');inspectorOverlay.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid;border-radius:3px;box-shadow:0 0 0 1px Canvas;';document.documentElement.append(inspectorOverlay);}
 const rect=element.getBoundingClientRect();Object.assign(inspectorOverlay.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',borderColor:inspectorColor});inspectorOverlay.hidden=false;
}
function inspectorElement(event){return event.composedPath().find(node=>node?.nodeType===1&&!node.hasAttribute('data-cryoclaw-inspector'))??null;}
function inspectorMove(event){if(!inspectorActive)return;inspectorHover=inspectorElement(event);inspectorPaint(inspectorHover??inspectorSelected);inspectorBlock(event);}
function inspectorBlock(event){if(!inspectorActive)return;event.preventDefault();event.stopImmediatePropagation();}
function inspectorPick(event){if(!inspectorActive)return;const element=inspectorElement(event);inspectorBlock(event);if(!element)return;inspectorSelected=element;inspectorPaint(element);parent.postMessage({type:'cryoclaw:dashboard',action:'selectElement',value:{selector:inspectorSelector(element),tagName:element.localName,text:(element.innerText??element.textContent??'').replace(/\\s+/g,' ').trim().slice(0,280)}},'*');}
function inspectorKey(event){if(!inspectorActive||event.key==='Tab'||['Shift','Control','Alt','Meta'].includes(event.key))return;if(event.key==='Escape'){inspectorBlock(event);parent.postMessage({type:'cryoclaw:dashboard',action:'clearSelection'},'*');return;}if((event.key==='Enter'||event.key===' ')&&event.target!==document.body)inspectorPick(event);else inspectorBlock(event);}
function inspectorScroll(){if(inspectorActive)inspectorPaint(inspectorHover??inspectorSelected);}
function updateInspector(active,selector,color){
 const next=active===true;inspectorActive=next;
 if(typeof color==='string'&&color.length<80)inspectorColor=color;
 inspectorSelected=null;inspectorHover=null;if(next&&typeof selector==='string'&&selector.length<=768)try{inspectorSelected=document.querySelector(selector);}catch{}
 if(!next){inspectorOverlay?.remove();inspectorOverlay=null;}else inspectorPaint(inspectorSelected);
}
// Install before the card's own scripts, so their capture listeners cannot run first.
addEventListener('pointermove',inspectorMove,true);addEventListener('click',inspectorPick,true);addEventListener('keydown',inspectorKey,true);addEventListener('scroll',inspectorScroll,true);addEventListener('resize',inspectorScroll);
for(const event of ['pointerdown','pointerup','mousedown','mouseup','touchstart','touchend','dblclick','auxclick','beforeinput','paste','cut','drop','dragstart','contextmenu'])addEventListener(event,inspectorBlock,{capture:true,passive:false});
`;}
