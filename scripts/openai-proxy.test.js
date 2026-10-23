const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("private gateway IPC starts native shutdown once; compile-cache persistence waits for exit",()=>{
  const vm=require("node:vm"),source=fs.readFileSync(require("node:path").join(__dirname,"../shared/openai-proxy-bootstrap.cjs"),"utf8");
  let listener,onExit,onDisconnect,handlers=0,flushes=0;const emitted=[];
  const proc={versions:{electron:"43.8.3"},env:{NODE_COMPILE_CACHE:"/cache"},send(){},on(name,fn){if(name==="message")listener=fn;},once(name,fn){if(name==="exit")onExit=fn;if(name==="disconnect")onDisconnect=fn;},listenerCount(){return handlers;},emit(name){emitted.push(name);}};
  const requireStub=name=>name==="node:module"?{createRequire:()=>require,flushCompileCache:()=>{flushes++;}}:name==="./openai-proxy.cjs"?{normalizeProxyConfig:()=>({mode:"system"}),isOpenAIOrigin:()=>false}:require(name);
  vm.runInNewContext(source,{require:requireStub,process:proc,setTimeout:()=>({unref(){}}),URL,console});
  listener({type:"other"});listener({type:"cryoclaw:shutdown"});assert.equal(emitted.length,0);
  handlers=1;listener({type:"cryoclaw:shutdown"});listener({type:"cryoclaw:shutdown"});onDisconnect();assert.deepEqual(emitted,["SIGTERM"]);assert.equal(flushes,0);onExit();assert.equal(flushes,1);
});
test("standalone Node does not install redundant exit hooks or cache flush timers",()=>{
  const source=fs.readFileSync(require("node:path").join(__dirname,"../shared/openai-proxy-bootstrap.cjs"),"utf8"),hooks=[];
  const proc={versions:{node:"24.22.1"},env:{NODE_COMPILE_CACHE:"/cache"},on(){},once(name){hooks.push(name);}};
  const load=require("node:module").createRequire(require("node:path").resolve(__dirname,"../shared/openai-proxy-bootstrap.cjs"));
  require("node:vm").runInNewContext(source,{require:load,process:proc,setTimeout(){throw Error("Native flush timer is unnecessary");},URL,console});assert.deepEqual(hooks,[]);
});
test("loss of the GUI IPC owner enters native shutdown without leaving an orphan gateway",()=>{
  const vm=require("node:vm"),source=fs.readFileSync(require("node:path").join(__dirname,"../shared/openai-proxy-bootstrap.cjs"),"utf8");
  for(const handlers of [0,1]){
    let disconnect;const events=[];
    const proc={env:{},send(){},on(){},once(name,fn){if(name==="disconnect")disconnect=fn;},listenerCount(){return handlers;},emit(name){events.push(name);},exit(code){events.push(code);}};
    const load=require("node:module").createRequire(require("node:path").resolve(__dirname,"../shared/openai-proxy-bootstrap.cjs"));
    vm.runInNewContext(source,{require:load,process:proc,setTimeout:()=>({unref(){}}),URL,console});disconnect();disconnect();assert.deepEqual(events,handlers?["SIGTERM"]:[0]);
  }
});
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

test("legacy Electron retains compile cache before forced shutdown without keeping the process alive",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../shared/openai-proxy-bootstrap.cjs"),"utf8");
  let flushed=0,unrefs=0;
  const scheduled=[];
  vm.runInNewContext(source,{process:{versions:{electron:"43.8.3"},env:{NODE_COMPILE_CACHE:"/cache"},once(){}},setTimeout(callback,delay){scheduled.push({callback,delay});return {unref(){unrefs++;}};},require(name){
    if(name==="node:module")return {flushCompileCache(){flushed++;}};
    if(name==="node:fs")return fs;
    if(name==="node:path")return path;
    return policy;
  }});
  assert.deepEqual(scheduled.map(t=>t.delay),[180000]);
  assert.equal(unrefs,1);
  scheduled.forEach(t=>t.callback());assert.equal(flushed,1);
});
