const finish=`<style>
:root{color-scheme:light;--ease:cubic-bezier(.2,.75,.2,1)}
body{text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
button{-webkit-tap-highlight-color:transparent}
button:focus-visible,input:focus-visible,video:focus-visible{outline:2px solid #168aff;outline-offset:3px}
::selection{background:#75c9ff66}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:#7b8b9540;border-radius:8px}
.rate,.stock{position:relative;transition:padding .25s var(--ease),background .25s var(--ease)}
.rate:hover,.stock:hover{background:#91d8ff0d}
#refresh,#scan{box-shadow:inset 0 0 0 1px #ffffff1c}
#gallery{perspective:1200px}.release{box-shadow:0 12px 32px #020a1330;transition:flex .48s var(--ease),transform .3s var(--ease),box-shadow .3s var(--ease)}
.release:hover{transform:translateY(-5px);box-shadow:0 20px 42px #020a134d}.release.active{box-shadow:0 20px 55px #020a1359}
.release:after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,transparent 45%,#02060bd9);pointer-events:none}.release span,.release h3,.release p{z-index:1}
.release h3{max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis}.release.active h3{font-size:34px!important}
.todo{min-height:46px}.todo input{appearance:none;border:1.5px solid #b8c7d1;border-radius:50%;width:20px;height:20px;padding:0;display:grid;place-items:center;transition:background .2s,border-color .2s}
.todo input:checked{background:#168aff;border-color:#168aff}.todo input:checked:after{content:'✓';color:white;font-size:13px;font-weight:700}
.habit button{aspect-ratio:1;min-width:0;padding:0!important;border-radius:10px}.habit button.checked{box-shadow:0 4px 12px #168aff26}
#modes{padding:5px;background:#07395212;border-radius:99px;width:max-content;max-width:100%}#modes button{border-radius:99px}
.clock{background:radial-gradient(circle at 50% 35%,#ffffff30,transparent 60%);box-shadow:0 14px 35px #1554751a,inset 0 0 0 1px #ffffff24}
#start,#reset{border-radius:15px;min-height:46px}#reset{background:#ffffff35;color:#082f46}
.space{box-shadow:0 14px 35px #0003}.track i{background:linear-gradient(90deg,#55b8ef,#c2ecff)}
#queue{scrollbar-width:thin}#queue button{position:relative;overflow:hidden}#queue button.active{background:#91d8ff12;box-shadow:inset 3px 0 #91d8ff}
.screen{position:relative;overflow:hidden}.screen:after{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(110deg,#ffffff06,transparent 35%)}
video{box-shadow:0 15px 35px #0005}
.recipes button{position:relative;overflow:hidden;transition:transform .3s var(--ease),box-shadow .3s var(--ease)}.recipes button:hover{transform:translateY(-4px);box-shadow:0 14px 30px #137fc419}.recipes button:after{content:'↗';position:absolute;right:18px;top:16px;font-size:18px;opacity:.45}
@media(max-width:620px){.release.active h3{font-size:25px!important}.recipes{gap:8px}.recipes button{padding:15px}.recipes b{font-size:16px}}
</style>`;

export function finishShowcase(card){
 if(!card.html)return card;
 let html=card.html.replace('</head>',finish+'</head>');
 if(card.cardId==='welcome'){
  html=html.replace('<h1>','<p class="eyebrow">CRYOCLAW / LIVING DASHBOARDS</p><h1>').replace('</h1>','</h1><div class="welcome-actions"><button id="create">开始设计 <span>↗</span></button><button id="tour">探索示例</button></div>').replace('</body>',`<script>document.getElementById('create').onclick=()=>cryoclawDashboard.compose('为我设计一块有实际用途的看板。先了解我的目标，再创建模块。');document.getElementById('tour').onclick=()=>cryoclawDashboard.expand();</script></body>`).replace('</head>',`<style>
 body{position:relative;background:radial-gradient(ellipse at 78% 40%,#d9f2ff 0,transparent 48%),linear-gradient(115deg,#fff,#f8fcff)!important}
 .eyebrow{position:absolute;left:44px;top:24px;font:11px/1.4 monospace;letter-spacing:2.5px;color:#7b98a8}
 h1{font-size:72px!important;line-height:1.02!important;letter-spacing:-5px!important;margin-top:2px!important}h1 em{position:relative}h1 em:after{content:'';position:absolute;left:-3px;right:-3px;bottom:4px;height:8px;background:#168aff18;z-index:-1}
 .caption{bottom:25px!important;font-size:14px!important;color:#78909c!important;letter-spacing:.5px!important}.caption:first-letter{color:#168aff}
 .welcome-actions{position:absolute;left:44px;bottom:53px;display:flex;gap:10px;z-index:3}.welcome-actions button{padding:10px 18px;border-radius:99px;font-size:13px;background:#101c24;color:white;box-shadow:0 7px 18px #102a3a1c}.welcome-actions button+button{background:#ffffffa8;color:#305064;box-shadow:inset 0 0 0 1px #d8e7ef}.welcome-actions span{margin-left:12px;color:#91d8ff}
 .art{right:5%!important;top:15%!important;font-size:19px!important;line-height:1.25!important;letter-spacing:5px!important;opacity:.62!important;filter:drop-shadow(0 8px 12px #168aff12)}
 @media(max-width:700px){h1{font-size:54px!important}.art{right:-8%!important;opacity:.25!important}.eyebrow{left:32px}.welcome-actions{left:32px}.caption{left:32px!important}}
 </style></head>`);
 }
 if(['live-section','local-section','connected-section'].includes(card.cardId))html=html.replace('</head>',`<style>
 .section{position:relative;overflow:hidden;background:radial-gradient(ellipse at 78% 20%,#ffffff24,transparent 55%)}
 .section h1{font-size:48px!important;font-weight:780;letter-spacing:-2.5px!important;line-height:1.12!important;position:relative;z-index:1}
 .section h1:first-line{color:inherit}.section:before{content:'CRYO / LIVE WORKSPACE';position:absolute;left:43px;top:20px;font:10px monospace;letter-spacing:3px;opacity:.42}
 .section .art{position:absolute;right:5%;top:50%;transform:translateY(-50%);font-size:23px!important;line-height:1.2!important;letter-spacing:6px!important;opacity:.55}
 </style></head>`);
 if(card.cardId==='quick-notes')html=html.replace('</head>',`<style>body{background:radial-gradient(circle at 85% 10%,#ffffff70,transparent 42%),linear-gradient(145deg,#c8edff,#8dd2f6)!important}#note{border-color:#ffffff90!important;box-shadow:0 12px 30px #16729c12,inset 0 1px #ffffffa0!important}.stamp{opacity:.55}</style></head>`);
 if(card.cardId==='gesture-resize')html=html.replace('</head>',`<style>body{background:radial-gradient(circle at 80% 50%,#168aff18 1px,transparent 1.5px) 0 0/15px 15px,linear-gradient(135deg,#fff,#f2f9fd)!important}.size{font-variant-numeric:tabular-nums}.size small{font-weight:650}.corner{filter:drop-shadow(0 4px 6px #168aff30)}</style></head>`);
 if(card.cardId==='gesture-open')html=html.replace('</head>',`<style>body{background:radial-gradient(ellipse at 0 0,#1d3442,transparent 65%),#070b0f!important}.trip{box-shadow:0 12px 30px #0006,inset 0 1px #ffffff66}.trip:hover{transform:translateY(-3px) scale(1.01)}.trip h3{letter-spacing:-.5px}</style></head>`);
 if(card.cardId==='recipe-guide')html=html.replace('</head>',`<style>body{background:radial-gradient(circle at 90% 15%,#168aff16 1px,transparent 1.5px) 0 0/15px 15px,linear-gradient(120deg,#f9fdff,#eef8ff)!important}.lead h2{font-size:46px!important;letter-spacing:-2px!important}.lead .muted{max-width:620px}.recipes{margin-top:30px!important}.recipes button{min-height:90px;border:1px solid #ffffff70!important}</style></head>`);
 return {...card,html};
}
