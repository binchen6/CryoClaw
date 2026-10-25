'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {analyzeTrace}=require('./dashboard-morph-cdp-smoke');

function sample(phase,values={}){
 return {phase,reason:'raf',t:0,morphing:false,topLayer:false,cardSame:true,cardConnected:true,iframeSame:true,iframeWindowSame:true,iframeSrcSame:true,frameLoads:0,visible:true,hitCard:true,contentVisible:true,rect:{x:30,y:100,width:400,height:300},scrollTop:420,
  style:{card:{boxShadow:'rgba(0, 0, 0, .1) 0px 8px 24px',radii:['16px','16px','16px','16px'],overflowX:'hidden',overflowY:'hidden'},slot:{contain:'none',contentVisibility:'visible',overflowX:'visible',overflowY:'visible'}},...values};
}
function validTrace(){return {id:'notes',mode:'normal',hasFrame:true,expectedExpanded:false,samples:[
 sample('close',{reason:'beforeAction',topLayer:true}),
 sample('close',{t:16,morphing:true,topLayer:true,rect:{x:40,y:40,width:900,height:700}}),
 sample('close',{t:250,morphing:true,topLayer:true}),
 sample('close',{t:280,reason:'settled'}),
 ],documentPreserved:true};}

test('closing may leave the top layer only after its final active animation frame',()=>{
 assert.deepEqual(analyzeTrace(validTrace()).issues,[]);
 const broken=validTrace();broken.samples[2].topLayer=false;
 assert.ok(analyzeTrace(broken).issues.includes('closeLeftTopLayerEarly'));
});
test('frame replacement, reloads and a temporarily hidden frame fail continuity checks',()=>{
 for(const [key,value,issue] of [['iframeSame',false,'iframeIdentityChanged'],['iframeWindowSame',false,'iframeWindowChanged'],['iframeSrcSame',false,'iframeSourceChanged'],['frameLoads',1,'iframeReloaded'],['contentVisible',false,'contentDisappeared']]){
  const trace=validTrace();trace.samples[1][key]=value;
  assert.ok(analyzeTrace(trace).issues.includes(issue),key);
 }
});
test('a close must restore scroll and geometry without leaving a popover behind',()=>{
 const trace=validTrace();trace.samples[0].rect={...trace.samples.at(-1).rect};
 trace.originRect={...trace.samples.at(-1).rect};trace.originScrollTop=420;
 assert.deepEqual(analyzeTrace(trace).issues,[]);
 trace.samples.at(-1).scrollTop=0;trace.samples.at(-1).topLayer=true;
 trace.samples.at(-1).rect.width+=30;
 const {issues}=analyzeTrace(trace);
 for(const issue of ['scrollNotRestored','geometryNotRestored','topLayerNotClosed'])assert.ok(issues.includes(issue));
});
test('slot paint containment and square unclipped card corners are reported',()=>{
 const trace=validTrace();trace.samples.at(-1).style.slot.contentVisibility='auto';
 trace.samples.at(-1).style.card.radii=['0px','0px','0px','0px'];
 const {issues}=analyzeTrace(trace);
 assert.ok(issues.includes('slotClipsCardShadow'));assert.ok(issues.includes('cardCornersNotRounded'));
});
test('reduced motion must settle without starting the morph animation',()=>{
 const trace=validTrace();trace.mode='reduced';
 assert.ok(analyzeTrace(trace).issues.includes('reducedMotionAnimated'));
 for(const entry of trace.samples)entry.morphing=false;
 assert.deepEqual(analyzeTrace(trace).issues,[]);
});
test('a native system card is checked without inventing an iframe requirement',()=>{
 const trace=validTrace();trace.hasFrame=false;
 for(const entry of trace.samples){entry.iframeSame=false;entry.iframeWindowSame=false;entry.iframeSrcSame=false;}
 assert.deepEqual(analyzeTrace(trace).issues,[]);
});
