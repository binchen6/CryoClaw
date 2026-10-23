const common=`<style>
@keyframes cc-enter{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
@keyframes cc-drift{from{transform:translate3d(0,-3px,0)}to{transform:translate3d(5px,5px,0)}}
@keyframes cc-line{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}
@keyframes cc-breathe{50%{box-shadow:0 0 0 12px #073d5812,0 0 0 25px #073d5807}}
@keyframes cc-grip{50%{transform:translateY(4px);opacity:.6}}
body{animation:cc-enter .42s cubic-bezier(.2,.7,.2,1) both}
button{transition:transform .18s cubic-bezier(.2,.7,.2,1),background .2s,box-shadow .2s,opacity .2s}
button:active{transform:scale(.97)}button:focus-visible{outline:3px solid #168aff;outline-offset:3px}
.art{animation:cc-drift 9s ease-in-out infinite alternate;will-change:transform}
.rate,.stock,.entry{animation:cc-enter .35s cubic-bezier(.2,.7,.2,1) both}
.rate:nth-child(2),.stock:nth-child(2),.entry:nth-child(2){animation-delay:.05s}
.rate:nth-child(3),.stock:nth-child(3),.entry:nth-child(3){animation-delay:.1s}
.rate polyline,.stock polyline{stroke-dasharray:400;animation:cc-line 1.1s cubic-bezier(.2,.7,.2,1) both}
.trip{transition:transform .25s,box-shadow .25s}.trip:hover{transform:translateY(-4px);box-shadow:0 14px 32px #0005}
.handle,.corner{animation:cc-grip 2.8s ease-in-out 3}.corner{animation-delay:.4s}
.release:hover{box-shadow:inset 0 0 0 2px #91d8ff88}.release h3{transition:color .2s}.release:hover h3{color:#b6e8ff}
.todo{transition:opacity .25s,color .25s}.todo:has(input:checked){opacity:.55}
.habit button{transition:background .2s,transform .2s,border-color .2s}.habit button:hover{transform:translateY(-2px)}
.clock strong{font-variant-numeric:tabular-nums}.is-running .clock{animation:cc-breathe 2.8s ease-in-out infinite}
.track i{transition:width .85s cubic-bezier(.2,.7,.2,1)}#queue button{transition:background .25s,border-color .25s,transform .25s}#queue button:hover{transform:translateX(3px)}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style>`;
export function polishCard(card){if(!card.html)return card;let html=card.html.replace('</head>',common+'</head>');
 if(card.cardId==='pomodoro')html=html.replace('function draw(){','function draw(){document.body.classList.toggle("is-running",!!state.end);');
 if(card.cardId==='audio-lab')html=html.replace('canvas.width=canvas.clientWidth*devicePixelRatio;','if(cryoclawDashboard.motion.active){canvas.width=canvas.clientWidth*devicePixelRatio;')
  .replace('(playing?.18+Math.abs(Math.sin(i*.5+position*3))*.65:.08)','(playing&&!cryoclawDashboard.motion.reduced?.18+Math.abs(Math.sin(i*.5+position*3))*.65:.08)')
  .replace('ctx.fillRect(i*w,canvas.height/2-height/2,w*.65,height);}requestAnimationFrame(animate);}', 'ctx.fillRect(i*w,canvas.height/2-height/2,w*.65,height);}}if(playing&&cryoclawDashboard.motion.active&&!cryoclawDashboard.motion.reduced)requestAnimationFrame(animate);else setTimeout(()=>animate(performance.now()),cryoclawDashboard.motion.active?250:1000);}');
 return {...card,html};
}
