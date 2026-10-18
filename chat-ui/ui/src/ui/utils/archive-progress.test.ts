import test from "node:test";
import assert from "node:assert/strict";
import {archiveProgressView} from "./archive-progress.ts";
test("backup progress distinguishes indeterminate phases, byte progress and native entry progress",()=>{
  assert.equal(archiveProgressView({phase:"snapshot"},true).percent,null);
  assert.equal(archiveProgressView({phase:"write",bytesDone:50,bytesTotal:200,filesDone:1,filesTotal:2},true).percent,25);
  assert.equal(archiveProgressView({phase:"restore",filesDone:3,filesTotal:4},false).percent,75);
  assert.equal(archiveProgressView({phase:"write",bytesDone:Infinity,bytesTotal:200},true).percent,null);
  assert.equal(archiveProgressView({phase:"done"},true).percent,100);
});
