import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertLocalFilePath, readFileCardInfo } from "./file-card";
test("file-card metadata handles missing files, directories and local-path boundaries",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"cryo-file-info-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"result.pdf");await fs.writeFile(file,"test");
  const info=await readFileCardInfo(file);assert.equal(info.exists,true);assert.equal(info.size,4);
  assert.equal((await readFileCardInfo(dir)).exists,false);assert.equal((await readFileCardInfo(path.join(dir,"gone"))).exists,false);
  for(const value of [null,"relative.pdf","https://host/file.pdf","\\\\host\\x.pdf","//host/a.pdf","C:\\bad\0file"])
    assert.throws(()=>assertLocalFilePath(value));
});
