import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";

// Operator-only, on-demand asset diagnostics. No prompt or credential contents
// are returned, and no directories are scanned when the gateway starts.
export async function inspectContextAssets({rootDir,config,toolSchema}){
  const root=path.resolve(rootDir,"../../.."),skills=[];
  for(const name of await fs.readdir(path.join(root,"skills")).catch(()=>[])){
    const file=path.join(root,"skills",name,"SKILL.md");
    const stat=await fs.stat(file).catch(()=>null);if(!stat?.isFile()||stat.size>2*1024*1024)continue;
    const text=await fs.readFile(file,"utf8"),description=text.match(/^description:\s*(.*)$/m)?.[1]??"";
    skills.push({name,entryBytes:stat.size,descriptionChars:description.length,digest:createHash("sha256").update(text).digest("hex")});
  }
  skills.sort((a,b)=>a.name.localeCompare(b.name,"en"));
  const defaults=config.agents?.defaults??{},primary=typeof defaults.model==="string"?defaults.model:defaults.model?.primary??null;
  const fallbacks=Array.isArray(defaults.model?.fallbacks)?defaults.model.fallbacks.filter(value=>typeof value==="string"):[];
  const toolSchemaChars=JSON.stringify(toolSchema).length;
  const catalogueDigest=createHash("sha256").update(JSON.stringify({skills,toolSchema})).digest("hex");
  return {version:1,skills,toolSchemaChars,catalogueDigest,primary,
    duplicateFallbacks:fallbacks.filter((value,index)=>value===primary || fallbacks.indexOf(value)!==index),
    retention:defaults.params?.cacheRetention??null,heartbeat:defaults.heartbeat?.every??null,
    totals:{entryBytes:skills.reduce((n,row)=>n+row.entryBytes,0),descriptionChars:skills.reduce((n,row)=>n+row.descriptionChars,0)}};
}
