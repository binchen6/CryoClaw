#!/usr/bin/env node
"use strict";
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=fs.readdirSync(__dirname).filter(name=>/\.test\.(js|mjs)$/.test(name)).sort().map(name=>path.join(__dirname,name));
if(!files.length)throw Error('No script tests discovered');
const isolated=files.filter(file=>path.basename(file)==='package-resources.test.js');
for(const group of [files.filter(file=>!isolated.includes(file)),isolated]){
  if(!group.length)continue;
  const result=spawnSync(process.execPath,['--test','--test-concurrency=4',...group],{cwd:root,stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
