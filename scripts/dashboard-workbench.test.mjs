import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDashboardStore} from '../builtin-plugins/cryoclaw-dashboards/store.mjs';

async function fixture(t){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-workbench-'));
 const store=createDashboardStore({stateDir,secret:'workbench test'});
 t.after(()=>{store.close();fs.rmSync(stateDir,{recursive:true,force:true});});
 const {board}=await store.execute({action:'create',title:'工作台',description:'每日项目进展'});
 await store.execute({action:'publish_card',boardId:board.id,cardId:'notes',title:'Notes',html:'<html><body><button>Keep</button></body></html>'});
 return {store,board};
}

test('board details can clear their description without touching card identity or state',async t=>{
 const {store,board}=await fixture(t);
 await store.setState(board.id,'notes',{text:'keep local'});
 const before=(await store.list()).boards[0].cards[0].frameUrl;
 await store.execute({action:'rename',boardId:board.id,title:'New title',description:''});
 const after=(await store.list()).boards[0];
 assert.equal(after.description,'');assert.equal(after.title,'New title');
 assert.equal(after.cards[0].frameUrl,before);
 assert.deepEqual(await store.getState(board.id,'notes'),{text:'keep local'});
});

test('archived boards reject layout and card deletion but allow detail edits and restoration',async t=>{
 const {store,board}=await fixture(t);
 await store.execute({action:'archive',boardId:board.id});
 for(const args of [{action:'layout',layouts:[{cardId:'notes',w:12}]},{action:'remove_card',cardId:'notes'}]){
  await assert.rejects(store.execute({...args,boardId:board.id}),/Restore/);
 }
 await store.execute({action:'rename',boardId:board.id,title:'Archived',description:''});
 await store.execute({action:'restore',boardId:board.id});
 assert.equal((await store.list()).boards[0].cards.length,1);
});

test('template insertion creates independent cards and leaves existing state and layout intact',async t=>{
 const {store,board}=await fixture(t);
 await store.setState(board.id,'notes',{text:'original'});
 const templates=await store.templates();
 assert.ok(templates.cards.some(item=>item.id==='quick-notes'));
 assert.ok(templates.boards.some(item=>item.id==='productivity'));
 const a=await store.execute({action:'add_template',boardId:board.id,templateId:'quick-notes'});
 const b=await store.execute({action:'add_template',boardId:board.id,templateId:'quick-notes'});
 assert.notEqual(a.cardId,b.cardId);
 await store.setState(board.id,a.cardId,{text:'only a'});
 assert.equal(await store.getState(board.id,b.cardId),null);
 assert.deepEqual(await store.getState(board.id,'notes'),{text:'original'});
 const summary=(await store.list()).boards[0];assert.equal(summary.cards.length,3);
 assert.equal(summary.cards[0].id,'notes');
 await assert.rejects(store.execute({action:'add_template',boardId:board.id,templateId:'missing'}),/template/i);
 await store.execute({action:'archive',boardId:board.id});
 await assert.rejects(store.execute({action:'add_template',boardId:board.id,templateId:'quick-notes'}),/Restore/);
});

test('curated board templates start with selected modules and a useful description',async t=>{
 const {store}=await fixture(t);
 const {board}=await store.execute({action:'create_template',templateId:'productivity',title:'Daily'});
 const next=(await store.list()).boards.find(item=>item.id===board.id);
 assert.ok(next.cards.length>=3&&next.cards.length<21);
 assert.ok(next.description.length>0);
 assert.equal(new Set(next.cards.map(card=>card.id)).size,next.cards.length);
});
test('layout persists continuous fractional widths across store reload',async t=>{
 const {store,board}=await fixture(t);await store.execute({action:'layout',boardId:board.id,layouts:[{cardId:'notes',w:5.257,h:387,order:0}]});
 const card=(await store.list()).boards.find(b=>b.id===board.id).cards[0];assert.equal(card.layout.w,5.257);assert.equal(card.layout.h,387);
});
