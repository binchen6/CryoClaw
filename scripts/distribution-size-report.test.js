const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {fileRecord,summarizeTree}=require('./distribution-size-report');
test('distribution report counts logical bytes without following links',async t=>{
 const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'cryoclaw-size-'));t.after(()=>fs.promises.rm(root,{recursive:true,force:true}));
 await fs.promises.mkdir(path.join(root,'resources','nested'),{recursive:true});
 await fs.promises.writeFile(path.join(root,'app.exe'),Buffer.from([1,2,3,4]));
 await fs.promises.writeFile(path.join(root,'resources','nested','a.js'),'abcdef');
 const record=await fileRecord(path.join(root,'app.exe'));assert.equal(record.bytes,4);assert.equal(record.sha256,crypto.createHash('sha256').update(Buffer.from([1,2,3,4])).digest('hex'));
 const summary=await summarizeTree(root);assert.equal(summary.files,2);assert.equal(summary.logicalBytes,10);assert.equal(summary.topLevel.resources.files,1);assert.equal(summary.topLevel['(root)'].files,1);
 if(process.platform!=='win32'){await fs.promises.symlink(path.join(root,'app.exe'),path.join(root,'link'));const linked=await summarizeTree(root);assert.equal(linked.symlinks,1);assert.equal(linked.files,2);}
});
