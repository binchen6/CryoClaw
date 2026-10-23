import test from "node:test";
import assert from "node:assert/strict";
import { fileCardPathKey, publishedFilesForMessages, readPublishedFiles, redundantDeliveryMirrors } from "./deliverables.ts";
import { renderMediaMarkers, formatFileCardSize, buildFileCardHtml, enhanceMedia } from "./media-enhance.ts";
import {unwrapNestedToolMessage} from "./message-normalizer.ts";

test("file metadata enhancement runs after the template children commit",async()=>{
  const globals=globalThis as unknown as Record<string,unknown>,before={window:globals.window,document:globals.document,IntersectionObserver:globals.IntersectionObserver};
  let committed=false,reads=0;const meta={textContent:"PDF"};
  const card={dataset:{filePath:"C:/report.pdf",fileExt:"pdf"} as Record<string,string>,isConnected:true,querySelector:()=>meta,querySelectorAll:()=>[],classList:{toggle(){}}};
  const container={isConnected:true,querySelectorAll:(selector:string)=>selector===".chat-file-card"&&committed?[card]:[]};
  globals.window={cryoclaw:{fileCardInfo:async()=>{reads++;return {exists:true,size:1024};}}};globals.document={addEventListener(){}};globals.IntersectionObserver=undefined;
  try{enhanceMedia(container as unknown as Element);committed=true;for(let n=0;n<12;n++)await Promise.resolve();assert.equal(reads,1);assert.equal(meta.textContent,"PDF · 1 KB");}
  finally{Object.assign(globals,before);}
});

const receipt=(path:string)=>({cryoclawDeliverables:{version:1,files:[{path,title:"交付物"}]}});
test("file cards are observed only after Lit attaches every fragment",async()=>{
  const globals=globalThis as unknown as Record<string,unknown>,before={document:globals.document,IntersectionObserver:globals.IntersectionObserver};
  const seen:boolean[]=[];
  class Observer { observe(card:{isConnected:boolean}){seen.push(card.isConnected);} unobserve(){} }
  globals.document={addEventListener(){}};globals.IntersectionObserver=Observer;
  const cards=[0,1].map(()=>({dataset:{},isConnected:false}));
  const roots=cards.map(card=>({isConnected:false,querySelectorAll:(selector:string)=>selector===".chat-file-card"?[card]:[]}));
  try{
    for(const root of roots)enhanceMedia(root as unknown as Element);
    assert.deepEqual(seen,[],"detached refs must not register observer targets");
    for(let i=0;i<roots.length;i++){roots[i].isConnected=true;cards[i].isConnected=true;}
    for(let n=0;n<5;n++)await Promise.resolve();
    assert.deepEqual(seen,[true,true]);
  }finally{Object.assign(globals,before);}
});
const call=(path:string)=>({role:"assistant",content:[{type:"toolCall",name:"cryoclaw_deliver_files",details:receipt(path),text:"Published 1 file."}]});
test("native Code Mode nested receipts share direct-tool rendering and precedence",()=>{
  const nested={role:"custom",customType:"openclaw.nested-tool.v1",display:true,excludeFromContext:true,content:"",details:{toolName:"cryoclaw_deliver_files",toolCallId:"nested-1",result:{content:[{type:"text",text:"Published 1 file."}],details:receipt("C:/r.pdf")},isError:false}};
  const projected=unwrapNestedToolMessage(nested) as Record<string,unknown>;
  assert.equal(projected.role,"toolResult");assert.equal(projected.toolName,"cryoclaw_deliver_files");
  assert.equal(publishedFilesForMessages([nested,call("c:/r.pdf")]).files.length,1);
  assert.equal(publishedFilesForMessages([{...nested,details:{...nested.details,isError:true}}]).files.length,0);
  assert.equal(publishedFilesForMessages([{...nested,customType:"other"}]).files.length,0);
  assert.equal(publishedFilesForMessages([{...nested,display:false}]).files.length,0);
  assert.ok(!renderMediaMarkers('<p>MEDIA:C:/r.pdf</p>',publishedFilesForMessages([nested]).paths).includes('chat-file-card'));
});
test("public history projection recovers only a successful exact owned invocation",()=>{
  const call={type:"toolCall",id:"nested-1",name:"cryoclaw_deliver_files",arguments:{files:[{path:"C:/r.pdf",title:"交付"}]}};
  const result={type:"toolResult",toolCallId:"nested-1",toolName:"cryoclaw_deliver_files",content:[{type:"text",text:"Published 1 file."}],isError:false};
  const projected={role:"custom",customType:"openclaw.nested-tool.v1",display:true,excludeFromContext:true,content:[call,result]};
  assert.equal(publishedFilesForMessages([projected]).files[0].title,"交付");
  assert.equal((unwrapNestedToolMessage(projected) as Record<string,unknown>).role,"assistant");
  for(const outcome of [{...result,isError:true},{...result,isError:undefined},{...result,pending:true},{...result,toolCallId:"wrong"}])
    assert.equal(publishedFilesForMessages([{...projected,content:[call,outcome]}]).files.length,0);
  assert.equal(publishedFilesForMessages([{...projected,content:[{...call,name:"other"},result]}]).files.length,0);
  const canonical=publishedFilesForMessages([{...projected,content:[call,{...result,details:receipt("C:/real/r.pdf")}]}]);
  assert.equal(canonical.files[0].path,"C:/real/r.pdf");assert.ok(canonical.paths.has(fileCardPathKey("C:/r.pdf")),"successful input aliases also suppress legacy duplicates");
});
test("native MEDIA mirrors deduplicate only when plugin provenance and path are unambiguous",()=>{
  const paths=new Set([fileCardPathKey("C:/r.pdf")]);
  const media={role:"assistant",content:[{type:"text",text:'MEDIA:"C:/r.pdf"'}]};
  const mirror={role:"assistant",provider:"openclaw",model:"gateway-injected",idempotencyKey:"qa:assistant-media:1",content:[{type:"attachment",attachment:{label:"r.pdf",url:"/api/chat/media/outgoing/qa/id/full"}}]};
  assert.equal(redundantDeliveryMirrors([media,mirror],paths).has(mirror),true);
  for(const ordinary of [{...mirror,role:"user"},{...mirror,model:"other"},{...mirror,idempotencyKey:"ordinary"}])
    assert.equal(redundantDeliveryMirrors([media,ordinary],paths).size,0);
  assert.equal(redundantDeliveryMirrors([mirror],paths).size,0);
  assert.equal(redundantDeliveryMirrors([media,mirror],new Set()).size,0);
  assert.equal(redundantDeliveryMirrors([media,{role:"assistant",content:'MEDIA:"C:/other/r.pdf"'},mirror],paths).size,0,"same filename in two paths must not hide another file");
});
test("plugin delivery wins over legacy MEDIA in the same turn, preserving other files",()=>{
  const publication=publishedFilesForMessages([call("C:\\My Files\\report.xlsx")]);
  const mixed=renderMediaMarkers('<p>MEDIA:"c:/my files/report.xlsx" MEDIA:C:\\other.pdf</p>',publication.paths);
  assert.equal((mixed.match(/class="chat-file-card"/g)??[]).length,1);assert.ok(mixed.includes("other.pdf"));
  assert.equal(renderMediaMarkers('<p>MEDIA:"C:\\My Files\\report.xlsx"</p>').includes('class="chat-file-card"'),true);
});
test("failed, pending, unrelated and user messages never suppress the legacy protocol",()=>{
  for(const message of [{...call("C:/r.pdf"),isError:true},{...call("C:/r.pdf"),pending:true},{...call("C:/r.pdf"),role:"user"},{role:"toolResult",toolName:"other",details:receipt("C:/r.pdf")}])
    assert.equal(publishedFilesForMessages([message]).files.length,0);
  assert.equal(publishedFilesForMessages([]).paths.size,0,"a new turn cannot inherit old deliveries");
});
test("live and history receipts converge, normalize Windows paths and preserve POSIX case",()=>{
  const messages=[call("C:/A/../b.pdf"),{role:"toolResult",toolName:"cryoclaw_deliver_files",details:receipt("c:\\b.pdf")}];
  assert.equal(publishedFilesForMessages(messages).files.length,1);
  assert.equal(publishedFilesForMessages(messages),publishedFilesForMessages(messages),"stable lists reuse their derived receipt");
  assert.equal(fileCardPathKey("file:///C:/My%20Files/r.pdf"),fileCardPathKey("c:\\my files\\r.pdf"));
  assert.notEqual(fileCardPathKey("/tmp/A.pdf"),fileCardPathKey("/tmp/a.pdf"));
  const escaped=renderMediaMarkers('<p>MEDIA:"C:\\a &amp; b.pdf"</p>',publishedFilesForMessages([call("C:\\a & b.pdf")]).paths);
  assert.ok(!escaped.includes("chat-file-card"));
});
test("malformed receipts cannot produce remote cards; titles escape HTML",()=>{
  for(const path of ["https://evil.test/a.pdf","\\\\server\\a.pdf","relative.pdf","/bad\0file.pdf"])
    assert.equal(readPublishedFiles(receipt(path)).length,0);
  const html=buildFileCardHtml("C:/r.pdf","r",'<img src=x onerror="bad()">');
  assert.ok(!html.includes("<img"));assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes('role="group"'));assert.ok(html.includes('data-file-copy'));assert.ok(html.includes('data-file-save'));
  assert.equal(formatFileCardSize(0),"0 B");assert.equal(formatFileCardSize(1536),"1.5 KB");assert.equal(formatFileCardSize(NaN),"");
});
