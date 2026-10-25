/* Synchronous GSAP timeline; media timing is read from the source HTML. */
(() => {
  'use strict';
  const duration=Number(document.getElementById('film').dataset.duration);
  const scenes=[...document.querySelectorAll('.scene')].map(scene=>[scene.id,Number(scene.dataset.sceneStart??scene.querySelector('video')?.dataset.start??0)]);
  const startOf=id=>scenes.find(scene=>scene[0]===id)[1];
  const tl=gsap.timeline({paused:true});
  scenes.forEach(([id,start],index)=>{
    const scene=document.getElementById(id),bold=['models','templates','microadjust'].includes(id);
    if(index){
      const transition=id==='outro'?.56:bold?.48:.36;
      // The transition carries the outgoing scene while the next view arrives.
      tl.to(`#${scenes[index-1][0]}`,{opacity:0,x:bold?-52:-26,scale:bold?.97:.99,duration:transition,ease:'power2.inOut'},start);
      tl.fromTo(scene,{opacity:0,x:bold?76:34,scale:bold?1.065:1.018},{opacity:1,x:0,scale:1,duration:transition,ease:bold?'expo.out':'sine.out',immediateRender:false},start);
    }
    const base=start+.1;
    if(scene.classList.contains('cover-scene')){
      [...scene.querySelector('.scene-content').children].forEach((element,i)=>{
        const headline=/^H[12]$/.test(element.tagName),brand=element.classList.contains('cover-brand');
        tl.from(element,{x:headline?72:brand?0:-20,y:brand?22:0,scale:brand?.72:headline?.94:1,rotation:brand?-4:0,opacity:0,duration:brand?.64:headline?.58:.36,ease:brand?'back.out(1.7)':headline?'expo.out':'sine.out'},base+i*.055);
      });
    }else{
      const marker=document.createElement('span');marker.className='scene-marker';marker.textContent=String(index).padStart(2,'0');marker.setAttribute('data-layout-ignore','');scene.append(marker);
      tl.from(marker,{x:54,scale:.72,opacity:0,duration:.62,ease:'back.out(1.5)'},base);
      tl.from(scene.querySelector('.eyebrow'),{x:-16,opacity:0,duration:.25,ease:'power2.out'},base);
      tl.from(scene.querySelector('h2'),{x:index%2?-24:24,y:8,opacity:0,duration:.5,ease:'expo.out'},base+.025);
      tl.from(scene.querySelector('p'),{y:12,opacity:0,duration:.4,ease:'sine.out'},base+.09);
      tl.from(scene.querySelector('.source-badge'),{x:18,opacity:0,duration:.28,ease:'circ.out'},base+.12);
      tl.from(scene.querySelector('.product-frame'),{y:28,scale:.94,opacity:0,duration:.52,ease:'back.out(1.12)'},base+.035);
      const note=scene.querySelector('.action-note');
      if(note)tl.from(note,{y:8,opacity:0,duration:.3,ease:'power1.out'},base+.22);
    }
  });
  // Brief close-ups follow the real UI. Each returns to the full view before the cut.
  const camera=(id,steps)=>steps.forEach(([offset,scale,x,y,length=.7])=>tl.to(`#${id} .camera-move`,{scale,x,y,duration:length,ease:'power2.inOut'},startOf(id)+offset));
  camera('models',[[1,1.08,-24,14,.65],[2.9,1,0,0,.55]]);
  camera('chat',[[1.1,1.10,-30,-12,.8],[4.7,1,0,0,.65]]);
  camera('workspace',[[1.1,1.12,-52,-16,.8],[4.7,1,0,0,.65]]);
  camera('templates',[[1.25,1.10,-30,0,.8],[5.2,1,0,0,.75]]);
  camera('details',[[1.1,1.16,0,0,.75],[4.7,1,0,0,.65]]);
  camera('microadjust',[[1.2,1.12,54,22,.75],[4.4,1.18,-52,-42,.85],[8.5,1,0,0,.75]]);
  tl.from('.masthead',{y:-10,opacity:0,duration:.4,ease:'power2.out'},.1);
  tl.from('.film-footer',{y:8,opacity:0,duration:.4,ease:'sine.out'},.2);
  tl.to('#progress',{scaleX:1,duration,ease:'none'},0);
  tl.to('.paper-light',{x:-35,scale:1.06,duration,ease:'sine.inOut'},0);
  const tokens=getComputedStyle(document.documentElement);
  ['intro','chat','extensions','templates','microadjust','outro'].forEach((id,index)=>{
    [...document.querySelectorAll('.chapter-track span')].forEach((element,i)=>{
      tl.to(element,{color:tokens.getPropertyValue(i===index?'--accent':'--text-secondary').trim(),opacity:1,duration:.3,ease:'sine.inOut'},startOf(id));
    });
  });
  window.__timelines=window.__timelines||{};
  window.__timelines['cryoclaw-latest']=tl;
  window.promoTimeline=tl;
  window.promoDuration=duration;
  window.renderFrame=time=>{const t=Math.max(0,Math.min(duration,time));tl.seek(t,false);return t;};
  window.renderFrame(0);
  window.promoReady=true;
})();
