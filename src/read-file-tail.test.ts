import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {readFileTail} from "./read-file-tail.ts";
test("large sparse logs yield only their bounded tail",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"cryoclaw-log-tail-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"large.log"),handle=await fs.open(file,"w");
  await handle.truncate(64*1024*1024);await handle.write("latest",64*1024*1024-6);await handle.close();
  const tail=await readFileTail(file,1024);assert.equal(tail.length,1024);assert.equal(tail.subarray(-6).toString(),"latest");
  assert.equal((await readFileTail(file,0)).length,0);await assert.rejects(readFileTail(file,9*1024*1024),/budget/);
});
