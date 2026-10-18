import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";
import { ArchiveResourceBudget, MAX_ARCHIVE_ENTRY_BYTES, MAX_ARCHIVE_TOTAL_BYTES, MAX_ARCHIVE_ENTRIES } from "./archive-resource-budget";
import { readArchiveWithJs } from "./openclaw-state-archive-zip";

test("archive limits reject oversized declarations, totals, counts and invalid sizes", () => {
  for (const size of [-1, NaN, Infinity, MAX_ARCHIVE_ENTRY_BYTES + 1]) {
    assert.throws(() => new ArchiveResourceBudget().add(size), /resource limits/);
  }
  const total = new ArchiveResourceBudget();
  for (let i=0;i<MAX_ARCHIVE_TOTAL_BYTES/MAX_ARCHIVE_ENTRY_BYTES;i++) total.add(MAX_ARCHIVE_ENTRY_BYTES);
  assert.throws(() => total.add(1), /resource limits/);
  const count = new ArchiveResourceBudget();
  for (let i=0;i<MAX_ARCHIVE_ENTRIES;i++) count.add(0);
  assert.throws(() => count.add(0), /resource limits/);
});

test("uncaptured entries cannot stream beyond their declared output size", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-budget-"));
  try {
    const data = Buffer.from(zipSync({"data.bin":new Uint8Array(8192)}, {level:9}));
    const central = data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    data.writeUInt32LE(1,22);
    data.writeUInt32LE(1,central+24);
    const zip = path.join(temp,"input.zip");
    fs.writeFileSync(zip,data);
    await assert.rejects(readArchiveWithJs(zip,path.join(temp,"state")), /长度校验失败/);
    data.writeUInt32LE(MAX_ARCHIVE_ENTRY_BYTES+1,22);
    data.writeUInt32LE(MAX_ARCHIVE_ENTRY_BYTES+1,central+24);
    fs.writeFileSync(zip,data);
    await assert.rejects(readArchiveWithJs(zip,path.join(temp,"state")), /resource limits/);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

test("oversized directory metadata is rejected before it is allocated", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-directory-budget-"));
  try {
    const zip = path.join(temp, "metadata.zip");
    const size = 32 * 1024 * 1024 + 1;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(size, 12);
    const fd = fs.openSync(zip, "w");
    try { fs.writeSync(fd, end, 0, end.length, size); }
    finally { fs.closeSync(fd); }
    await assert.rejects(readArchiveWithJs(zip, path.join(temp, "state")), /directory exceeds resource limits/);
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
});
