import fs from "node:fs/promises";
import path from "node:path";
import {inspectContextAssets} from "./context-report.mjs";

export const parameters = {
  type:"object",additionalProperties:false,required:["files"],properties:{files:{
    type:"array",minItems:1,maxItems:12,items:{type:"object",additionalProperties:false,
      required:["path"],properties:{path:{type:"string",minLength:1,maxLength:4096},title:{type:"string",maxLength:120}}},
  }},
};

function localFile(value){
  if(typeof value!=="string" || !path.isAbsolute(value) || value.includes("\0") || /^[/\\]{2}/.test(value)) throw Error("Use an absolute local file path");
}

export async function publishFiles(args,{signal,assertCurrent=()=>{}}={}){
  if(!args || Object.keys(args).some(key=>key!=="files") || !Array.isArray(args.files) || args.files.length<1 || args.files.length>12) throw Error("Publish 1 to 12 existing files");
  const files=[],seen=new Set();
  for(const item of args.files){
    if(signal?.aborted)throw Error("Delivery canceled");assertCurrent();
    if(!item || typeof item!=="object" || Object.keys(item).some(key=>!["path","title"].includes(key)))throw Error("Invalid file descriptor");
    localFile(item.path);
    if(item.path.length>4096 || (item.title!==undefined && (typeof item.title!=="string" || item.title.length>120)))throw Error("File descriptor is too long");
    const real=await fs.realpath(item.path);localFile(real);
    const stat=await fs.stat(real);
    if(!stat.isFile())throw Error("Deliverables must be existing regular files");
    const key=process.platform==="win32"?real.toLowerCase():real;
    if(seen.has(key))continue;seen.add(key);
    files.push({path:real,title:item.title?.trim() || path.basename(real),size:stat.size,mtimeMs:stat.mtimeMs});
  }
  if(signal?.aborted)throw Error("Delivery canceled");assertCurrent();
  // Keep model-visible output constant-size. Native details carry UI metadata;
  // the plugin never reads, uploads, or encodes file contents.
  return {content:[{type:"text",text:`Published ${files.length} file${files.length===1?"":"s"}.`}],
    details:{cryoclawDeliverables:{version:1,files}}};
}

export default {
  id:"cryoclaw-deliverables",name:"CryoClaw Deliverables",
  register(api){
    api.registerGatewayMethod?.("cryoclaw.context.inspect",async({params,context,respond})=>{
      if(params && Object.keys(params).length){respond(false,undefined,{code:"INVALID_REQUEST",message:"This method accepts no parameters"});return;}
      try{respond(true,await inspectContextAssets({rootDir:api.rootDir,config:context.getRuntimeConfig(),toolSchema:parameters}));}
      catch{respond(false,undefined,{code:"UNAVAILABLE",message:"Context asset report is unavailable"});}
    },{scope:"operator.read"});
    api.registerTool({contextVersion:2,create(ctx){
      if(ctx.sandboxed || (ctx.messageChannel && !["webchat","webchat-ui"].includes(ctx.messageChannel)))return null;
      return {name:"cryoclaw_deliver_files",label:"Deliver files",description:"Show finished local deliverables as clickable desktop cards. Call after creating files; provide absolute paths. No file contents or MEDIA text needed.",parameters,
        execute:(_id,args,signal)=>publishFiles(args,{signal,assertCurrent:ctx.assertInvocationCurrent})};
    }},{optional:false});
  },
};
