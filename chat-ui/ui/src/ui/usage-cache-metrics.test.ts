import test from "node:test";
import assert from "node:assert/strict";
import {readCacheUsage} from "./usage-cache-metrics.ts";
test("native, DeepSeek, OpenAI and Anthropic cache counters use the correct denominator",()=>{
  const native=readCacheUsage({input:100,output:20,cacheRead:80,cacheWrite:20});
  assert.equal(native.inputTotal,200);assert.equal(native.totalTokens,220);assert.equal(native.readRatio,.4);
  const ds=readCacheUsage({prompt_tokens:200,completion_tokens:20,prompt_cache_hit_tokens:160,prompt_cache_miss_tokens:40});
  assert.equal(ds.uncachedInput,40);assert.equal(ds.readRatio,.8);assert.equal(ds.cacheWrite,null);
  const ai=readCacheUsage({input_tokens:200,output_tokens:20,input_tokens_details:{cached_tokens:80}});
  assert.equal(ai.uncachedInput,120);assert.equal(ai.totalTokens,220);
  const anthropic=readCacheUsage({input_tokens:100,output_tokens:20,cache_read_input_tokens:80,cache_creation_input_tokens:20});
  assert.deepEqual(anthropic,native);
});
test("missing cache values remain unknown, explicit zero remains zero, invalid totals never become a percentage",()=>{
  assert.equal(readCacheUsage({}).cacheRead,null);
  const zero=readCacheUsage({input:100,output:0,cacheRead:0,cacheWrite:0});assert.equal(zero.readRatio,0);
  assert.equal(readCacheUsage({prompt_tokens:10,prompt_cache_hit_tokens:20}).readRatio,null);
  assert.equal(readCacheUsage({cacheRead:NaN,cacheWrite:-1}).cacheRead,null);
  assert.equal(readCacheUsage({input:10,output:5,cacheRead:20,cacheWrite:0,totalTokens:35}).totalTokens,35);
});
