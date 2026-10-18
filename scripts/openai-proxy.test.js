const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../shared/openai-proxy.cjs");

test("proxy configuration rejects credentials, unsupported protocols and URL suffixes", () => {
  assert.deepEqual(policy.normalizeProxyConfig({mode:"custom",url:" http://127.0.0.1:7890/ "}),{mode:"custom",url:"http://127.0.0.1:7890"});
  for (const url of ["socks5://localhost:1080","http://user:secret@localhost:7890","http://localhost/path","http://localhost/?x=1","file:///tmp/proxy",""]) {
    assert.throws(() => policy.normalizeProxyConfig({mode:"custom",url}));
  }
  assert.throws(() => policy.normalizeProxyConfig({mode:"invalid"}));
  assert.deepEqual(policy.normalizeProxyConfig(undefined),{mode:"system",url:""});
});

test("gateway proxy routes only exact official HTTPS origins and preserves other dispatchers", () => {
  const source = fs.readFileSync(path.join(__dirname,"../shared/openai-proxy-bootstrap.cjs"),"utf8");
  for (const mode of ["system","custom","direct"]) {
    const calls=[];
    const originalDispatcher={dispatch:()=>"original"};
    class Agent { dispatch() {return "direct";} }
    class ProxyAgent { constructor(url) {assert.equal(url,"http://127.0.0.1:7890");} dispatch() {return "proxy";} }
    const runtime = {Agent,ProxyAgent,fetch:(input,init)=>{calls.push(init);return init;},getGlobalDispatcher:()=>originalDispatcher};
    const context={URL,process:{env:{CRYOCLAW_OPENAI_PROXY_CONFIG:"/state/config",CRYOCLAW_OPENAI_GATEWAY_ROOT:"/kernel"}},fetch:(input,init)=>{calls.push(init);return init;},require(name) {
      if(name==="node:fs") return {existsSync:()=>true,readFileSync:()=>JSON.stringify({openaiProxy:{mode,url:"http://127.0.0.1:7890"}})};
      if(name==="node:path") return path;
      if(name==="node:module") return {createRequire:()=>()=>runtime};
      return policy;
    }};
    vm.runInNewContext(source,context);
    const original={dispatcher:originalDispatcher};
    context.fetch("https://auth.openai.com/oauth/token",original);
    if(mode==="system") assert.equal(calls[0],original);
    else {
      assert.equal(calls[0].dispatcher.dispatch({origin:"https://chatgpt.com"}),mode==="custom"?"proxy":"direct");
      assert.equal(calls[0].dispatcher.dispatch({origin:"https://unrelated.test"}),"original");
    }
    for(const url of ["https://api.anthropic.com","https://auth.openai.com.evil.test","http://auth.openai.com","https://auth.openai.com:8443"]) {
      context.fetch(url,original);
      assert.equal(calls.at(-1),original);
    }
    runtime.fetch("https://auth.openai.com/oauth/token",original);
    if (mode !== "system") assert.equal(calls.at(-1).dispatcher.dispatch({origin:"https://auth.openai.com"}),mode==="custom"?"proxy":"direct", "direct undici imports must use the same routing as global fetch");
  }
});

test("gateway retains compile cache before forced Windows shutdown without keeping the process alive",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../shared/openai-proxy-bootstrap.cjs"),"utf8");
  let flushed=0,unrefs=0;
  const scheduled=[];
  vm.runInNewContext(source,{process:{env:{NODE_COMPILE_CACHE:"/cache"}},setTimeout(callback,delay){scheduled.push({callback,delay});return {unref(){unrefs++;}};},require(name){
    if(name==="node:module")return {flushCompileCache(){flushed++;}};
    if(name==="node:fs")return fs;
    if(name==="node:path")return path;
    return policy;
  }});
  assert.deepEqual(scheduled.map(t=>t.delay),[15000,60000,120000]);
  assert.equal(unrefs,3);
  scheduled.forEach(t=>t.callback());assert.equal(flushed,3);
});
