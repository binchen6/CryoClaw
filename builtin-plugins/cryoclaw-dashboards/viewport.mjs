/** Shared by live cards and isolated template previews; dimensions are CSS pixels. */
export function viewportScript(){return `const viewportListeners=new Set();
const viewport=Object.freeze({get width(){return innerWidth},get height(){return innerHeight},subscribe(fn){if(typeof fn!=='function')throw Error('Expected a viewport callback');viewportListeners.add(fn);fn({width:innerWidth,height:innerHeight});return()=>viewportListeners.delete(fn);}});
let viewportFrame=0;
addEventListener('resize',()=>{if(viewportFrame)return;viewportFrame=requestAnimationFrame(()=>{viewportFrame=0;for(const fn of viewportListeners)try{fn({width:innerWidth,height:innerHeight});}catch{}});});
addEventListener('pagehide',()=>{if(viewportFrame)cancelAnimationFrame(viewportFrame);viewportListeners.clear();},{once:true});`;}

// Long content remains reachable even in older model-authored cards with fixed geometry.
export const responsiveStyle=`<style data-cryoclaw-responsive>
html{width:100%;height:100%;overflow-x:hidden!important}body{box-sizing:border-box;min-width:0!important;max-width:100%!important;overflow-x:hidden!important;overflow-y:auto!important}
:where(img,video,svg,canvas){max-width:100%}:where(input,textarea,select){max-width:100%;box-sizing:border-box}
@media(max-width:420px),(max-height:300px){body{padding:18px!important}:where(h1,h2,h3,p){overflow-wrap:anywhere}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>`;
