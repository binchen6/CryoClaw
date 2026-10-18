"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const {promisify}=require("node:util"),{execFile}=require("node:child_process");
const helper=path.resolve(__dirname,"../builtin-skills/cryoclaw-theme-studio/scripts/theme-client.mjs");
async function fixture(run){
  const prefix=path.join(os.tmpdir(),"cryoclaw-theme-client-"),root=await fs.mkdtemp(prefix);
  try{await run(root);}finally{assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));await fs.rm(root,{recursive:true,force:true});}
}
const execute=root=>promisify(execFile)(process.execPath,[helper,"inspect"],{env:{...process.env,OPENCLAW_STATE_DIR:root},windowsHide:true,timeout:10000});
test("theme helper retries transient control failures and keeps bearer credentials private",()=>fixture(async root=>{
  let requests=0;const server=http.createServer((request,response)=>{requests++;assert.equal(request.headers.authorization,"Bearer fixture-private-value");request.resume();response.writeHead(requests===1?503:200,{"content-type":"application/json"});response.end(JSON.stringify(requests===1?{ok:false,error:"window preparing"}:{ok:true,result:{preview:false}}));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{await fs.writeFile(path.join(root,"cryoclaw.config.json"),"\uFEFF"+JSON.stringify({gatewayControl:{port:server.address().port,token:"fixture-private-value"}}));const result=await execute(root);assert.equal(requests,2);assert.equal(JSON.parse(result.stdout).recoveryAttempts,2);assert.ok(!result.stdout.includes("fixture-private-value"));assert.equal(result.stderr,"");}
  finally{await new Promise(resolve=>server.close(resolve));}
}));
test("theme helper does not retry permanent validation failures",()=>fixture(async root=>{
  let requests=0;const server=http.createServer((request,response)=>{requests++;request.resume();response.writeHead(400,{"content-type":"application/json"});response.end(JSON.stringify({ok:false,error:"invalid theme"}));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{await fs.writeFile(path.join(root,"cryoclaw.config.json"),"\uFEFF"+JSON.stringify({gatewayControl:{port:server.address().port,token:"fixture-private-value"}}));await assert.rejects(execute(root),error=>error.stderr.includes("invalid theme") && !error.stderr.includes("fixture-private-value"));assert.equal(requests,1);}
  finally{await new Promise(resolve=>server.close(resolve));}
}));
test("theme helper redacts malformed private configuration from diagnostics",()=>fixture(async root=>{
  await fs.writeFile(path.join(root,"cryoclaw.config.json"),'{"gatewayControl":{"token":"fixture-private-value",broken');
  await assert.rejects(execute(root),error=>error.stderr.includes("configuration could not be read") && !error.stderr.includes("fixture-private-value"));
}));
