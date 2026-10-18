import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {readWorkspaceText,saveWorkspaceText,writeWorkspaceDraft,readWorkspaceDraft,findWorkspaceFiles,WORKSPACE_TEXT_LIMIT} from "./workspace-files";

test("workspace save is atomic, detects concurrent edits and preserves the original on access changes",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cryoclaw-editor-"));
  try{
    const filename=path.join(root,"notes.md");await fs.writeFile(filename,"original");
    const before=await readWorkspaceText(filename);
    const saved=await saveWorkspaceText(filename,"saved",before.hash,async()=>true);
    assert.equal(saved.success,true);assert.equal(await fs.readFile(filename,"utf8"),"saved");
    const conflict=await saveWorkspaceText(filename,"lost",before.hash,async()=>true);
    assert.equal(conflict.conflict,true);assert.equal(await fs.readFile(filename,"utf8"),"saved");
    const current=await readWorkspaceText(filename);let checks=0;
    await assert.rejects(saveWorkspaceText(filename,"denied",current.hash,async()=>++checks===1),/Access denied/);
    assert.equal(await fs.readFile(filename,"utf8"),"saved");assert.deepEqual(await fs.readdir(root),["notes.md"]);
    const raced=await saveWorkspaceText(filename,"overwrite",current.hash,async()=>{if(++checks===4)await fs.writeFile(filename,"external edit");return true;});
    assert.equal(raced.conflict,true);assert.equal(await fs.readFile(filename,"utf8"),"external edit");
    assert.deepEqual(await fs.readdir(root),["notes.md"]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("workspace text reader rejects binary and oversized files before editing",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cryoclaw-text-"));
  try{const filename=path.join(root,"bad.txt");await fs.writeFile(filename,Buffer.from([65,0,66]));await assert.rejects(readWorkspaceText(filename),/二进制/);
    await fs.writeFile(filename,Buffer.alloc(WORKSPACE_TEXT_LIMIT+1,65));await assert.rejects(readWorkspaceText(filename),/1 MiB/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("durable workspace drafts recover and delete without writing the user's file",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cryoclaw-draft-"));
  try{const filename=path.join(root,"notes.txt");await fs.writeFile(filename,"original");const before=await readWorkspaceText(filename);
    await writeWorkspaceDraft(filename,root,"unsaved draft",before.hash);
    assert.deepEqual(await readWorkspaceDraft(filename,root),{draft:"unsaved draft",baseHash:before.hash});
    assert.equal(await fs.readFile(filename,"utf8"),"original");
    await writeWorkspaceDraft(filename,root,null,before.hash);assert.equal(await readWorkspaceDraft(filename,root),null);
    await assert.rejects(writeWorkspaceDraft(filename,root,"x","invalid"));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("workspace search skips generated/hidden files, caps results and supports cancellation",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cryoclaw-search-"));
  try{
    for(const directory of ["src","node_modules",".hidden"])await fs.mkdir(path.join(root,directory));
    await Promise.all(["src/visible.ts","node_modules/visible.ts",".hidden/visible.ts"].map(name=>fs.writeFile(path.join(root,name),"")));
    const visible=await findWorkspaceFiles(root,"visible");assert.deepEqual(visible.items.map(item=>item.relativePath),[path.join("src","visible.ts")]);
    assert.equal((await findWorkspaceFiles(root,"visible",true)).items.length,3);
    await Promise.all(Array.from({length:205},(_,index)=>fs.writeFile(path.join(root,`match-${index}.txt`),"")));
    const bounded=await findWorkspaceFiles(root,"match");assert.equal(bounded.items.length,200);assert.equal(bounded.truncated,true);
    const cancelled=await findWorkspaceFiles(root,"match",false,()=>true);assert.equal(cancelled.cancelled,true);assert.deepEqual(cancelled.items,[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
