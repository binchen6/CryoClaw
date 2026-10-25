export const crystalFieldStyle = `<style>
.cryo-field{position:absolute;right:1%;top:4%;width:55%;height:92%;pointer-events:none;opacity:.72}
.section .cryo-field{right:2%;top:50%;width:43%;height:88%;transform:translateY(-50%);opacity:.58}
@media(max-width:700px){.cryo-field{right:0;opacity:.28}.section .cryo-field{right:0;opacity:.3}}
</style>`;

export const crystalFieldScript = `(()=>{
const canvas=document.querySelector('.cryo-field'),sdk=window.cryoclawDashboard;if(!canvas||!sdk?.motion)return;
const ctx=canvas.getContext('2d');if(!ctx)return;
const dark=!!document.querySelector('.ink'),lineColor=dark?'#9ddcff':'#168aff',dotColor=dark?'#d3f1ff':'#168aff';
const nodes=Array.from({length:32},(_,i)=>({u:(i%8)/7,v:Math.floor(i/8)/3,phase:i*.83,radius:1.8+(i%4)*.55,x:0,y:0,dx:0,dy:0,heat:0}));
const hexX=new Float32Array(6),hexY=new Float32Array(6);for(let i=0;i<6;i++){hexX[i]=Math.cos(Math.PI/3*i-Math.PI/6);hexY[i]=Math.sin(Math.PI/3*i-Math.PI/6);}
let width=1,height=1,dpr=1,left=0,top=0,pointerX=0,pointerY=0,inside=false,engagement=0,last=0,measureFrame=0,geometryDirty=true,closed=false;
function measure(){
 measureFrame=0;if(closed)return;if(!sdk.motion.active){geometryDirty=true;return;}
 const rect=canvas.getBoundingClientRect();left=rect.left;top=rect.top;width=Math.max(1,rect.width);height=Math.max(1,rect.height);dpr=Math.min(devicePixelRatio||1,2);
 const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);if(canvas.width!==pixelWidth)canvas.width=pixelWidth;if(canvas.height!==pixelHeight)canvas.height=pixelHeight;
 geometryDirty=false;if(sdk.motion.reduced)draw(0);
}
function queueMeasure(){geometryDirty=true;if(closed||!sdk.motion.active||measureFrame)return;measureFrame=requestAnimationFrame(measure);}
function move(event){if(closed||!sdk.motion.active||sdk.motion.reduced||event.pointerType==='touch')return;pointerX=Math.max(-width*.3,Math.min(width*1.3,event.clientX-left));pointerY=Math.max(-height*.3,Math.min(height*1.3,event.clientY-top));inside=true;}
function leave(event){if(!event||event.relatedTarget==null)inside=false;}
function draw(time){
 if(closed||!sdk.motion.active)return;
 const reduced=sdk.motion.reduced,t=reduced?0:time/5200,delta=Math.min(48,Math.max(8,time-last||16.7));last=time;
 const ease=1-Math.exp(-delta/150),pullEase=1-Math.exp(-delta/180);engagement+=(inside&&!reduced?1-engagement:-engagement)*ease;
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
 const reach=Math.min(width,height)*.7,parallaxX=(pointerX-width*.5)*.018,parallaxY=(pointerY-height*.5)*.018;
 for(let i=0;i<nodes.length;i++){
  const node=nodes[i],baseX=width*(.08+node.u*.84)+Math.sin(t+node.phase)*width*.012,baseY=height*(.12+node.v*.76)+Math.cos(t*.8+node.phase)*height*.018;
  const vx=pointerX-baseX,vy=pointerY-baseY,distance=Math.hypot(vx,vy),proximity=Math.max(0,1-distance/reach),influence=proximity*proximity*(3-2*proximity)*engagement;
  const targetX=reduced?0:Math.max(-24,Math.min(24,vx*.12*influence+parallaxX*engagement));
  const targetY=reduced?0:Math.max(-18,Math.min(18,vy*.12*influence+parallaxY*engagement));
  node.dx+=(targetX-node.dx)*pullEase;node.dy+=(targetY-node.dy)*pullEase;node.heat+=(influence-node.heat)*ease;
  if(reduced){node.dx=0;node.dy=0;node.heat=0;}node.x=baseX+node.dx;node.y=baseY+node.dy;
 }
 const limit=Math.min(width,height)*.4;ctx.strokeStyle=lineColor;ctx.lineWidth=.85;
 for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
  const a=nodes[i],b=nodes[j],distance=Math.hypot(a.x-b.x,a.y-b.y);if(distance>=limit)continue;
  ctx.globalAlpha=(1-distance/limit)*((dark?.58:.48)+(a.heat+b.heat)*.18);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
 }
 for(let i=0;i<nodes.length;i++){
  const node=nodes[i];if(node.heat>.08){ctx.globalAlpha=node.heat*.12;ctx.fillStyle=dotColor;ctx.beginPath();ctx.arc(node.x,node.y,7+node.heat*7,0,Math.PI*2);ctx.fill();}
  ctx.globalAlpha=(dark?.82:.72)+node.heat*.18;ctx.fillStyle=dotColor;ctx.beginPath();ctx.arc(node.x,node.y,node.radius+node.heat*.8,0,Math.PI*2);ctx.fill();
  if(i%7)continue;const radius=9+Math.sin(t+i)*1.6+node.heat*2;ctx.beginPath();
  for(let k=0;k<6;k++){const x=node.x+hexX[k]*radius,y=node.y+hexY[k]*radius;k?ctx.lineTo(x,y):ctx.moveTo(x,y);}
  ctx.closePath();ctx.globalAlpha=(dark?.64:.55)+node.heat*.3;ctx.strokeStyle=dotColor;ctx.lineWidth=1.15;ctx.stroke();
 }
 ctx.globalAlpha=1;
}
const observer=new ResizeObserver(queueMeasure);observer.observe(canvas);measure();
const unsubscribe=sdk.motion.subscribe(({active,reduced})=>{if(!active||reduced){inside=false;engagement=0;for(let i=0;i<nodes.length;i++){nodes[i].dx=0;nodes[i].dy=0;nodes[i].heat=0;}}if(active){last=0;if(geometryDirty)measure();if(reduced)draw(0);}});
const stop=sdk.motion.frame(draw,{fps:30});
addEventListener('pointermove',move,{passive:true});addEventListener('pointerout',leave,{passive:true});addEventListener('blur',leave);addEventListener('resize',queueMeasure,{passive:true});addEventListener('scroll',queueMeasure,{passive:true,capture:true});
addEventListener('pagehide',()=>{closed=true;stop();unsubscribe();observer.disconnect();if(measureFrame)cancelAnimationFrame(measureFrame);removeEventListener('pointermove',move);removeEventListener('pointerout',leave);removeEventListener('blur',leave);removeEventListener('resize',queueMeasure);removeEventListener('scroll',queueMeasure,true);},{once:true});
})();`;
