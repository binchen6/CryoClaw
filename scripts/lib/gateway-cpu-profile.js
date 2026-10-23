"use strict";
const fs=require("node:fs"),path=require("node:path"),{execFile}=require("node:child_process"),{promisify}=require("node:util");
const run=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Profiles only a verified child of this QA launch; never attaches to another debugger target. */
async function profileGatewayChild(parentPid,out,{delayMs=40000,durationMs=30000,nativeNodeBin}={}){
  if(!Number.isSafeInteger(parentPid)||parentPid<=0)throw Error("Invalid QA parent PID");
  await sleep(delayMs);
  const command=`Get-CimInstance Win32_Process -Filter "Name='CryoClaw Helper.exe' OR Name='node.exe'" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{Name='Gateway';Expression={$_.CommandLine -match 'gateway run'}} | ConvertTo-Json -Compress`;
  const {stdout}=await run("powershell.exe",["-NoProfile","-Command",command],{windowsHide:true,timeout:10000});
  const parsed=JSON.parse(stdout),rows=Array.isArray(parsed)?parsed:[parsed],owned=new Set([parentPid]);
  for(let pass=0;pass<rows.length;pass++)for(const row of rows)if(owned.has(row.ParentProcessId))owned.add(row.ProcessId);
  const gateways=rows.filter(row=>owned.has(row.ProcessId)&&row.Gateway);
  const leaves=gateways.filter(row=>!gateways.some(other=>other.ParentProcessId===row.ProcessId));
  if(leaves.length!==1||!Number.isSafeInteger(leaves[0].ProcessId))throw Error("Actual QA gateway descendant was not uniquely identified");
  const selected=leaves[0];
  if(selected.Name.toLowerCase()==='node.exe' && (!nativeNodeBin || path.resolve(selected.ExecutablePath).toLowerCase()!==path.resolve(nativeNodeBin).toLowerCase()))throw Error('Native gateway executable did not match this installation');
  const pid=selected.ProcessId;process._debugProcess(pid);
  let target;
  for(let n=0;n<20&&!target;n++){
    try{const rows=await (await fetch("http://127.0.0.1:9229/json/list",{signal:AbortSignal.timeout(1000)})).json();target=rows.find(row=>row.webSocketDebuggerUrl);}catch{}
    if(!target)await sleep(250);
  }
  if(!target)throw Error("Gateway inspector did not become available");
  const owner=await run("powershell.exe",["-NoProfile","-Command","Get-NetTCPConnection -State Listen -LocalPort 9229 | Select-Object -ExpandProperty OwningProcess -Unique"],{windowsHide:true,timeout:10000});
  if(owner.stdout.trim()!==String(pid))throw Error("Inspector belongs to another process; refusing to profile");
  const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let sequence=0;
  await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
  ws.addEventListener("message",event=>{const frame=JSON.parse(event.data),request=pending.get(frame.id);if(!request)return;pending.delete(frame.id);clearTimeout(request.timer);frame.error?request.reject(Error(frame.error.message)):request.resolve(frame.result);});
  ws.addEventListener("close",()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error("Gateway inspector closed"));}pending.clear();});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`Inspector deadline: ${method}`));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  try{
    const identity=await send("Runtime.evaluate",{expression:"process.pid",returnByValue:true});if(identity.result?.value!==pid)throw Error("Inspector process identity changed");
    await send("Profiler.enable");await send("Profiler.setSamplingInterval",{interval:1000});await send("Profiler.start");await sleep(durationMs);
    const {profile}=await send("Profiler.stop");const file=path.join(out,"gateway-startup.cpuprofile");fs.writeFileSync(file,JSON.stringify(profile));
    const nodes=new Map(profile.nodes.map(node=>[node.id,node])),totals=new Map();
    for(let n=0;n<(profile.samples??[]).length;n++){const id=profile.samples[n];totals.set(id,(totals.get(id)??0)+(profile.timeDeltas?.[n]??1000));}
    const hotspots=[...totals].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([id,micros])=>({function:nodes.get(id)?.callFrame.functionName||"anonymous",file:path.basename(nodes.get(id)?.callFrame.url||"native"),line:(nodes.get(id)?.callFrame.lineNumber??-1)+1,selfMs:Math.round(micros/1000)}));
    const report={pid,durationMs,file,hotspots};fs.writeFileSync(path.join(out,"gateway-cpu-summary.json"),JSON.stringify(report,null,2));return report;
  }finally{ws.close();}
}
module.exports={profileGatewayChild};
