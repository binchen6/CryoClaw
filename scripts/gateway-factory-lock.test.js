'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const lock=require('./locks/gateway-package-lock.json'),policy=require('./lib/gateway-dependency-policy');

test('factory installation lock agrees with the pinned runtime and safety policy',()=>{
  const config=require('../package.json').cryoclaw;
  assert.deepEqual(lock.packages[''].dependencies,{openclaw:config.openclaw,clawhub:config.clawhub,...policy.dependencies});
  assert.deepEqual(lock.cryoclawOverrides,policy.overrides);
  const core=lock.packages['node_modules/openclaw'];
  for(const name of ['undici','zod']){
    const nested=lock.packages[`node_modules/openclaw/node_modules/${name}`];
    const resolved=nested??lock.packages[`node_modules/${name}`];
    assert.equal(resolved.version,nested?.inBundle?core.dependencies[name]:policy.dependencies[name],'bundled source or reviewed installed dependency');
  }
  for(const target of ['darwin-arm64','darwin-x64','win32-arm64','win32-x64'])assert.ok(lock.packages[`node_modules/@esbuild/${target}`],'cross-platform optional installation graph: '+target);
});

test('custom kernel, custom overrides and reordered manifests cannot select the wrong factory graph',()=>{
  const source=fs.readFileSync(path.join(__dirname,'package-resources.js'),'utf8');
  const start=source.indexOf('  const factoryLockFile ='),end=source.indexOf('\n\n',start);
  assert.ok(start>=0&&end>start);
  const snippet=source.slice(start,end)+'\nuseFactoryLock;';
  for(const change of ['none','reordered','kernel','policy']){
    const pkg={dependencies:{...lock.packages[''].dependencies},overrides:{...lock.cryoclawOverrides}},copied=[];
    if(change==='kernel')pkg.dependencies.openclaw='file:/custom/kernel';
    if(change==='policy')pkg.overrides.npm='999.0.0';
    if(change==='reordered')pkg.dependencies=Object.fromEntries(Object.entries(pkg.dependencies).reverse());
    const selected=vm.runInNewContext(snippet,{__dirname,path,pkg,gatewayDir:'staged',fs:{readFileSync:fs.readFileSync,copyFileSync:(...args)=>copied.push(args)},log:()=>{}});
    assert.equal(selected,change==='none'||change==='reordered');assert.equal(copied.length,selected?1:0);
  }
});
