import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {EventEmitter} from 'node:events';
import {createDashboardStore,normalizeLayout} from '../builtin-plugins/cryoclaw-dashboards/store.mjs';
import {starterCards} from '../builtin-plugins/cryoclaw-dashboards/starter.mjs';
import {onboardingCards} from '../builtin-plugins/cryoclaw-dashboards/onboarding.mjs';
import {injectRuntime,runtimeScript} from '../builtin-plugins/cryoclaw-dashboards/runtime.mjs';
import {publicHttpsUrl,isPublicAddress,fetchPublicBody,createSourceBroker,resolvePublicHost} from '../builtin-plugins/cryoclaw-dashboards/network.mjs';
import plugin from '../builtin-plugins/cryoclaw-dashboards/index.mjs';
import {queryData,selectPointer} from '../builtin-plugins/cryoclaw-dashboards/query.mjs';
const fixture=async(t,extra={})=>{const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-dashboard-')),options={stateDir,secret:'test secret',...extra},a=createDashboardStore(options),b=createDashboardStore(options);t.after(()=>{a.close();b.close();fs.rmSync(stateDir,{recursive:true,force:true});});const board=(await a.execute({action:'create',title:'独立看板'})).board;return {a,b,board,options};};
const publish=(store,id,extra={})=>store.execute({action:'publish_card',boardId:id,cardId:'counter',title:'Counter',html:'<!doctype html><html><head></head><body>Hi</body></html>',...extra});
test('dashboard instances share durable atomic catalogue and preserve local state/layout',async t=>{
 const {a,b,board}=await fixture(t);await publish(a,board.id,{layout:{w:4,h:400,order:3}});assert.equal((await b.list()).boards[0].cards.length,1);
 await b.setState(board.id,'counter',{count:7});await publish(a,board.id,{html:'<b>Updated</b>'});assert.deepEqual(await a.getState(board.id,'counter'),{count:7});assert.equal((await b.list()).boards[0].cards[0].layout.w,4);
 assert.equal(JSON.stringify(await b.list()).includes('count'),true);assert.ok(!JSON.stringify(await b.list()).includes('"state"'));assert.ok(!JSON.stringify(await b.list()).includes('<b>'));
 a.close();assert.equal((await a.list()).boards[0].cards[0].title,'Counter');
});
test('idempotent create handles replay and rejects argument mismatch',async t=>{const {a}=await fixture(t);const args={action:'create',title:'Replay'};const one=await a.execute(args,undefined,'unique');assert.deepEqual(await a.execute(args,undefined,'unique'),one);assert.equal((await a.list()).boards.length,2);await assert.rejects(a.execute({...args,title:'Other'},undefined,'unique'),/different arguments/);});
test('failed commit and returned state cannot mutate cached catalogue',async t=>{
 const {a,b,board}=await fixture(t);await publish(a,board.id);await a.setState(board.id,'counter',{value:1});
 const state=await a.getState(board.id,'counter');state.value=99;assert.equal((await a.getState(board.id,'counter')).value,1);
 let calls=0;await assert.rejects(a.execute({action:'rename',boardId:board.id,title:'rollback'},()=>{if(++calls===3)throw Error('retired');}),/retired/);
 assert.equal((await a.list()).boards[0].title,'独立看板');await b.execute({action:'rename',boardId:board.id,title:'external'});assert.equal((await a.list()).boards[0].title,'external');
});
test('deleted card capabilities never authorize a new card with the same ID',async t=>{
 const {a,board}=await fixture(t);await publish(a,board.id);const before=new URL((await a.pin(board.id,'counter')).frameUrl,'http://localhost').searchParams.get('ticket');
 await publish(a,board.id,{html:'<b>ordinary revision</b>'});assert.equal((await a.document(board.id,'counter',before)).writable,true,'ordinary edits retain capabilities');
 await a.execute({action:'remove_card',boardId:board.id,cardId:'counter'});await publish(a,board.id,{html:'<b>new incarnation</b>'});await assert.rejects(a.document(board.id,'counter',before),/unavailable/);
 const fresh=new URL((await a.pin(board.id,'counter')).frameUrl,'http://localhost').searchParams.get('ticket');assert.equal((await a.document(board.id,'counter',fresh)).writable,true);
});
test('example copies preserve existing boards and deletion supports archive or explicit confirmation',async t=>{
 const {a,board}=await fixture(t);await publish(a,board.id);await a.setState(board.id,'counter',{private:'kept'});
 const sample=await a.execute({action:'create_example'});assert.equal((await a.list()).boards.find(b=>b.id===sample.board.id).cards.length,21);assert.equal((await a.getState(board.id,'counter')).private,'kept');
 await assert.rejects(a.execute({action:'delete',boardId:sample.board.id}),/Confirm permanent/);await a.execute({action:'archive',boardId:sample.board.id});await a.execute({action:'delete',boardId:sample.board.id});assert.equal((await a.list({includeArchived:true})).boards.length,1);
 const active=await a.execute({action:'create',title:'Delete directly'});await a.execute({action:'delete',boardId:active.board.id,confirmDelete:true});assert.deepEqual((await a.list({includeArchived:true})).boards.map(item=>item.id),[board.id]);
});
test('canceled transaction rolls back and does not publish partial card',async t=>{const {a,board}=await fixture(t);await assert.rejects(a.execute({action:'publish_card',boardId:board.id,title:'No',html:'<b>x</b>'},()=>{throw Error('canceled');}),/canceled/);assert.equal((await a.list()).boards[0].cards.length,0);});
test('view tickets bind card and write permission, archive/delete revoke',async t=>{const {a,board}=await fixture(t);await publish(a,board.id);const card=(await a.list()).boards[0].cards[0],ticket=new URL(card.frameUrl,'http://localhost').searchParams.get('ticket');assert.equal((await a.document(board.id,card.id,ticket)).writable,false);await assert.rejects(a.document(board.id,'another',ticket));await assert.rejects(a.document(board.id,card.id,ticket+'x'));const pin=await a.pin(board.id,card.id);assert.equal((await a.document(board.id,card.id,new URL(pin.frameUrl,'http://localhost').searchParams.get('ticket'))).writable,true);await a.execute({action:'archive',boardId:board.id});await assert.rejects(a.document(board.id,card.id,ticket));await a.execute({action:'restore',boardId:board.id});assert.equal((await a.document(board.id,card.id,ticket)).title,'Counter');await a.execute({action:'remove_card',boardId:board.id,cardId:card.id});await assert.rejects(a.getState(board.id,card.id));});
test('ticket expires and list renews without a catalogue mutation',async t=>{let now=Date.now();const {board,a:store}=await fixture(t,{now:()=>now});await publish(store,board.id);const first=await store.list();now+=25*3600000;const url=new URL(first.boards[0].cards[0].frameUrl,'http://localhost');await assert.rejects(store.document(board.id,'counter',url.searchParams.get('ticket')),/Expired/);const next=await store.list({sinceRevision:first.revision});assert.ok(!next.unchanged);assert.notEqual(next.boards[0].cards[0].frameUrl,first.boards[0].cards[0].frameUrl);});
test('state and document/source size limits are enforced',async t=>{const {a,board}=await fixture(t);await publish(a,board.id);await assert.rejects(a.setState(board.id,'counter','x'.repeat(32768)),/32 KiB/);await assert.rejects(publish(a,board.id,{html:'x'.repeat(131073)}),/128 KiB/);await assert.rejects(publish(a,board.id,{dataSources:[{id:'x',url:'http://localhost'}]}));assert.deepEqual(normalizeLayout({w:99,h:1,order:-5}),{w:12,h:180,order:0});});
test('starter page has interactive cards and all inline scripts parse',()=>{
 assert.ok(starterCards.length>=17);assert.ok(starterCards.length<=24);
 const connected=starterCards.find(card=>card.cardId==='connected-section');assert.equal(connected.layout.h,420);assert.match(connected.html,/sdk\.motion\.frame/);
 const welcome=starterCards.find(card=>card.cardId==='welcome');assert.match(welcome.html,/class="cryo-field"/);assert.doesNotMatch(welcome.html,/<pre class="art">/);
 const notes=starterCards.find(card=>card.cardId==='quick-notes');assert.match(notes.html,/cryoclawDashboard\.setState/);assert.match(notes.html,/maxlength="4000"/);assert.match(notes.html,/id="plan"/);assert.match(notes.html,/cryoclawDashboard\.compose/);assert.match(notes.html,/cryoclawDashboard\.motion\.animate/);
 for(const card of starterCards){assert.ok(!card.html||Buffer.byteLength(card.html)<131072);for(const script of (card.html??'').matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1],{filename:card.cardId});}
 const html=injectRuntime('<!doctype html><html><head></head><body></body></html>');assert.ok(html.startsWith('<!doctype html>'));for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});
test('built-in data cards label stale snapshots with their time and clear the label after fresh data',async()=>{
 const fetchedAt=Date.UTC(2026,9,29,10),rates=[{quote:'USD',rate:0.14,date:'2026-10-29'}],releases=[{name:'v2026.1029.0',published_at:'2026-10-29T09:00:00Z',body:'Verified release'}];
 const element=()=>({textContent:'',children:[],append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},querySelectorAll(){return [];},querySelector(){return null;}});
 for(const cardId of ['fx-rates','release-gallery','release-timeline'])for(const stale of [true,false]){
  const nodes=new Map(['status','stamp','rates','refresh','gallery','history'].map(id=>[id,element()]));nodes.get('status').textContent='数据已过期';
  let failure=false;const document={getElementById:id=>nodes.get(id)??null,createElement:element,querySelectorAll:()=>[]};
  const context=vm.createContext({document,Date,setInterval(){},cryoclawDashboard:{data:async id=>{if(id==='history')return {value:[]};if(failure)throw Error('offline');return {value:cardId==='fx-rates'?rates:releases,fetchedAt,...stale?{stale:true,retryAt:fetchedAt+15000}:{}};}}});
  const card=starterCards.find(card=>card.cardId===cardId);for(const script of card.html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(script[1],context);
  await new Promise(setImmediate);
  const status=nodes.get('status').textContent;
  if(stale)assert.match(status,/已过期/,cardId);else assert.doesNotMatch(status,/过期/,cardId);
  if(cardId==='fx-rates'){
   assert.match(nodes.get('stamp').textContent,/2026-10-29/);assert.equal(nodes.get('rates').children[0].children[1].textContent,'¥ 7.1429');
   failure=true;await nodes.get('refresh').onclick();assert.match(nodes.get('status').textContent,/offline/);assert.match(nodes.get('stamp').textContent,/2026-10-29/);assert.equal(nodes.get('rates').children.length,1);
  }else{
   assert.ok(status.includes(new Date(fetchedAt).toLocaleString()),`${cardId} must expose the snapshot retrieval time`);
   const container=nodes.get(cardId==='release-gallery'?'gallery':'history');assert.equal(container.children.length,1);
   assert.equal(container.children[0].children[1].textContent.includes('v2026.1029.0'),true);
  }
 }
});

test('onboarding board teaches examples, templates, prompts, layout and gestures',async t=>{
 assert.equal(onboardingCards.length,5);
 const hero=onboardingCards.find(card=>card.cardId==='onboarding-hero');assert.match(hero.html,/cryoclawDashboard\.compose/);assert.match(hero.html,/data-tab="market"/);
 const templates=onboardingCards.find(card=>card.cardId==='onboarding-templates');assert.match(templates.html,/data-create/);assert.match(templates.html,/每日财经/);
 const prompts=onboardingCards.find(card=>card.cardId==='onboarding-prompts');assert.match(prompts.html,/cryoclawDashboard\.compose/);assert.match(prompts.html,/番茄钟/);
 const layout=onboardingCards.find(card=>card.cardId==='onboarding-layout');assert.match(layout.html,/cryoclawDashboard\.motion\.animate/);
 const basics=onboardingCards.find(card=>card.cardId==='onboarding-basics');assert.match(basics.html,/Esc/);assert.match(basics.html,/公开来源/);
 for(const card of onboardingCards){assert.ok(Buffer.byteLength(card.html)<131072);for(const script of card.html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1],{filename:card.cardId});}
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-dashboard-')),store=createDashboardStore({stateDir,secret:'test secret'});
 t.after(()=>{store.close();fs.rmSync(stateDir,{recursive:true,force:true});});
 const seeded=await store.execute({action:'seed'}),board=(await store.list({includeArchived:true})).boards.find(item=>item.id===seeded.board.id);
 assert.equal(board.cards.length,5,'first run seeds the guided board');
 assert.equal(board.title,'看板入门');assert.ok(board.description.length>10);
 const sample=await store.execute({action:'create_example'});assert.equal((await store.list()).boards.find(item=>item.id===sample.board.id).cards.length,21,'the showcase stays an explicit choice');
});
test('public sources reject secrets and private/reserved IPv4/IPv6',()=>{for(const url of ['http://github.com','https://127.0.0.1','https://user:pass@github.com','https://host.local','https://github.com/?api_key=x'])assert.throws(()=>publicHttpsUrl(url));for(const ip of ['127.0.0.1','169.254.169.254','192.168.1.1','100.64.1.1','198.51.100.1','203.0.113.1','::1','::ffff:8.8.8.8','2001:0db8::1','2002:808:808::1'])assert.equal(isPublicAddress(ip),false,ip);for(const ip of ['8.8.8.8','192.0.78.24','203.0.114.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(ip),true,ip);});
test('network pins checked DNS, rejects mixed private DNS and validates redirects',async()=>{const resolver=async()=>[{address:'8.8.8.8',family:4}],seen=[];const request=(url,options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const response=new EventEmitter();response.headers={};response.statusCode=200;response.resume=()=>{};response.destroy=()=>{};seen.push(options);callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from('ok'));response.emit('end');});};return req;};const result=await fetchPublicBody('https://public.org/a',{resolver,request});assert.equal(result.body.toString(),'ok');seen[0].lookup('public.org',{},(_e,address,family)=>{assert.equal(address,'8.8.8.8');assert.equal(family,4);});await assert.rejects(fetchPublicBody('https://public.org',{resolver:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request}),/Private/);
const redirect=(url,options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'http://localhost/secret'};res.resume=()=>{};callback(res);};return req;};await assert.rejects(fetchPublicBody('https://public.org',{resolver,request:redirect}),/HTTPS/);});
test('source broker coalesces and caches reads without model calls',async()=>{let calls=0,release;const broker=createSourceBroker({fetchBody:async()=>{calls++;await new Promise(r=>release=r);return {body:Buffer.from('{"count":2}'),mime:'application/json'};}});const source={url:'https://public.org/data',format:'json',refreshSeconds:300};const first=broker.data(source),second=broker.data(source);release();assert.deepEqual((await first).value,{count:2});await second;await broker.data(source);assert.equal(calls,1);});
test('dashboard public source snapshots are persistent and bounded',async t=>{
 const {a,b}=await fixture(t);
 for(let index=0;index<66;index++)a.writeSourceCache(`data:${index}`,{value:{value:{index},source:'https://public.org/data',fetchedAt:index},until:1000+index});
 assert.equal(b.readSourceCache('data:0'),undefined);assert.deepEqual(b.readSourceCache('data:65').value.value,{index:65});
 a.close();assert.deepEqual(b.readSourceCache('data:65').value.value,{index:65});
});
test('source broker awaits a coalesced refresh of persisted stale data and never persists assets',async t=>{
 let time=1000,calls=0,release;const saved=new Map(),source={url:'https://public.org/data',format:'json',refreshSeconds:300};
 const options={now:()=>time,readCache:key=>saved.get(key),writeCache:(key,entry)=>saved.set(key,entry),fetchBody:async()=>{calls++;if(calls===2)await new Promise(resolve=>release=resolve);return {body:Buffer.from(calls===1?'{"count":2}':calls===2?'{"count":3}':'asset'),mime:calls===3?'image/png':'application/json'};}};
 let broker=createSourceBroker(options);assert.deepEqual((await broker.data(source)).value,{count:2});assert.equal(saved.size,1);
 time+=301000;broker=createSourceBroker(options);const pending=broker.data(source);t.after(()=>release?.());
 let settled=false;void pending.then(()=>settled=true);const second=broker.data(source);
 await new Promise(setImmediate);assert.equal(settled,false,'expired snapshots must not hide a successful refresh');assert.equal(calls,2);release();
 assert.deepEqual((await pending).value,{count:3});assert.deepEqual((await second).value,{count:3});
 assert.equal(saved.values().next().value.value.value.count,3);assert.ok(saved.values().next().value.until>time);
 await broker.asset({url:'https://public.org/image'});assert.equal(saved.size,1);
});
test('source broker returns stale data after a failed refresh but preserves first-read failures',async()=>{
 let time=1000,calls=0,offline=true;const source={url:'https://public.org/data',format:'json',refreshSeconds:60};
 const broker=createSourceBroker({now:()=>time,fetchBody:async()=>{calls++;if(calls===1||!offline)return {body:Buffer.from(calls===1?'{"count":2}':'{"count":3}'),mime:'application/json'};throw Error('offline');}});
 await broker.data(source);time+=61000;const stale=await broker.data(source);assert.equal(stale.stale,true);assert.equal(stale.retryAt,time+15000);assert.equal(stale.value.count,2);assert.equal(calls,2);
 await broker.data(source);assert.equal(calls,2);
 await assert.rejects(broker.data({...source,url:'https://public.org/other'}),/offline/);assert.equal(calls,3);
 offline=false;time+=15000;const fresh=await broker.data(source);assert.equal(fresh.value.count,3);assert.equal(fresh.stale,undefined);assert.equal(fresh.retryAt,undefined);assert.equal(fresh.fetchedAt,time);assert.equal(calls,4);
});
test('Fake-IP is independently resolved and never admitted as a destination',async()=>{const url=new URL('https://public.org'),fake=async()=>[{address:'198.18.0.1',family:4}];assert.equal((await resolvePublicHost(url,fake,async()=>[{address:'8.8.8.8',family:4}])).address,'8.8.8.8');await assert.rejects(resolvePublicHost(url,fake,async()=>[{address:'127.0.0.1',family:4}]),/Private/);await assert.rejects(resolvePublicHost(url,async()=>[{address:'127.0.0.1',family:4}],()=>{throw Error('must not resolve private host');}),/Private/);});
test('standalone public queries preserve stale status and retry time for cached offline data',async()=>{
 let time=1000,calls=0;const broker=createSourceBroker({now:()=>time,fetchBody:async()=>{if(calls++)throw Error('offline');return {body:Buffer.from(JSON.stringify({rate:2,large:'x'.repeat(1000)})),mime:'application/json'};}});
 const args={kind:'public',url:'https://public.org/data',refreshSeconds:60};
 await queryData(args,{broker});time+=61000;
 for(const selected of [{pointer:'/rate'},{maxChars:512}]){
  const result=await queryData({...args,...selected},{broker});
  assert.equal(result.stale,true);assert.equal(result.retryAt,time+15000);assert.equal(result.fetchedAt,1000);
 }
 assert.equal(calls,2,'the retry cooldown must also cover model queries');
});
test('plugin registers narrow read/write methods and tool factory without eager disk IO',()=>{const methods=new Map(),routes=[],tools=[];plugin.register({config:{gateway:{auth:{token:'test'}}},registerGatewayMethod:(name,handler,options)=>methods.set(name,{handler,...options}),registerHttpRoute:route=>routes.push(route),registerTool:tool=>tools.push(tool)});assert.equal(methods.get('cryoclaw.dashboards.pin').scope,'operator.write');assert.equal(methods.get('cryoclaw.dashboards.setState').scope,'operator.write');assert.equal(methods.get('cryoclaw.dashboards.list').scope,'operator.read');assert.equal(routes[0].auth,'plugin');assert.equal(tools[0].create({sandboxed:true}),null);});
test('standalone data queries need no board and bound model context',async()=>{let checked=0;const broker={data:async source=>({value:{data:[{title:'real'}],large:'x'.repeat(20000)},source:source.url,fetchedAt:123})};const options={broker,assertCurrent:()=>checked++};assert.deepEqual((await queryData({kind:'public',url:'https://public.org',pointer:'/data/0/title'},options)).value,'real');assert.equal(checked,2);const result=await queryData({kind:'public',url:'https://public.org',maxChars:512},options);assert.equal(result.truncated,true);assert.equal(result.text.length,512);assert.ok(!('value'in result));assert.equal((await queryData({kind:'system'},{system:async()=>({cpuCount:8})})).value.cpuCount,8);await assert.rejects(queryData({kind:'system'},{sandboxed:true}),/sandbox/);await assert.rejects(queryData({kind:'public',url:'http://127.0.0.1'},options),/HTTPS/);assert.equal(selectPointer({'a/b':{'~':2}},'/a~1b/~0'),2);assert.throws(()=>selectPointer({},'/toString'),/not found/);});
test('scheduled task links preserve iframe identity/state and survive publication',async t=>{const {a,board}=await fixture(t);await publish(a,board.id);await a.setState(board.id,'counter',{value:9});const before=(await a.list()).boards[0].cards[0].frameUrl;await a.execute({action:'link_task',boardId:board.id,cardId:'counter',jobId:'job-1',taskTitle:'Refresh'});assert.equal((await a.list()).boards[0].cards[0].frameUrl,before);await publish(a,board.id);assert.deepEqual((await a.execute({action:'read_card',boardId:board.id,cardId:'counter'})).taskLinks,[{jobId:'job-1',title:'Refresh'}]);assert.deepEqual(await a.getState(board.id,'counter'),{value:9});await a.execute({action:'unlink_task',boardId:board.id,cardId:'counter',jobId:'job-1'});assert.deepEqual((await a.list()).boards[0].cards[0].taskLinks,[]);});
test('opaque pinned document state writes use credential-free CORS simple requests',async()=>{const window={},calls=[],script=runtimeScript().match(/<script>([\s\S]*?)<\/script>/)[1];vm.runInNewContext(script,{window,parent:window,URL,Map,Set,Uint32Array,crypto:globalThis.crypto,location:{href:'http://127.0.0.1:18789/__cryoclaw__/dashboards/b/c?ticket=scoped-write'},document:{hidden:false,documentElement:{toggleAttribute(){}}},matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){},fetch:async(url,options)=>{calls.push({url,options});assert.match(options.headers['Content-Type'],/^text\/plain(?:;|$)/);assert.equal(options.credentials,'omit');assert.deepEqual(JSON.parse(options.body),{title:'本地状态',count:2});return {ok:true,json:async()=>({saved:true})};}});assert.equal((await window.cryoclawDashboard.setState({title:'本地状态',count:2})).saved,true);assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].url.searchParams.get('ticket'),'scoped-write');assert.equal(calls[0].url.searchParams.get('api'),'setState');});


test('motion frames pause offscreen, resume continuously and respect reduced motion',()=>{
 const window={},parent={},events=new Map(),frames=new Map(),media={matches:false,addEventListener(_n,fn){this.change=fn;}},document={hidden:false,documentElement:{toggleAttribute(){}}};let id=0,draws=0;
 const scope={window,parent,URL,Map,Set,Uint32Array,crypto:globalThis.crypto,location:{href:'http://127.0.0.1:18789/__cryoclaw__/dashboards/b/c?ticket=test'},document,matchMedia:()=>media,performance:{now:()=>123},requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key),addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name)=>events.delete(name)};
 vm.runInNewContext(runtimeScript().match(/<script>([\s\S]*?)<\/script>/)[1],scope);
 const sdk=window.cryoclawDashboard,stop=sdk.motion.frame(()=>draws++,{fps:30});assert.equal(frames.size,0);
 const visible=active=>events.get('message')({source:parent,data:{type:'cryoclaw:dashboard:visibility',active}});
 visible(true);assert.equal(frames.size,1);const tick=frames.values().next().value;frames.clear();tick(0);assert.equal(draws,1);assert.equal(frames.size,1);
 visible(false);assert.equal(frames.size,0);visible(true);assert.equal(frames.size,1);media.matches=true;media.change();assert.equal(frames.size,0);assert.equal(draws,2);
 document.hidden=true;events.get('visibilitychange')();assert.equal(draws,2);stop();visible(true);assert.equal(frames.size,0);assert.equal(events.has('pagehide'),false);
});

test('motion.animate pauses/resumes and reduced motion finishes immediately',()=>{
 const window={},parent={},events=new Map(),frames=new Map(),media={matches:false,addEventListener(_n,fn){this.change=fn;}},document={hidden:false,documentElement:{toggleAttribute(){}}};let id=0;
 const scope={window,parent,URL,Map,Set,Uint32Array,crypto:globalThis.crypto,location:{href:'http://127.0.0.1:18789/__cryoclaw__/dashboards/b/c?ticket=test'},document,matchMedia:()=>media,performance:{now:()=>123},requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key),addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name)=>events.delete(name)};
 vm.runInNewContext(runtimeScript().match(/<script>([\s\S]*?)<\/script>/)[1],scope);
 const sdk=window.cryoclawDashboard,visible=active=>events.get('message')({source:parent,data:{type:'cryoclaw:dashboard:visibility',active}}),calls=[];
 const animation={playState:'running',finished:Promise.resolve(),play(){calls.push('play');this.playState='running';},pause(){calls.push('pause');this.playState='paused';},cancel(){calls.push('cancel');this.playState='idle';},finish(){calls.push('finish');}};
 const target={animate:(_keyframes,options)=>{calls.push(options);return animation;}};
 visible(false);const result=sdk.motion.animate(target,[{opacity:0},{opacity:1}],{duration:180});assert.equal(result,animation);assert.equal(animation.playState,'paused');visible(true);assert.equal(animation.playState,'running');result.cancel();assert.ok(calls.includes('cancel'));
 media.matches=true;media.change();sdk.motion.animate(target,[],{});assert.equal(calls.filter(value=>typeof value==='object').at(-1).duration,0);assert.ok(calls.includes('finish'));
});

test('a wheel the card cannot use is handed to the board instead of dying in the sandbox',()=>{
 const window={},parent={posted:[],postMessage(value){this.posted.push(value);}},events=new Map(),frames=new Map(),media={matches:false,addEventListener(){}};let id=0,prevented=0;
 class Element{constructor(style,metrics){this.style=style;Object.assign(this,metrics);this.parentElement=null;}}
 const document={hidden:false,documentElement:{toggleAttribute(){}},scrollingElement:{scrollTop:0,clientHeight:500,scrollHeight:500,style:{overflowY:'auto'}}};
 const scope={window,parent,URL,Map,Set,Uint32Array,crypto:globalThis.crypto,Element,location:{href:'http://127.0.0.1:18789/__cryoclaw__/dashboards/b/c?ticket=test'},document,matchMedia:()=>media,performance:{now:()=>1},getComputedStyle:element=>element.style,innerHeight:800,requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key),addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{if(events.get(name)===fn)events.delete(name);}};
 vm.runInNewContext(runtimeScript().match(/<script>([\s\S]*?)<\/script>/)[1],scope);
 const wheel=events.get('wheel');assert.equal(typeof wheel,'function','wheel listener registered inside a card');
 const send=(target,deltaY=240)=>wheel({target,deltaY,deltaX:0,deltaMode:0,ctrlKey:false,defaultPrevented:false,preventDefault(){prevented++;}});
 const flush=()=>{const next=frames.values().next().value;frames.clear();next();};
 send(new Element({overflowY:'hidden'},{scrollTop:0,clientHeight:400,scrollHeight:400}));assert.equal(prevented,1,'a non-scrollable card must not swallow the gesture');
 assert.equal(frames.size,1);flush();const posted=parent.posted.at(-1);assert.equal(posted.type,'cryoclaw:dashboard');assert.equal(posted.action,'wheel');assert.equal(posted.value.dy,240);
 send(new Element({overflowY:'auto'},{scrollTop:0,clientHeight:300,scrollHeight:900}));assert.equal(prevented,1,'an inner auto scroller keeps its own gesture');assert.equal(frames.size,0,'a scrollable card schedules nothing');
 send(new Element({overflowY:'hidden'},{scrollTop:0,clientHeight:400,scrollHeight:400}),200);send(new Element({overflowY:'hidden'},{scrollTop:0,clientHeight:400,scrollHeight:400}),100);
 assert.equal(frames.size,1,'multiple wheel ticks share one frame message');flush();assert.equal(parent.posted.at(-1).value.dy,300);
 send(new Element({overflowY:'hidden'},{scrollTop:0,clientHeight:400,scrollHeight:400}),-300);flush();assert.equal(parent.posted.at(-1).value.dy,-300);
});
