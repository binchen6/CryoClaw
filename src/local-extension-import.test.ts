import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {importLocalSkill,isLocalSkill,validateLocalPlugin} from "./local-extension-import";

test("local skill import preserves source, refuses replacement, and stays outside marketplace updates",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cryo-local-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,"sample"),target=path.join(root,"skills");fs.mkdirSync(source);fs.writeFileSync(path.join(source,"SKILL.md"),"---\nname: sample\n---\n# Local documentation");
  assert.equal(importLocalSkill(source,target),"sample");
  assert.equal(isLocalSkill(target,"sample"),true);
  assert.ok(fs.readFileSync(path.join(source,"SKILL.md"),"utf8").includes("Local documentation"));
  assert.throws(()=>importLocalSkill(source,target),/already exists/);
  fs.mkdirSync(path.join(root,".clawhub"));fs.writeFileSync(path.join(root,".clawhub/lock.json"),JSON.stringify({skills:{tracked:{version:"1"}}}));
  assert.equal(isLocalSkill(target,"tracked"),false);
  assert.equal(isLocalSkill(target,"manual"),true);
});
test("plugin imports require a manifest and reject entry paths outside the selected directory",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cryo-local-plugin-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const plugin=path.join(root,"plugin");fs.mkdirSync(plugin);fs.writeFileSync(path.join(plugin,"openclaw.plugin.json"),JSON.stringify({id:"sample"}));fs.writeFileSync(path.join(plugin,"entry.js"),"export {}");
  const manifest=path.join(plugin,"package.json");fs.writeFileSync(manifest,JSON.stringify({openclaw:{extensions:["./entry.js"]}}));assert.equal(validateLocalPlugin(plugin),fs.realpathSync(plugin));
  fs.writeFileSync(manifest,JSON.stringify({openclaw:{extensions:["./index.ts"],runtimeExtensions:["./entry.js"]}}));assert.equal(validateLocalPlugin(plugin),fs.realpathSync(plugin));
  fs.writeFileSync(path.join(root,"outside.js"),"export {}");fs.writeFileSync(manifest,JSON.stringify({openclaw:{extensions:["../outside.js"]}}));assert.throws(()=>validateLocalPlugin(plugin),/inside/);
});
