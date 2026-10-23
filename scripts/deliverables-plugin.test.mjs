import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin,{publishFiles,parameters} from "../builtin-plugins/cryoclaw-deliverables/index.mjs";
import {inspectContextAssets} from "../builtin-plugins/cryoclaw-deliverables/context-report.mjs";

test("10.5 discovery advertises the delivery tool before runtime activation",async()=>{
  const manifest=JSON.parse(await fs.readFile(new URL("../builtin-plugins/cryoclaw-deliverables/openclaw.plugin.json",import.meta.url),"utf8"));
  assert.deepEqual(manifest.contracts.tools,["cryoclaw_deliver_files"]);
  assert.equal(manifest.activation.onStartup,true);
});

test("context diagnostics have stable asset fingerprints and never return credentials or private context",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cryo-context-report-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pluginRoot=path.join(root,"dist/extensions/cryoclaw-deliverables"),skill=path.join(root,"skills/sample");await fs.mkdir(skill,{recursive:true});
  await fs.writeFile(path.join(skill,"SKILL.md"),"---\nname: sample\ndescription: Sample task\n---\n# Instructions\n");
  const config={agents:{defaults:{model:{primary:"deepseek/test",fallbacks:["deepseek/test"]}}},models:{providers:{private:{apiKey:"super-secret"}}}};
  const first=await inspectContextAssets({rootDir:pluginRoot,config,toolSchema:parameters}),second=await inspectContextAssets({rootDir:pluginRoot,config,toolSchema:parameters});
  assert.equal(first.catalogueDigest,second.catalogueDigest);assert.equal(first.skills.length,1);assert.ok(!JSON.stringify(first).includes("super-secret"));assert.ok(!JSON.stringify(first).includes("Instructions"));
  assert.deepEqual(first.duplicateFallbacks,["deepseek/test"]);assert.equal(first.retention,null);
  await fs.appendFile(path.join(skill,"SKILL.md"),"Changed\n");assert.notEqual((await inspectContextAssets({rootDir:pluginRoot,config,toolSchema:parameters})).catalogueDigest,first.catalogueDigest);
});

test("delivery publishes metadata only, deduplicates paths, never reads file bytes",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"cryo-delivery-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"输出 report.pdf");await fs.writeFile(file,"private-file-content");
  const result=await publishFiles({files:[{path:file,title:"报告"},{path:file}]});
  assert.equal(result.content[0].text,"Published 1 file.");assert.equal(result.details.cryoclawDeliverables.files[0].size,20);
  assert.ok(!JSON.stringify(result.content).includes(file));assert.ok(!JSON.stringify(result).includes("private-file-content"));
  await assert.rejects(publishFiles({files:[{path:dir}]}),/regular files/);
  await assert.rejects(publishFiles({files:[{path:"https://evil.test/a.pdf"}]}),/absolute local/);
  await assert.rejects(publishFiles({files:[{path:file}]} ,{signal:AbortSignal.abort()}),/canceled/);
  await assert.rejects(publishFiles({files:[{path:file}]} ,{assertCurrent:()=>{throw Error("stale owner");}}),/stale owner/);
});
test("native tool factory uses host authority and keeps its schema compact",()=>{
  let factory;plugin.register({registerTool:value=>{factory=value;}});
  assert.equal(factory.contextVersion,2);assert.equal(factory.create({sandboxed:true}),null);
  assert.equal(factory.create({messageChannel:"telegram"}),null);
  const tool=factory.create({assertInvocationCurrent:()=>{},messageChannel:"webchat"});
  assert.equal(tool.name,"cryoclaw_deliver_files");assert.ok(JSON.stringify(parameters).length<600);
});
