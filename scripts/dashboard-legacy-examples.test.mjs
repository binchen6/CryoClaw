import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {upgradeLegacyExampleHtml} from '../builtin-plugins/cryoclaw-dashboards/legacy-examples.mjs';
import {createDashboardStore} from '../builtin-plugins/cryoclaw-dashboards/store.mjs';
import {starterCards} from '../builtin-plugins/cryoclaw-dashboards/starter.mjs';
const legacy=fs.readFileSync(new URL('./fixtures/dashboard-welcome-legacy.html',import.meta.url),'utf8');
const legacyVideo=fs.readFileSync(new URL('./fixtures/dashboard-media-20261025-legacy.html',import.meta.url),'utf8');
const before1025=JSON.parse(fs.readFileSync(new URL('./fixtures/dashboard-examples-20261025-contracts.json',import.meta.url),'utf8'));
const flower={id:'flower',url:'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'};
const promoUrl='https://cryoconite.cn/CryoClaw/assets/cryoclaw-demo.mp4?v=2026.1025.0';

function fixture(t){const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-showcase-')),store=createDashboardStore({stateDir,secret:Buffer.alloc(32,1)});t.after(()=>{store.close();fs.rmSync(stateDir,{recursive:true,force:true});});return {stateDir,store};}
function rewriteStoredBoard({stateDir,store},boardId,edit){store.close();const db=new DatabaseSync(path.join(stateDir,'cryoclaw-dashboards','dashboards.sqlite'));try{const catalog=JSON.parse(db.prepare('SELECT json FROM catalog WHERE id=1').get().json);edit(catalog.boards.find(board=>board.id===boardId));db.prepare('UPDATE catalog SET json=? WHERE id=1').run(JSON.stringify(catalog));}finally{db.close();}}

test('existing shipped welcome receives the pointer-responsive script, while custom HTML is untouched',()=>{
 const upgraded=upgradeLegacyExampleHtml(legacy);assert.notEqual(upgraded,legacy);assert.match(upgraded,/addEventListener\('pointermove'/);assert.match(upgraded,/data-template-responsive/);
 const custom=legacy+'<!-- user change -->';assert.equal(upgradeLegacyExampleHtml(custom),custom);
});

test('read-time sample upgrades retain saved HTML, arbitrary identity, state, capability and user geometry',async t=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-legacy-'));const store=createDashboardStore({stateDir,secret:Buffer.alloc(32,1)});t.after(()=>{store.close();fs.rmSync(stateDir,{recursive:true,force:true});});
 const {board}=await store.execute({action:'create',title:'My customized board'});await store.execute({action:'publish_card',boardId:board.id,cardId:'copied-welcome',title:'My welcome',html:legacy,layout:{w:5.257,h:370,free:true,order:0}});await store.setState(board.id,'copied-welcome',{text:'keep local input'});
 const before=(await store.list()).boards[0].cards[0],ticket=new URL(before.frameUrl,'http://localhost').searchParams.get('ticket');const shown=await store.document(board.id,'copied-welcome',ticket);assert.match(shown.html,/addEventListener\('pointermove'/);
 const stored=await store.execute({action:'read_card',boardId:board.id,cardId:'copied-welcome'});assert.equal(stored.html,legacy);assert.deepEqual(await store.getState(board.id,'copied-welcome'),{text:'keep local input'});const after=(await store.list()).boards[0].cards[0];assert.deepEqual(after.layout,before.layout);assert.equal(after.frameUrl,before.frameUrl);
});

test('the 21-card showcase opens with a lead and notes on one complete row',async t=>{
 const {store}=fixture(t),created=await store.execute({action:'create_example'}),board=(await store.list()).boards.find(board=>board.id===created.board.id);
 assert.equal(board.cards.length,21);assert.deepEqual(board.cards.slice(0,2).map(card=>[card.id,card.layout.w,card.layout.h]),[['welcome',8,340],['quick-notes',4,340]]);
 let width=0,height=0;for(const card of board.cards){if(width===0)height=card.layout.h;assert.equal(card.layout.h,height,'cards sharing a desktop row must align at the bottom');width+=card.layout.w;assert.ok(width<=12,'no card should force an unplanned wrap');if(width===12)width=0;}assert.equal(width,0,'the last row must also be complete');
 const media=await store.execute({action:'read_card',boardId:board.id,cardId:'media-demo'});assert.deepEqual(media.assets,[{id:'promo',url:promoUrl}]);
});

test('an untouched before1025 showcase receives new geometry without rewriting saved cards or state',async t=>{
 const f=fixture(t),created=await f.store.execute({action:'create_example'});await f.store.setState(created.board.id,'quick-notes',{text:'saved note'});
 rewriteStoredBoard(f,created.board.id,board=>{for(const contract of before1025)board.cards.find(card=>card.id===contract.id).layout=contract.layout;});
 const before=await f.store.execute({action:'read_card',boardId:created.board.id,cardId:'quick-notes'}),board=(await f.store.list()).boards.find(board=>board.id===created.board.id);
 assert.equal(board.cards.find(card=>card.id==='welcome').layout.w,8);assert.equal(board.cards.find(card=>card.id==='media-demo').layout.w,8);
 assert.deepEqual(await f.store.getState(board.id,'quick-notes'),{text:'saved note'});assert.deepEqual(await f.store.execute({action:'read_card',boardId:board.id,cardId:'quick-notes'}),before);
 f.store.close();const db=new DatabaseSync(path.join(f.stateDir,'cryoclaw-dashboards','dashboards.sqlite'));try{const saved=JSON.parse(db.prepare('SELECT json FROM catalog WHERE id=1').get().json).boards.find(item=>item.id===board.id);assert.deepEqual(saved.cards.find(card=>card.id==='welcome').layout,before1025[0].layout);}finally{db.close();}
});

test('showcase layout adaptation preserves any user resize, reorder or edited card',async t=>{
 for(const edit of [board=>{board.cards[0].layout.w=7.257;board.cards[0].layout.free=true;},board=>{board.cards[0].layout.order=99;},board=>{board.cards.find(card=>card.id==='quick-notes').html+='<!-- custom -->';}]){
  const f=fixture(t),created=await f.store.execute({action:'create_example'});rewriteStoredBoard(f,created.board.id,board=>{for(const contract of before1025)board.cards.find(card=>card.id===contract.id).layout=structuredClone(contract.layout);edit(board);});
  const board=(await f.store.list()).boards.find(board=>board.id===created.board.id),welcome=board.cards.find(card=>card.id==='welcome');assert.notEqual(welcome.layout.w,8,'an adapted layout must never reset a customized showcase');
 }
});

test('only the exact shipped Flower document and asset contract resolve to the official promo',async t=>{
 const {store}=fixture(t),{board}=await store.execute({action:'create',title:'Videos'});
 for(const [id,html,assets,upgrade]of [['original',legacyVideo,[flower],true],['edited-html',legacyVideo+'<!-- mine -->',[flower],false],['edited-asset',legacyVideo,[{...flower,url:flower.url+'?my-copy=1'}],false],['extra-asset',legacyVideo,[flower,{id:'other',url:'https://example.com/other.mp4'}],false]]){
  await store.execute({action:'publish_card',boardId:board.id,cardId:id,title:id,html,assets,layout:{w:5.257,h:370,free:true,order:0}});await store.setState(board.id,id,{position:12});
  const card=(await store.list()).boards.find(item=>item.id===board.id).cards.find(card=>card.id===id),ticket=new URL(card.frameUrl,'http://localhost').searchParams.get('ticket'),shown=await store.document(board.id,id,ticket);
  if(upgrade){assert.match(shown.html,/asset\('promo'\)/);assert.equal((await store.source(board.id,id,'promo',true)).url,promoUrl);}
  else{assert.equal(shown.html,html);assert.equal((await store.source(board.id,id,'flower',true)).url,assets[0].url);await assert.rejects(store.source(board.id,id,'promo',true),/not declared/);}
  assert.deepEqual(await store.getState(board.id,id),{position:12});assert.deepEqual((await store.list()).boards[0].cards.find(card=>card.id===id).layout,card.layout);assert.equal((await store.execute({action:'read_card',boardId:board.id,cardId:id})).html,html);
 }
});
