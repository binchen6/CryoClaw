export type CacheUsage={uncachedInput:number|null;cacheRead:number|null;cacheWrite:number|null;inputTotal:number|null;output:number|null;totalTokens:number|null;readRatio:number|null};
const count=(v:unknown):number|null=>typeof v==="number" && Number.isFinite(v) && v>=0?v:null;
const record=(v:unknown):Record<string,unknown>=>v && typeof v==="object"?v as Record<string,unknown>:{};

/** Native OpenClaw input excludes cached tokens; raw OpenAI prompt includes them. */
export function readCacheUsage(value:unknown):CacheUsage {
  const u=record(value),prompt=record(u.prompt_tokens_details??u.input_tokens_details);
  const cacheRead=count(u.cacheRead)??count(u.cache_read_input_tokens)??count(u.prompt_cache_hit_tokens)??count(prompt.cached_tokens)??count(u.cachedContentTokenCount);
  const cacheWrite=count(u.cacheWrite)??count(u.cache_creation_input_tokens)??count(prompt.cache_write_tokens)??count(prompt.cache_creation_input_tokens);
  const output=count(u.output)??count(u.outputTokens)??count(u.completion_tokens)??count(u.output_tokens)??count(u.candidatesTokenCount);
  const explicitTotal=count(u.totalTokens)??count(u.total_tokens)??count(u.totalTokenCount);
  const nativeInput=count(u.input)??count(u.inputTokens);
  const anthropic=Object.hasOwn(u,"cache_read_input_tokens") || Object.hasOwn(u,"cache_creation_input_tokens");
  const exclusive=nativeInput??(anthropic?count(u.input_tokens):null);
  const inclusive=count(u.prompt_tokens)??count(u.promptTokenCount)??(!anthropic?count(u.input_tokens):null);
  let inputTotal=inclusive;
  if(inputTotal===null && exclusive!==null && cacheRead!==null && cacheWrite!==null)inputTotal=exclusive+cacheRead+cacheWrite;
  if(inputTotal===null && explicitTotal!==null && output!==null && explicitTotal>=output)inputTotal=explicitTotal-output;
  const observedCache=(cacheRead??0)+(cacheWrite??0);
  const coherent=inputTotal===null || inputTotal>=observedCache;
  const uncachedInput=exclusive??(inputTotal!==null && coherent && cacheRead!==null?inputTotal-observedCache:null);
  return {uncachedInput,cacheRead,cacheWrite,inputTotal:coherent?inputTotal:null,output,
    totalTokens:explicitTotal??(inputTotal!==null&&output!==null&&coherent?inputTotal+output:null),
    readRatio:coherent&&cacheRead!==null&&inputTotal!==null&&inputTotal>0?cacheRead/inputTotal:null};
}
