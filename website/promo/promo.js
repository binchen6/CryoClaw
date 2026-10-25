(async () => {
  'use strict';
  const $ = id => document.getElementById(id);
  const [film, targets] = await Promise.all(['film.json','screens/targets.json'].map(async url => {
    const response=await fetch(url);if(!response.ok)throw new Error(`Missing film asset: ${url}`);return response.json();
  }));
  const clamp=x=>Math.max(0,Math.min(1,x));
  const ease=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  const enter=(t,start,length=.4)=>ease((t-start)/length);
  const mix=(a,b,p)=>a+(b-a)*p;
  const move=(el,opacity,x=0,y=0,scale=1)=>{el.style.opacity=opacity;el.style.transform=`translate3d(${x}px,${y}px,0) scale(${scale})`;};
  const layers=new Map();
  const addImage=(id,path)=>{const img=new Image();img.src=path;img.className='screen';img.alt=id;layers.set(id,img);$('screen-stack').append(img);};
  film.scenes.forEach(scene=>addImage(scene.id,`screens/${scene.id}.jpg`));
  for(let i=0;i<film.drag.samples;i++)addImage(`radius-${i}`,`screens/radius-${String(i).padStart(2,'0')}.jpg`);
  film.chapters.forEach((chapter,index)=>{const item=document.createElement('span');item.innerHTML=`<b>${String(index+1).padStart(2,'0')}</b>${chapter.label}`;$('chapter-track').append(item);});
  const points=Object.fromEntries(Object.entries(targets).map(([key,r])=>[key,{x:r.cx*1.2,y:r.cy*1.2,width:r.width*1.2,height:r.height*1.2,left:r.x*1.2,top:r.y*1.2}]));
  // Cursor coordinates share the camera's coordinate system with the captured controls.
  const knob=value=>({x:points.radius.left+7+(points.radius.width-14)*value/96,y:points.radius.y});
  const actions=[
    {start:.65,arrive:1.55,end:3.2,key:'defaultModel',click:1.95,label:'设为默认',bow:-32},
    {start:7,arrive:7.78,end:10,key:'editFile',click:8.05,label:'编辑文件',bow:26},
    {start:10.55,arrive:11.25,end:12.05,key:'graphite',click:11.55,label:'石墨主题',bow:-26},
    {start:12.05,arrive:12.5,end:14,key:'darkMode',click:12.75,label:'深色外观',from:'graphite',bow:22},
    {start:14.65,arrive:15.15,end:17.55,key:'radius',label:'拖动，实时预览',bow:-22,drag:true}
  ];
  const cursorPoint=(action,t)=>{
    const to=action.drag?knob(film.drag.from):points[action.key];
    const from=action.from?points[action.from]:{x:Math.max(80,to.x-190),y:Math.min(710,to.y+75)};
    if(action.drag&&t>=film.drag.start){const p=ease((t-film.drag.start)/(film.drag.end-film.drag.start));return knob(mix(film.drag.from,film.drag.to,p));}
    const p=ease((t-action.start)/(action.arrive-action.start)),q=1-p;
    const c1={x:from.x+(to.x-from.x)*.32,y:from.y+action.bow};
    const c2={x:to.x-(to.x-from.x)*.22,y:to.y+action.bow};
    return {x:q*q*q*from.x+3*q*q*p*c1.x+3*q*p*p*c2.x+p*p*p*to.x,y:q*q*q*from.y+3*q*q*p*c1.y+3*q*p*p*c2.y+p*p*p*to.y};
  };
  let lastChapter=-1;
  window.renderFrame=t=>{
    t=Math.max(0,Math.min(film.duration,t));
    const chapterIndex=Math.max(0,film.chapters.findLastIndex(c=>t>=c.start));
    const chapter=film.chapters[chapterIndex],out=enter(t,film.outro,.65);
    if(lastChapter!==chapterIndex){$('chapter').textContent=`${String(chapterIndex+1).padStart(2,'0')} / ${chapter.label}`;$('headline').innerHTML=chapter.title;$('description').textContent=chapter.description;lastChapter=chapterIndex;}
    [...$('chapter-track').children].forEach((el,i)=>{el.classList.toggle('active',i===chapterIndex);el.classList.toggle('done',i<chapterIndex);});
    move($('story'),enter(t,chapter.start,.4)*(1-out),0,10*(1-enter(t,chapter.start,.4))-12*out);
    const intro=enter(t,0,.65);move($('window'),intro*(1-out),0,24*(1-intro)+16*out,.992+.008*intro-.012*out);
    for(const img of layers.values())img.style.opacity=0;
    const index=Math.max(0,film.scenes.findLastIndex(scene=>t>=scene.start)),scene=film.scenes[index];
    const samePage=index>0&&((scene.id.startsWith('models')&&film.scenes[index-1].id.startsWith('models'))||scene.id==='workspace-edit'||scene.id==='theme-graphite'||scene.id==='theme-tuned');
    const fade=index?enter(t,scene.start,samePage?.18:.48):1;
    if(index>0)layers.get(film.scenes[index-1].id).style.opacity=1;
    layers.get(scene.id).style.opacity=fade;
    let dragValue=null;
    if(t>=film.drag.start&&t<16.65){
      const progress=ease((t-film.drag.start)/(film.drag.end-film.drag.start))*(film.drag.samples-1),a=Math.floor(progress),b=Math.min(a+1,film.drag.samples-1);
      for(const img of layers.values())img.style.opacity=0;
      layers.get(`radius-${a}`).style.opacity=1;layers.get(`radius-${b}`).style.opacity=a===b?1:progress-a;
      dragValue=mix(film.drag.from,film.drag.to,progress/(film.drag.samples-1));
    }
    // One subtle camera push; the cursor and imagery move together, so clicks stay aligned.
    const zoom=1+.009*enter(t,14.4,1.7);$('camera').style.transformOrigin='85% 72%';$('camera').style.transform=`scale(${zoom})`;
    const action=actions.findLast(a=>t>=a.start&&t<a.end);
    let pointer=null;
    if(action){
      pointer=cursorPoint(action,t);const previous=cursorPoint(action,t-.008),velocity=pointer.x-previous.x;
      const visible=(action.from?1:enter(t,action.start,.22))*(action.key==='graphite'?1:1-enter(t,action.end-.22,.22))*(1-out);
      const clickAge=action.click===undefined?-1:t-action.click;
      const isDragging=Boolean(action.drag&&t>=film.drag.start&&t<=film.drag.end);
      let scale=isDragging?.94:1;
      if(clickAge>=0&&clickAge<.24)scale=1-.14*Math.sin(Math.PI*clickAge/.24);
      const cursor=$('cursor');cursor.classList.toggle('dragging',isDragging);cursor.style.opacity=visible;
      cursor.style.transform=`translate3d(${pointer.x-(isDragging?9:2)}px,${pointer.y-2}px,0) rotate(${Math.max(-3,Math.min(3,velocity*.55))}deg) scale(${scale})`;
      $('cursor-halo').style.opacity=isDragging?.65:enter(t,action.arrive-.1,.25)*.26;
      const label=isDragging?`圆角 ${Math.round(dragValue??film.drag.to)} px`:t>film.drag.end&&action.drag?'36 px · 已实时应用':action.label;
      $('cursor-label').textContent=label;
      move($('cursor-label'),visible*enter(t,action.arrive-.1,.2)*.94,Math.max(8,Math.min(1510,pointer.x+22)),Math.min(742,pointer.y+30));
      const p=points[action.key];
      const highlight=enter(t,action.arrive-.1,.2)*visible*.7;
      const focus=$('focus-outline');focus.style.opacity=highlight;focus.style.left=`${p.left-4}px`;focus.style.top=`${p.top-4}px`;focus.style.width=`${p.width+8}px`;focus.style.height=`${p.height+8}px`;
    }else{for(const id of ['cursor','cursor-label','focus-outline'])$(id).style.opacity=0;}
    for(const [id,delay] of [['click-wave',0],['click-core',.055]]){
      const click=actions.find(a=>a.click!==undefined&&t>=a.click+delay&&t<a.click+delay+.48),wave=$(id);
      if(click){const p=points[click.key],age=(t-click.click-delay)/.48;move(wave,(1-age)**2*.8,p.x-22,p.y-22,.25+ease(age)*1.1);}else wave.style.opacity=0;
    }
    const results=t>=1.95&&t<3.3?'✓ 默认模型已切换':t>=8.05&&t<10.1?'✓ 草稿已在本机暂存':t>=16.45&&t<17.8?'✓ 圆角 12 → 36 px':null;
    $('result-pill').textContent=results??'';move($('result-pill'),results?enter(t,t<3.3?1.95:t<10.1?8.05:16.45,.25):0,0,0);
    const end=enter(t,film.outro+.08,.65);move($('end-card'),end,0,22*(1-end),.992+.008*end);
    $('footer-copy').textContent=t>=film.outro?'内置运行环境。连接模型，即可开始。':'真实软件页面 · 真实控件操作 · 演示数据';
    $('timeline-fill').style.width=`${t/film.duration*100}%`;
    window.promoFrameState={time:t,scene:scene.id,action:action?.key??null,cursor:pointer,dragValue};
  };
  const fit=()=>{$('film').style.transform=`scale(${Math.min(innerWidth/1920,innerHeight/1080)})`;};
  addEventListener('resize',fit);fit();
  // Serial decoding avoids a large parallel decoder memory spike for the 25 drag samples.
  for(const img of document.images){try{await img.decode();}catch{throw new Error(`Cannot decode film image: ${img.src}`);}}
  window.renderFrame(0);window.promoReady=true;window.promoConfig=film;window.promoTargets=points;
  if(!new URLSearchParams(location.search).has('render')){
    if(matchMedia('(prefers-reduced-motion:reduce)').matches)window.renderFrame(19.5);
    else{let start;const loop=now=>{start??=now;window.renderFrame(Math.min((now-start)/1000,film.duration));if(now-start<film.duration*1000)requestAnimationFrame(loop);};requestAnimationFrame(loop);}
  }
})();
