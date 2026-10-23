const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{sleep}=require('./cdp-harness');
async function verifyLiveDashboard(cdp,out,boardId){
  const key='agent:main:dashboard-live-qa-'+Date.now(),nonce='DASHBOARD_QA_'+randomUUID().slice(0,8),cardId='model-qa';
  const request=(method,params)=>cdp.evaluate(`document.querySelector('openclaw-app').client.request(${JSON.stringify(method)},${JSON.stringify(params)},{timeoutMs:90000})`,{timeoutMs:95000});
  await request('sessions.create',{key,agentId:'main',displayName:'Release QA · model dashboard'});
  await request('chat.send',{sessionKey:key,deliver:false,idempotencyKey:randomUUID(),message:`执行独立仪表盘验收。必须调用 cryoclaw_dashboard 工具 action=publish_card，boardId=${boardId}，cardId=${cardId}，title=真实模型看板，html 为一个简洁美观的自包含页面，标题包含 ${nonce}，增加一个点击后能改变文字的按钮。不创建新看板，不读写其他文件。工具成功后只回复 ${nonce}。`});
  const until=Date.now()+180000;let history;
  do{history=await request('chat.history',{sessionKey:key,limit:20});const tail=history.messages.slice(history.messages.findLastIndex(m=>m.role==='user')+1);const error=tail.find(m=>m.stopReason==='error');if(error)throw Error(error.errorMessage);if(tail.some(m=>m.role==='assistant'&&m.stopReason==='stop'&&m.content?.some(c=>c.type==='text'&&c.text?.includes(nonce))))break;await sleep(1500);}while(Date.now()<until);
  assert.ok(history.messages.some(m=>m.role==='assistant'&&m.stopReason==='stop'&&m.content?.some(c=>c.type==='text'&&c.text?.includes(nonce))),'real model final confirmation persisted');
  assert.ok(history.messages.some(m=>m.role!=='user'&&m.content?.some(c=>c.type==='toolCall'&&c.name==='cryoclaw_dashboard')),'model native dashboard invocation persisted');
  const result=await request('cryoclaw.dashboards.list',{}),board=result.boards.find(b=>b.id===boardId);assert.ok(board?.cards.some(c=>c.id===cardId),'real model published a native card');
  const record={sessionKey:key,boardId,cardId,nonce,realModelPublication:true,usage:history.messages.filter(m=>m.role==='assistant'&&m.provider!=='openclaw').map(m=>({model:m.model,usage:m.usage}))};fs.writeFileSync(path.join(out,'live-dashboard-report.json'),JSON.stringify(record,null,2));return record;
}
module.exports={verifyLiveDashboard};
