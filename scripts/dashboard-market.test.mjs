import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSourceBroker} from '../builtin-plugins/cryoclaw-dashboards/network.mjs';
import {exampleCards} from '../builtin-plugins/cryoclaw-dashboards/examples.mjs';
import {parseTencentQuotes} from '../builtin-plugins/cryoclaw-dashboards/market-quotes.mjs';
import {upgradeLegacyMarketHtml} from '../builtin-plugins/cryoclaw-dashboards/market-watch.mjs';
import {createDashboardStore} from '../builtin-plugins/cryoclaw-dashboards/store.mjs';
import {injectRuntime} from '../builtin-plugins/cryoclaw-dashboards/runtime.mjs';

const source={url:'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f2,f3,f124&secids=1.600519,0.300750,0.002594',format:'json',refreshSeconds:60};
const ids=['sh600519','sz300750','sz002594'];
function quotes({date='20261023161458',price='1335.00'}={}){return ids.map((id,i)=>{const fields=Array(34).fill('');fields[1]=['Moutai','CATL','BYD'][i];fields[2]=id.slice(2);fields[3]=price;fields[30]=date;fields[32]='1.25';return `v_${id}="${fields.join('~')}";`;}).join('\n');}
const body=text=>({body:Buffer.from(text),mime:'text/html'});

test('built-in A-share source switches after reset and preserves the old card value shape',async()=>{
 const calls=[];const broker=createSourceBroker({now:()=>1000,fetchBody:async(url,options)=>{calls.push({url,options});if(url.includes('eastmoney.com'))throw Object.assign(Error('socket hang up'),{code:'ECONNRESET'});return body(quotes());}});
 const result=await broker.data(source);assert.equal(calls.length,2);assert.equal(calls[1].url,'https://qt.gtimg.cn/q=sh600519,sz300750,sz002594');
 assert.equal(result.value.data.diff[0].f2,1335);assert.equal(result.value.data.diff[0].f3,1.25);assert.equal(result.value.data.diff[0].f124,Date.parse('2026-10-23T16:14:58+08:00')/1000);
 assert.equal(result.provider,'腾讯证券');assert.equal(result.source,calls[1].url);assert.equal(result.declaredSource,source.url);assert.equal(result.fallback,true);assert.equal(result.fetchedAt,1000);
 assert.ok(calls[0].options.expires<calls[1].options.expires);assert.ok(calls[1].options.maxBytes<=524288);
});

test('fallback is limited to the shipped A-share endpoint and exact watchlist',async()=>{
 for(const changed of [source.url.replace('push2.eastmoney.com','public.org'),source.url.replace('1.600519','1.600000'),source.url.replace('ulist.np/get','stock/get')]){
  let calls=0;const broker=createSourceBroker({fetchBody:async()=>{calls++;throw Error('socket hang up');}});await assert.rejects(broker.data({...source,url:changed}),/socket hang up/);assert.equal(calls,1);
 }
});

test('invalid or empty primary quotes use the independent source, never fake zero prices',async()=>{
 let calls=0;const broker=createSourceBroker({fetchBody:async()=>++calls===1?body('{"rc":0,"data":null}'):body(quotes())});
 const result=await broker.data(source);assert.equal(result.fallback,true);assert.equal(result.value.data.diff.length,3);
});

test('a valid primary response keeps its source and does not contact the fallback',async()=>{
 let calls=0;const diff=ids.map(id=>({f12:id.slice(2),f14:id,f2:100,f3:1,f124:1792743298}));
 const broker=createSourceBroker({fetchBody:async()=>{calls++;return body(JSON.stringify({rc:0,data:{diff}}));}});
 const result=await broker.data(source);assert.equal(calls,1);assert.equal(result.source,source.url);assert.equal(result.provider,'东方财富');assert.equal(result.fallback,undefined);assert.deepEqual(result.value.data.diff,diff);
});

test('built-in 20-day adjusted history recovers from reset without changing legacy klines',async()=>{
 const url='https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&lmt=20&end=20500101&fields1=f1&fields2=f51,f52,f53',calls=[];
 const broker=createSourceBroker({fetchBody:async target=>{calls.push(target);if(target===url)throw Error('socket hang up');return body(JSON.stringify({code:0,data:{sh600519:{qfqday:[['2026-10-22','1303.210','1318.490'],['2026-10-23','1311.840','1335.000']]}}}));}});
 const result=await broker.data({...source,url,refreshSeconds:3600});assert.equal(result.provider,'腾讯证券');assert.equal(result.declaredSource,url);assert.equal(result.source,'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,20,qfq');assert.deepEqual(result.value.data.klines,['2026-10-22,1303.21,1318.49','2026-10-23,1311.84,1335']);assert.equal(calls.length,2);
 for(const changed of [url.replace('lmt=20','lmt=100'),url.replace('1.600519','1.600000'),url.replace('fqt=1','fqt=2')]){let count=0;const strict=createSourceBroker({fetchBody:async()=>{count++;throw Error('original error');}});await assert.rejects(strict.data({...source,url:changed}),/original error/);assert.equal(count,1);}
});

test('expired successful quote survives a failed refresh with original acquisition time and bounded retry',async()=>{
 let now=1000,calls=0,available=true;const broker=createSourceBroker({now:()=>now,fetchBody:async url=>{calls++;if(available&&url.includes('gtimg.cn'))return body(quotes());throw Error('socket hang up');}});
 const first=await broker.data(source);available=false;now+=61000;const stale=await broker.data(source);
 assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,first.fetchedAt);assert.deepEqual(stale.value,first.value);assert.equal(stale.source,first.source);assert.ok(stale.retryAt>now);
 const after=calls;assert.equal((await broker.data(source)).stale,true);assert.equal(calls,after,'immediate retries share the failure backoff');
 now+=15001;await broker.data(source);assert.ok(calls>after);
});

test('new failures have a short cooldown and reject malformed Tencent prices and dates',async()=>{
 let now=1000,calls=0;const broker=createSourceBroker({now:()=>now,fetchBody:async url=>{calls++;if(url.includes('eastmoney.com'))throw Error('socket hang up');return body(quotes({date:'20261342161458',price:'invalid'}));}});
 await assert.rejects(broker.data(source),/行情源暂不可用/);const after=calls;await assert.rejects(broker.data(source),/行情源暂不可用/);assert.equal(calls,after);now+=15001;await assert.rejects(broker.data(source));assert.ok(calls>after);
});

test('GB18030 Chinese quote names decode without evaluating the response envelope',()=>{
 const parts=quotes().split('Moutai');const raw=Buffer.concat([Buffer.from(parts[0]),Buffer.from('b9f3d6ddc3a9cca8','hex'),Buffer.from(parts[1])]);
 assert.equal(parseTencentQuotes(raw).data.diff[0].f14,'贵州茅台');
 assert.throws(()=>parseTencentQuotes(Buffer.from('globalThis.executed=true;')),/Incomplete/);
 assert.throws(()=>parseTencentQuotes(Buffer.from(quotes({date:'20260230161458'}))),/Invalid/);
});

const oldStamp=`document.getElementById('stamp').textContent='东方财富 · 源时间 '+(stamp?new Date(stamp*1000).toLocaleString():'未提供')+' · 每分钟检查';document.getElementById('status').textContent='';`;
const legacyHtml=fs.readFileSync(new URL('./fixtures/dashboard-market-legacy.html',import.meta.url),'utf8');

test('known published example displays actual provider metadata through new runtime injection',async()=>{
 const html=upgradeLegacyMarketHtml(legacyHtml,[{id:'stocks',...source}]),elements={stamp:{},status:{},stocks:{replaceChildren(){}}};
 for(const script of injectRuntime(html).matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1],node=()=>({style:{},append(){}});
 vm.runInNewContext(script,{document:{getElementById:id=>elements[id],createElement:node},cryoclawDashboard:{data:async()=>({value:{data:{diff:[{f14:'Moutai',f124:1792743298}]}},provider:'腾讯证券',fallback:true,stale:true})},Date,setInterval(){}});
 await new Promise(resolve=>setImmediate(resolve));assert.match(elements.stamp.textContent,/腾讯证券.*上次成功数据/);assert.match(elements.status.textContent,/保留上次成功数据/);
 for(const custom of [legacyHtml.replace(oldStamp,"document.getElementById('stamp').textContent='My custom footer';"),legacyHtml.replace('<script>','<script>const modelCustom=1;'),'<html><b>Custom widget</b></html>'])assert.equal(upgradeLegacyMarketHtml(custom,[{id:'stocks',...source}]),custom);
 assert.equal(upgradeLegacyMarketHtml(legacyHtml,[{id:'stocks',...source,url:source.url.replace('600519','600000')}]),legacyHtml);
});

test('read-time legacy adaptation leaves stored HTML, state and card identity unchanged',async t=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-market-')),store=createDashboardStore({stateDir,secret:'market regression'});
 t.after(()=>{store.close();fs.rmSync(stateDir,{recursive:true,force:true});});
 const {board}=await store.execute({action:'create',title:'Existing board'});
 await store.execute({action:'publish_card',boardId:board.id,cardId:'market-watch',title:'A 股盯盘',html:legacyHtml,dataSources:[{id:'stocks',...source}]});
 await store.setState(board.id,'market-watch',{keep:'local'});const before=(await store.list()).boards[0].cards[0].frameUrl;
 const ticket=new URL(before,'http://localhost').searchParams.get('ticket'),document=await store.document(board.id,'market-watch',ticket);
 assert.match(document.html,/r\.provider/);assert.equal((await store.execute({action:'read_card',boardId:board.id,cardId:'market-watch'})).html,legacyHtml);
 assert.deepEqual(await store.getState(board.id,'market-watch'),{keep:'local'});assert.equal((await store.list()).boards[0].cards[0].frameUrl,before);
});

test('market refresh preserves visible quotes on failure and exposes a retry control',async()=>{
 const card=exampleCards.find(card=>card.cardId==='market-watch'),elements=new Map();
 const node=()=>({textContent:'',disabled:false,style:{},children:[],append(...values){this.children.push(...values);},replaceChildren(...values){this.children=values;},setAttribute(){}});
 for(const name of ['refresh','stocks','stamp','status'])elements.set(name,node());let fail=false,calls=0;const intervals=[];
 const scope={document:{getElementById:id=>elements.get(id),createElement:node,querySelectorAll:()=>[]},cryoclawDashboard:{data:async id=>{calls++;if(fail)throw Error('socket hang up');if(id!=='stocks')return {value:{data:{klines:[]}}};return {value:{data:{diff:[{f12:'600519',f14:'Moutai',f2:1335,f3:1.25,f124:1792743298}]}},provider:'腾讯证券',source:'https://qt.gtimg.cn/q=sh600519',fallback:true};}},setInterval:fn=>intervals.push(fn),Date,Number,Array,Math};
 for(const script of card.html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInNewContext(script[1],scope);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(elements.get('stocks').children.length,1);assert.match(elements.get('stamp').textContent,/腾讯证券/);assert.equal(typeof elements.get('refresh').onclick,'function');
 const previous=elements.get('stocks').children;fail=true;await elements.get('refresh').onclick();assert.equal(elements.get('stocks').children,previous);assert.match(elements.get('status').textContent,/保留上次|已显示|稍后重试/);assert.equal(elements.get('refresh').disabled,false);assert.equal(intervals.length,1);assert.ok(calls>=2);
});
