export const crystalFieldStyle = `<style>
.cryo-field{position:absolute;right:1%;top:4%;width:55%;height:92%;pointer-events:none;opacity:.72}
.section .cryo-field{right:2%;top:50%;width:43%;height:88%;transform:translateY(-50%);opacity:.58}
@media(max-width:700px){.cryo-field{right:-12%;opacity:.28}.section .cryo-field{right:-8%;opacity:.3}}
</style>`;

export const crystalFieldScript = `(()=>{
const canvas=document.querySelector('.cryo-field'),sdk=window.cryoclawDashboard;if(!canvas||!sdk?.motion)return;
const ctx=canvas.getContext('2d');if(!ctx)return;
const dark=!!document.querySelector('.ink'),nodes=Array.from({length:32},(_,i)=>({x:(i%8)/7,y:Math.floor(i/8)/3,phase:i*.83,radius:1.8+(i%4)*.55}));
function draw(time){
 const dpr=Math.min(devicePixelRatio||1,2),width=Math.max(1,Math.round(canvas.clientWidth*dpr)),height=Math.max(1,Math.round(canvas.clientHeight*dpr));
 if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 const w=width/dpr,h=height/dpr,t=sdk.motion.reduced?0:time/5200;
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
 const placed=nodes.map(n=>({x:w*(.08+n.x*.84)+Math.sin(t+n.phase)*w*.012,y:h*(.12+n.y*.76)+Math.cos(t*.8+n.phase)*h*.018,radius:n.radius}));
 const limit=Math.min(w,h)*.4;
 for(let i=0;i<placed.length;i++)for(let j=i+1;j<placed.length;j++){
  const a=placed[i],b=placed[j],distance=Math.hypot(a.x-b.x,a.y-b.y);if(distance>=limit)continue;
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=dark?'rgba(157,220,255,'+(1-distance/limit)*.58+')':'rgba(22,138,255,'+(1-distance/limit)*.48+')';ctx.lineWidth=.85;ctx.stroke();
 }
 for(const [i,p] of placed.entries()){
  ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fillStyle=dark?'rgba(197,235,255,.82)':'rgba(22,138,255,.72)';ctx.fill();
  if(i%7)continue;const radius=9+Math.sin(t+i)*1.6;ctx.beginPath();
  for(let k=0;k<6;k++){const angle=Math.PI/3*k-Math.PI/6,x=p.x+Math.cos(angle)*radius,y=p.y+Math.sin(angle)*radius;k?ctx.lineTo(x,y):ctx.moveTo(x,y);}
  ctx.closePath();ctx.strokeStyle=dark?'rgba(211,241,255,.64)':'rgba(22,138,255,.55)';ctx.lineWidth=1.15;ctx.stroke();
 }
}
sdk.motion.frame(draw,{fps:24});
})();`;
