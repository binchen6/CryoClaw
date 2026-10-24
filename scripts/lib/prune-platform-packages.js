"use strict";
const fs=require('node:fs'),path=require('node:path');
function accepts(constraint,value){
  if(!Array.isArray(constraint)||!constraint.length||constraint.some(x=>typeof x!=='string'))return true;
  if(constraint.includes('!'+value))return false;
  const positive=constraint.filter(x=>!x.startsWith('!'));
  return positive.length===0||positive.includes(value)||positive.includes('any');
}
/** Remove only packages whose own npm os/cpu contract excludes this build target. */
function prunePlatformPackages(root,platform,arch){
  if(!['win32','darwin','linux'].includes(platform)||!['x64','arm64'].includes(arch))throw Error('Unsupported pruning target');
  root=fs.realpathSync(root);const removed=[];
  function walk(dir,inModules=false){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(!entry.isDirectory()||entry.isSymbolicLink())continue;
      const full=path.join(dir,entry.name),relative=path.relative(root,full);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Pruning path escaped build tree');
      if(inModules&&!entry.name.startsWith('@')){
        const manifest=path.join(full,'package.json');let pkg;
        try{pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));}catch{}
        if(pkg&&(!accepts(pkg.os,platform)||!accepts(pkg.cpu,arch))){
          fs.rmSync(full,{recursive:true,force:true});removed.push(relative.replaceAll(path.sep,'/'));continue;
        }
      }
      walk(full,entry.name==='node_modules'||inModules&&entry.name.startsWith('@'));
    }
  }
  walk(root);return {packages:removed.length,removed};
}
module.exports={accepts,prunePlatformPackages};
