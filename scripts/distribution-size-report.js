#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
async function hashFile(file){const hash=crypto.createHash('sha256');await new Promise((resolve,reject)=>{const stream=fs.createReadStream(file);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',resolve);});return hash.digest('hex');}
async function fileRecord(file){const stat=await fs.promises.stat(file);assert.ok(stat.isFile(),'Not a regular file: '+file);return {path:path.resolve(file),bytes:stat.size,sha256:await hashFile(file)};}
async function summarizeTree(root){
 const result={path:path.resolve(root),files:0,directories:0,symlinks:0,logicalBytes:0,topLevel:{}};
 async function walk(dir,top){
  const entries=await fs.promises.readdir(dir,{withFileTypes:true});
  for(const entry of entries){const full=path.join(dir,entry.name);
   if(entry.isSymbolicLink()){result.symlinks++;continue;}
   if(entry.isDirectory()){result.directories++;await walk(full,top??entry.name);continue;}
   if(!entry.isFile())continue;
   const stat=await fs.promises.stat(full);result.files++;result.logicalBytes+=stat.size;
   const key=top??'(root)';result.topLevel[key]??={files:0,logicalBytes:0};result.topLevel[key].files++;result.topLevel[key].logicalBytes+=stat.size;
  }
 }
 await walk(root,null);return result;
}
async function main(argv=process.argv){
 const value=(name=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:null});
 if(argv.includes('--help')){console.log('node scripts/distribution-size-report.js [--installer <Setup.exe>] [--install-dir <directory>] [--out <report.json>]');return;}
 const installer=value('--installer'),installDir=value('--install-dir'),out=value('--out');assert.ok(installer||installDir,'Pass --installer and/or --install-dir');
 const report={schemaVersion:1,startedAt:new Date().toISOString()};
 if(installer){report.installer=await fileRecord(path.resolve(installer));const blockmap=installer+'.blockmap';if(fs.existsSync(blockmap))report.blockmap=await fileRecord(path.resolve(blockmap));}
 if(installDir)report.installTree=await summarizeTree(path.resolve(installDir));
 report.finishedAt=new Date().toISOString();const text=JSON.stringify(report,null,2)+'\n';if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(path.resolve(out),text);}console.log(text);
}
module.exports={fileRecord,summarizeTree,main};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
