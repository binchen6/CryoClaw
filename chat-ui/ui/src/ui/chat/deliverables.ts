import {unwrapNestedToolMessage} from "./message-normalizer.ts";
import {MEDIA_RE} from "./media-protocol.ts";
export type PublishedFile={path:string;title?:string;size?:number;mtimeMs?:number};
export function fileCardPathKey(value:string):string {
  let path=value;
  if(/^file:/i.test(path))try{const url=new URL(path);if(url.hostname && url.hostname!=="localhost")return value;path=decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/,"$1");}catch{return value;}
  const windows=/^[A-Za-z]:[\\/]/.test(path);
  path=path.replace(/\\/g,"/");
  const parts:string[]=[];
  for(const part of path.split("/")){if(part==="." || part==="")continue;if(part===".." && parts.length>0)parts.pop();else parts.push(part);}
  const key=(path.startsWith("/")?"/":"")+parts.join("/");return windows?key.toLowerCase():key;
}
const publishedCache=new WeakMap<unknown[],{files:PublishedFile[];paths:ReadonlySet<string>}>();
export function publishedFilesForMessages(messages:unknown[]){
  const cached=publishedCache.get(messages);if(cached)return cached;
  const files=new Map<string,PublishedFile>(),aliases=new Set<string>();
  for(const message of messages){
    if(!message || typeof message!=="object")continue;
    const record=message as Record<string,unknown>;
    const m=unwrapNestedToolMessage(record.message && typeof record.message === "object" ? record.message : record) as Record<string,unknown>;
    if(m.pending===true || m.isError===true || m.role==="user")continue;
    const blocks=Array.isArray(m.content)?m.content:[];
    for(const block of [m,...blocks]){
      if(!block || typeof block!=="object")continue;const item=block as Record<string,unknown>;
      const name=item.name??item.toolName??item.tool_name;
      if(name!=="cryoclaw_deliver_files" || item.isError===true)continue;
      const receipt=readPublishedFiles(item.details);
      for(const file of receipt)files.set(fileCardPathKey(file.path),file);
      if(receipt.length){
        const args=(item.arguments??item.args) as {files?:unknown}|undefined;
        for(const file of readPublishedFiles({cryoclawDeliverables:{version:1,files:args?.files}}))aliases.add(fileCardPathKey(file.path));
      }
    }
  }
  const result={files:[...files.values()],paths:new Set([...files.keys(),...aliases]) as ReadonlySet<string>};publishedCache.set(messages,result);return result;
}
export function readPublishedFiles(value:unknown):PublishedFile[]{
  if(!value || typeof value!=="object")return [];
  const receipt=(value as Record<string,unknown>).cryoclawDeliverables;
  if(!receipt || typeof receipt!=="object" || (receipt as Record<string,unknown>).version!==1)return [];
  const files=(receipt as Record<string,unknown>).files;if(!Array.isArray(files))return [];
  const out:PublishedFile[]=[],seen=new Set<string>();
  for(const item of files.slice(0,12)){
    if(!item || typeof item!=="object")continue;
    const file=item as Record<string,unknown>;
    if(typeof file.path!=="string" || file.path.length>4096 || file.path.includes("\0") ||
      !/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(file.path) || seen.has(file.path))continue;
    seen.add(file.path);out.push({path:file.path,
      ...(typeof file.title==="string"?{title:file.title.slice(0,120)}:{}),
      ...(typeof file.size==="number"&&Number.isFinite(file.size)&&file.size>=0?{size:file.size}:{}),
    });
  }
  return out;
}

/** Suppress only gateway-owned mirrors of an unambiguous, explicit MEDIA path
 * already represented by a successful plugin card. Ambiguity keeps the file. */
export function redundantDeliveryMirrors(messages:unknown[], preferred:ReadonlySet<string>):ReadonlySet<unknown>{
  const raw=messages.map(value=>value && typeof value==="object" && "message" in value?(value as {message:unknown}).message:value);
  const names=new Map<string,Set<string>>(),skip=new Set<unknown>();
  for(const value of raw){
    const m=value as Record<string,unknown>;if(!m || m.role!=="assistant")continue;
    const text=typeof m.content==="string"?m.content:Array.isArray(m.content)?m.content.filter(b=>b?.type==="text").map(b=>b.text??"").join("\n"):"";
    for(const match of text.matchAll(new RegExp(MEDIA_RE.source,MEDIA_RE.flags))){
      const file=match[1]??match[2],key=fileCardPathKey(file),name=file.replace(/\\/g,"/").split("/").at(-1)?.toLowerCase();
      if(name){const paths=names.get(name)??new Set<string>();paths.add(key);names.set(name,paths);}
    }
  }
  for(const value of raw){
    const m=value as Record<string,unknown>;
    if(!m || m.role!=="assistant" || m.model!=="gateway-injected" || m.provider!=="openclaw" ||
      typeof m.idempotencyKey!=="string" || !/:assistant-media:\d+$/.test(m.idempotencyKey) || !Array.isArray(m.content) || !m.content.length)continue;
    if(m.content.every(block=>{
      const label=block?.type==="attachment" && typeof block.attachment?.label==="string"?block.attachment.label.toLowerCase():null;
      const paths=label?names.get(label):undefined;return paths?.size===1 && preferred.has([...paths][0]);
    }))skip.add(value);
  }
  return skip;
}
