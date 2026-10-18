import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const [action,file]=process.argv.slice(2);
function readBounded(filename,limit){
  const fd=fs.openSync(filename,"r");
  try{const stat=fs.fstatSync(fd);if(!stat.isFile() || stat.size>limit)throw new Error("File exceeds theme helper limits");
    const data=Buffer.alloc(limit+1);let size=0;while(size<data.length){const read=fs.readSync(fd,data,size,data.length-size,null);if(!read)break;size+=read;}
    if(size>limit)throw new Error("File exceeds theme helper limits");return data.subarray(0,size).toString("utf8");
  }finally{fs.closeSync(fd);}
}
try {
  if(!["inspect","preview","restore"].includes(action))throw new Error("Usage: theme-client.mjs inspect | preview <theme.json> | restore");
  const state=process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),".openclaw");
  const payload={action};
  if(action==="preview") {
    if(!file)throw new Error("Choose a theme JSON file smaller than 64 KiB");
    let text;try{text=readBounded(file,65536);}catch{throw new Error("Choose a readable theme JSON file smaller than 64 KiB");}
    try{payload.theme=JSON.parse(text.replace(/^\uFEFF/,""));}catch{throw new Error("Theme JSON is invalid. Check the package syntax.");}
  }
  const body=JSON.stringify(payload);
  if(Buffer.byteLength(body)>65536)throw new Error("Theme request exceeds 64 KiB");
  const send=async()=>{
    let control;try{control=JSON.parse(readBounded(path.join(state,"cryoclaw.config.json"),2*1024*1024).replace(/^\uFEFF/,"")).gatewayControl;}
    catch{throw Object.assign(new Error("CryoClaw control configuration could not be read. Reopen the app."),{code:"CONTROL_NOT_READY"});}
    if(!control || !Number.isInteger(control.port) || control.port<1 || control.port>65535 || typeof control.token!=="string" || !control.token)throw Object.assign(new Error("CryoClaw control service is unavailable. Open the app first."),{code:"CONTROL_NOT_READY"});
    return await new Promise((resolve,reject)=>{
    const request=http.request({host:"127.0.0.1",port:control.port,path:"/ui/theme",method:"POST",timeout:15000,
      headers:{authorization:`Bearer ${control.token}`,"content-type":"application/json","content-length":Buffer.byteLength(body)}},response=>{
      const chunks=[];let size=0;
      response.on("data",chunk=>{size+=chunk.length;if(size>65536){response.destroy();reject(new Error("Theme response too large"));}else chunks.push(chunk);});
      response.on("error",reject);response.on("end",()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(response.statusCode!==200 || !value.ok)throw Object.assign(new Error(value.error||"Theme request failed"),{retryable:response.statusCode===401 || response.statusCode>=500});resolve(value);}catch(error){reject(error);}});
    });
    request.on("timeout",()=>request.destroy(Object.assign(new Error("Theme preview timed out. Check the app window."),{code:"ETIMEDOUT"})));request.on("error",reject);request.end(body);
  });
  };
  let result;
  for(let attempt=1;attempt<=2;attempt++){
    try{result=await send();if(attempt>1)result.recoveryAttempts=attempt;break;}
    catch(error){if(attempt===2 || !(error?.retryable || ["ECONNREFUSED","ECONNRESET","EPIPE","ETIMEDOUT","ENOENT","CONTROL_NOT_READY"].includes(error?.code)))throw error;await new Promise(resolve=>setTimeout(resolve,400));}
  }
  process.stdout.write(JSON.stringify(result)+"\n");
} catch(error){process.stderr.write((error instanceof Error?error.message:"Theme request failed")+"\n");process.exitCode=1;}
