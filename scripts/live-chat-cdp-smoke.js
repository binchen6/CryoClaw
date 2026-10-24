// Requires --live: invokes the configured provider and removes its dedicated QA session afterwards.
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {launch,quitLaunchedApp,waitForPageTarget,connect,waitForAppReady,dismissReleaseNotes,sleep,arg}=require('./lib/cdp-harness');
(async()=>{
  if(!process.argv.includes('--live'))throw Error('Add --live to authorize a real provider request in a dedicated QA session');
  const version=require('../package.json').version;
  const exe=arg(process.argv,'--exe',path.resolve('out/win32-x64/win-unpacked/CryoClaw.exe'));
  const attached=process.argv.includes('--attach-port'),port=Number(arg(process.argv,'--attach-port','9243'));
  const running=attached?null:launch(exe,port);let ws,cdp,qaKey;
  try{
    const page=await waitForPageTarget(port);assert.ok(page,'installed app page');
    const conn=await connect(page);ws=conn.ws;cdp=conn.cdp;
    assert.ok(await waitForAppReady(cdp,{timeoutMs:210000}),'gateway connection');
    await dismissReleaseNotes(cdp);
    const key='agent:main:release-smoke-'+Date.now();qaKey=key;
    const nonce='CRYOCLAW_ECHO_'+randomUUID();
    const prompt='这是通信回声检查，不对软件质量作判断。请只逐字回复下一行，不添加解释、不调用工具：\n'+nonce;
    let terminalError=null;
    await cdp.send('Network.enable');
    ws.addEventListener('message',event=>{
      try{const message=JSON.parse(event.data);if(message.method!=='Network.webSocketFrameReceived')return;const frame=JSON.parse(message.params.response.payloadData);if(frame.event==='chat' && frame.payload?.sessionKey===key && frame.payload.state==='error')terminalError=frame.payload.errorMessage??'Gateway reported a terminal chat error';}catch{}
    });
    await cdp.evaluate(`(async()=>{const client=document.querySelector('openclaw-app').client;await client.request('sessions.create',{key:${JSON.stringify(key)},agentId:'main',displayName:${JSON.stringify('Release verification '+version)}},{timeoutMs:90000});await client.request('chat.send',{sessionKey:${JSON.stringify(key)},message:${JSON.stringify(prompt)},deliver:false,idempotencyKey:crypto.randomUUID()},{timeoutMs:90000});return true;})()`,{timeoutMs:185000});
    let reply=false;
    const deadline=Date.now()+120_000;
    while(Date.now()<deadline){
      if(terminalError)throw Error(terminalError);
      const result=await cdp.evaluate(`document.querySelector('openclaw-app').client.request('chat.history',{sessionKey:${JSON.stringify(key)},limit:10},{timeoutMs:45000}).then(r=>({assistant:r.messages?.some(m=>m.role==='assistant'&&m.stopReason!=='error'&&(Array.isArray(m.content)?m.content.filter(c=>c.type==='text').map(c=>c.text??'').join(''):typeof m.content==='string'?m.content:'').trim()===${JSON.stringify(nonce)}),errors:r.messages?.filter(m=>m.stopReason==='error').map(m=>m.errorMessage??'provider error')}))`,{timeoutMs:65000});
      if(result.assistant){reply=true;break;}
      if(result.errors?.length)throw Error(result.errors.join(';'));
      await sleep(1500);
    }
    assert.ok(reply,'real provider reply persisted in chat history');
    assert.equal(cdp.exceptions.length,0);
    console.log(JSON.stringify({targetVersion:version,realMessageReply:true,uniqueNonceEchoPersisted:true,rendererExceptions:0}));
  }finally{if(cdp&&qaKey)await cdp.evaluate(`document.querySelector('openclaw-app').client.request('sessions.delete',{key:${JSON.stringify(qaKey)},agentId:'main',deleteTranscript:true})`).catch(error=>{console.error('QA cleanup failed:',error.message);process.exitCode=1;});if(running)await quitLaunchedApp(running,cdp);ws?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
