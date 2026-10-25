const common=`body{padding:clamp(18px,3vw,38px)}h2{font-size:clamp(23px,3.5vw,34px)}.row{min-width:0}.row>input{min-width:0}.muted,.caption{overflow-wrap:anywhere}@media(max-width:420px){.row{flex-wrap:wrap}.stamp{max-width:calc(100% - 36px);font-size:10px;letter-spacing:1px}}`;
const styles={
 'quick-notes':`body{overflow-y:auto}#note{min-height:70px!important;flex:1 1 80px;width:100%;margin:12px 0;font-size:clamp(14px,1.6vw,18px)}.heading h2{font-size:clamp(26px,4vw,36px)}.caption{margin-top:4px}.meta{flex-wrap:wrap;gap:4px 12px}@media(max-height:260px){.caption{display:none}.meta{font-size:10px}}`,
 'pomodoro':`body{text-align:center}#modes{margin-inline:auto;flex-wrap:wrap;justify-content:center}.clock{width:clamp(140px,34vmin,260px)!important;height:auto!important;aspect-ratio:1;margin:clamp(12px,3vh,24px) auto}#time{font-size:clamp(36px,9vmin,64px)!important}body>.row:not(#modes){justify-content:center;max-width:520px;margin-inline:auto}#start,#reset{flex:1}@media(max-height:390px){.clock{width:140px!important;margin:12px auto}.foot{margin-top:8px}}`,
 'fx-rates':`.rate{padding:12px 0}.rate strong{font-size:clamp(18px,3.8vw,25px)}@media(max-width:400px){.rate{flex-wrap:wrap}.rate b{flex:1 1 100px}.rate strong{min-width:0;margin-left:auto}.rate svg{order:3;flex:1 0 100%;width:100%;height:26px}}`,
 'market-watch':`.stock{padding:15px 0}.stock>div:last-child{font-size:clamp(16px,3.5vw,23px)!important}@media(max-width:400px){.stock{align-items:flex-start;flex-direction:column;gap:6px}}`,
 'todo-habits':`.todo{padding:8px 0!important;font-size:14px!important}.habit{margin-top:8px!important}.habit button{aspect-ratio:auto;min-height:30px;height:30px}.habit{grid-template-columns:38px repeat(7,minmax(0,1fr))}#list{max-height:138px}`,
 'disk-space':`#scan{margin-top:18px}.space strong{font-size:clamp(30px,6vw,43px)}body>.row{align-items:flex-start;flex-wrap:wrap}`,
 'audio-lab':`body{overflow-y:auto}.layout>div{min-width:0}@media(max-width:720px){.layout{grid-template-columns:1fr;height:auto;gap:24px}.player{min-height:350px}.screen{min-height:260px}.transport{flex-wrap:wrap}.volume{max-width:100%}}@media(max-width:420px){.top{letter-spacing:1px}.buttons{gap:8px}.buttons button{width:36px;height:36px}.buttons #play{width:48px;height:48px}.volume input{width:80px}#queue button{padding:14px 12px}.screen{padding:16px}}`,
 'pattern-lab':`#matrix{grid-template-columns:repeat(16,minmax(0,1fr));gap:clamp(4px,1.2vw,12px)}#matrix button{min-width:0;width:100%;height:clamp(14px,3vw,48px);padding:0}.bottom{flex-wrap:wrap;gap:16px}.bottom input{max-width:160px}@media(max-width:500px){h2{font-size:25px}.eyebrow{font-size:10px}.bottom{font-size:12px}#matrix{margin-block:20px}}`,
 'recipe-guide':`.recipes{grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr))}.lead h2{font-size:clamp(26px,4vw,46px)!important}.footer{position:static!important;margin-top:20px}`,
 'release-gallery':`body{overflow-y:auto}#gallery{height:clamp(240px,66vh,300px)!important}#gallery .release{overflow-y:auto}.row{align-items:flex-start;flex-wrap:wrap}.release.active h3{font-size:clamp(20px,3vw,28px)!important;white-space:normal;overflow-wrap:anywhere;text-overflow:clip}@media(max-width:700px){#gallery{overflow-x:auto;scroll-snap-type:x mandatory;min-height:260px}.release{flex:0 0 70%;scroll-snap-align:start}.release.active{flex:0 0 85%!important}h2{font-size:24px}}@media(max-height:360px){#gallery{height:220px!important;min-height:180px}}`,
 'release-timeline':`.entry{grid-template-columns:42px minmax(0,1fr);gap:10px}.entry p{overflow-wrap:anywhere}#history{max-height:none}`,
 'style-lab':`body{display:flex;flex-direction:column}h2{font-size:clamp(26px,4vw,46px)}.eyebrow{font-size:10px;letter-spacing:1.5px;overflow-wrap:anywhere}.actions{position:relative;inset:auto;flex-wrap:wrap;margin-top:auto;padding-top:24px;z-index:1}.actions button{padding:9px 16px}.footer{position:relative;inset:auto;max-width:100%;font-size:12px;margin-top:18px}#orb{pointer-events:none;right:0;width:min(310px,80%);aspect-ratio:1;height:auto}@media(max-width:500px){#orb{right:0;opacity:.6}}`,
 'living-guide':`h2{font-size:clamp(27px,4vw,38px)}.eyebrow{font-size:10px;letter-spacing:1.6px}ol{margin:16px 0}li{grid-template-columns:1fr;gap:3px;margin:10px 0}button{max-width:100%;white-space:normal}`,
 'welcome':`body{overflow-x:clip}h1{font-size:clamp(42px,8vw,72px)!important;letter-spacing:-3px!important;max-width:100%;overflow-wrap:anywhere}.eyebrow{max-width:calc(100% - 64px);overflow-wrap:anywhere}.caption{right:24px;bottom:20px!important;line-height:1.5;max-width:calc(100% - 44px)}.welcome-actions{flex-wrap:wrap;gap:8px;bottom:58px;right:24px;max-width:calc(100% - 44px)}.welcome-actions button{padding:9px 16px}@media(max-width:500px){h1{font-size:44px!important;letter-spacing:-2px!important}.eyebrow{left:20px;font-size:9px;letter-spacing:1.5px}.welcome-actions{left:20px}.caption{left:20px!important;font-size:11px!important}}`,
};
const sectionStyle=`body{padding:0}.section{min-height:100%;height:auto;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;padding:clamp(22px,3vw,32px);gap:14px;overflow:visible}.section:before{display:none}.section h1{font-size:clamp(26px,3.6vw,36px)!important;letter-spacing:-1px!important;line-height:1.18!important;white-space:normal}.section-kicker{font:11px/1.5 monospace;letter-spacing:1.5px;opacity:.65}.section-summary{font-size:13px;line-height:1.75;max-width:30em;opacity:.8}.section ul{list-style:none;padding:0;margin:2px 0 0;display:grid;gap:10px}.section li{font-size:13px;line-height:1.65;border-top:1px solid #7e9aad40;padding-top:9px}.section-footer{font-size:12px;line-height:1.75;opacity:.65;margin-top:auto;padding-top:6px}.section .cryo-field{width:64px;height:64px;right:20px;top:12px;transform:none;opacity:.23;pointer-events:none}@media(max-width:340px){.section{gap:10px;padding:20px}.section h1{font-size:25px!important}}`;
for(const id of ['live-section','local-section','connected-section'])styles[id]=sectionStyle;

// Complete rows give the welcome and media room to lead, while tools share a baseline.
const rows=[
 [340,[['welcome',8],['quick-notes',4]]],
 [360,[['gesture-resize',4],['gesture-open',8]]],
 [340,[['system-check',8],['live-section',4]]],
 [440,[['fx-rates',6],['market-watch',6]]],
 [440,[['release-gallery',8],['release-timeline',4]]],
 [500,[['local-section',4],['todo-habits',8]]],
 [460,[['pomodoro',6],['disk-space',6]]],
 [480,[['audio-lab',12]]],
 [420,[['media-demo',8],['connected-section',4]]],
 [420,[['pattern-lab',8],['style-lab',4]]],
 [400,[['recipe-guide',8],['living-guide',4]]],
];
let order=0;const geometry=Object.fromEntries(rows.flatMap(([h,cards])=>cards.map(([id,w])=>[id,{w,h,order:order++}])));
export function adaptCard(card){const size=geometry[card.cardId];return {...card,...size?{layout:{...card.layout,...size}}:{},...card.html?{html:card.html.replace('</head>',`<style data-template-responsive>${common}${styles[card.cardId]??''}</style></head>`)}:{}};}
