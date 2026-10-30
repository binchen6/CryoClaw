import {publicHttpsUrl} from './network.mjs';
export const queryParameters={type:'object',additionalProperties:false,required:['kind'],properties:{kind:{type:'string',enum:['public','system','dashboards']},url:{type:'string',maxLength:4096},format:{type:'string',enum:['json','text']},pointer:{type:'string',maxLength:256,description:'Optional JSON Pointer selects only the needed subtree.'},maxChars:{type:'integer',minimum:512,maximum:16000},refreshSeconds:{type:'integer',minimum:60,maximum:86400}}};
export function selectPointer(value,pointer){if(!pointer)return value;if(typeof pointer!=='string'||!pointer.startsWith('/')||pointer.length>256)throw Error('Invalid JSON Pointer');let selected=value;for(const part of pointer.slice(1).split('/')){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');if(!selected||typeof selected!=='object'||!Object.hasOwn(selected,key))throw Error('JSON Pointer was not found');selected=selected[key];}return selected;}
export async function queryData(args,{broker,system,store,assertCurrent=()=>{},sandboxed=false}){
  assertCurrent();let result;
  if(args.kind==='system'){if(sandboxed)throw Error('Host system metrics are unavailable in a sandboxed session');result={value:await system(),source:'local:system'};}
  else if(args.kind==='dashboards'){if(sandboxed)throw Error('Host dashboards are unavailable in a sandboxed session');result={value:await store.execute({action:'list'}),source:'local:dashboards'};}
  else if(args.kind==='public'){const url=publicHttpsUrl(args.url).href;result=await broker.data({url,format:args.format==='text'?'text':'json',refreshSeconds:Math.max(60,Math.min(86400,Math.round(args.refreshSeconds??300)))});}
  else throw Error('Unsupported data query');assertCurrent();
  const value=selectPointer(result.value,args.pointer),limit=Math.max(512,Math.min(16000,Math.round(args.maxChars??4000))),serialized=typeof value==='string'?value:JSON.stringify(value);
  const truncated=serialized.length>limit;return {source:result.source,fetchedAt:result.fetchedAt??Date.now(),...result.stale===true?{stale:true,retryAt:result.retryAt}:{},truncated,...truncated?{text:serialized.slice(0,limit),hint:'Select a narrower JSON Pointer for complete values.'}:{value}};
}
