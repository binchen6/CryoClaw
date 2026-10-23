"use strict";
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {sleep}=require('./cdp-harness');

/** Two bounded provider requests in a dedicated QA session. Stores metrics only. */
async function verifyLiveDeliverables(cdp,out,{reuseHistory}={}){
  const saved=reuseHistory?JSON.parse(fs.readFileSync(reuseHistory,'utf8')):null;
  const key=saved?.sessionKey??'agent:main:deliverables-live-qa-'+Date.now(),file=saved?.messages?.find(m=>m.customType==='openclaw.nested-tool.v1')?.content?.find(c=>c.type==='toolCall'&&c.name==='cryoclaw_deliver_files')?.arguments?.files?.[0]?.path??path.join(out,'live-deliverable.txt');
  if(!saved)fs.writeFileSync(file,'CryoClaw native tool delivery verification.\n');
  const request=(method,params)=>cdp.evaluate(`document.querySelector('openclaw-app').client.request(${JSON.stringify(method)},${JSON.stringify(params)},{timeoutMs:90000})`,{timeoutMs:95000});
  if(!saved)await request('sessions.create',{key,agentId:'main',displayName:'Release QA · native deliverables & cache'});
  const timings=[];let turn=0;
  for(const message of saved?[]:[
    `仅做桌面交付插件验收。文件已经存在，禁止创建、修改或读取文件正文。必须调用 cryoclaw_deliver_files 工具一次，files=[{"path":${JSON.stringify(file)},"title":"真实模型交付验收"}]。工具完成后，最终回复仅输出以下文字协议行（用于兼容验收）：\nMEDIA:"${file}"`,
    '请确认上次交付完成，只回复 CRYOCLAW_CACHE_QA_OK，不调用工具。',
  ]){
    const start=Date.now(),expected=turn++===0?'MEDIA:':'CRYOCLAW_CACHE_QA_OK';
    await request('chat.send',{sessionKey:key,message,deliver:false,idempotencyKey:require('node:crypto').randomUUID()});
    const deadline=Date.now()+180000;let history;
    while(Date.now()<deadline){
      history=await request('chat.history',{sessionKey:key,limit:30});
      const messages=history.messages??[],lastUser=messages.findLastIndex(m=>m.role==='user'),tail=messages.slice(lastUser+1);
      const error=tail.find(m=>m.stopReason==='error');if(error)throw Error(error.errorMessage??'Provider error');
      if(tail.some(m=>m.role==='assistant'&&m.stopReason==='stop'&&Array.isArray(m.content)&&m.content.some(c=>c.type==='text'&&c.text?.includes(expected))))break;
      await sleep(1500);
    }
    const messages=history?.messages??[],tail=messages.slice(messages.findLastIndex(m=>m.role==='user')+1);
    assert.ok(tail.some(m=>m.role==='assistant'&&m.stopReason==='stop'&&Array.isArray(m.content)&&m.content.some(c=>c.type==='text'&&c.text?.includes(expected))),'real model turn completed with expected final reply');
    timings.push({elapsedMs:Date.now()-start,usage:tail.filter(m=>m.role==='assistant').map(m=>({model:m.model,usage:m.usage}))});
  }
  const history=await request('chat.history',{sessionKey:key,limit:30});
  fs.writeFileSync(path.join(out,'live-qa-transcript.json'),JSON.stringify(history,null,2));
  const receipt=m=>{
    if(m.role==='custom'&&m.customType==='openclaw.nested-tool.v1'){
      if(m.details?.toolName==='cryoclaw_deliver_files')return m.details.result?.details;
      const call=m.content?.find(b=>b.type==='toolCall'&&b.name==='cryoclaw_deliver_files');
      const result=m.content?.find(b=>b.type==='toolResult'&&b.toolCallId===call?.id&&b.toolName===call?.name&&b.isError===false);
      if(result?.details?.cryoclawDeliverables)return result.details;
      if(call&&result)return {cryoclawDeliverables:{files:call.arguments?.files}};
    }
    return m.role==='toolResult'&&m.toolName==='cryoclaw_deliver_files'?m.details:null;
  };
  assert.ok(history.messages.some(m=>receipt(m)?.cryoclawDeliverables?.files?.some(f=>f.path===file)),'model invoked native delivery tool and receipt persisted');
  assert.ok(history.messages.some(m=>m.customType==='openclaw.nested-tool.v1'&&m.content?.some(b=>b.type==='toolResult'&&b.toolName==='cryoclaw_deliver_files'&&b.details?.cryoclawDeliverables?.files?.some(f=>f.path===file&&Number.isFinite(f.size)))),'public history retains the bounded native receipt');
  await cdp.evaluate("document.querySelector('oc-rail').props.onOpenChat()");
  const navigationDeadline=Date.now()+10000;
  while(!await cdp.evaluate("!!document.querySelector('oc-session-panel')")){
    assert.ok(Date.now()<navigationDeadline,'chat panel mounted');await sleep(100);
  }
  await cdp.evaluate(`document.querySelector('oc-session-panel').props.onSelectSession(${JSON.stringify(key)})`);
  const deadline=Date.now()+30000;let cards=0;
  do{cards=await cdp.evaluate(`(()=>{const a=document.querySelector('openclaw-app');return a.sessionKey===${JSON.stringify(key)}&&!a.chatLoading?document.querySelectorAll('.chat-group.assistant .chat-file-card').length:0;})()`);if(cards===1)break;await sleep(250);}while(Date.now()<deadline);
  assert.equal(cards,1,'persisted plugin result and legacy text display exactly one card');
  assert.equal(await cdp.evaluate("document.querySelectorAll('.chat-group.user .chat-file-card').length"),1,'the user file reference remains visible');
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('.chat-group-model')].some(el=>el.textContent==='gateway-injected')"),false,'native supplement must not replace the provider model label');
  const first=await request('cryoclaw.context.inspect',{}),second=await request('cryoclaw.context.inspect',{});
  for(const name of ['officecli-docx','officecli-pptx','officecli-xlsx','cryoclaw-theme-studio','openclaw-and-cryoclaw-manual'])assert.ok(first.skills?.some(row=>row.name===name),'context diagnostic includes bundled skill '+name);
  assert.equal(first.catalogueDigest,second.catalogueDigest,'unchanged context asset fingerprint remains stable');
  const report={realModelDelivery:true,persistedReceipt:true,singleCard:true,userReferencePreserved:true,contextFingerprintStable:true,requests:saved?0:2,reusedPersistedModelSession:!!saved,timings,
    ...(saved?{persistedUsage:history.messages.filter(m=>m.role==='assistant'&&m.provider!=='openclaw').map(m=>({model:m.model,usage:m.usage}))}:{})};
  fs.writeFileSync(path.join(out,'live-provider-report.json'),JSON.stringify(report,null,2));return report;
}
module.exports={verifyLiveDeliverables};
