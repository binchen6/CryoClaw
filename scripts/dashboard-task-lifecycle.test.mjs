import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDashboardStore} from '../builtin-plugins/cryoclaw-dashboards/store.mjs';
import {createAuthenticatedCronRequest,targetsDashboardCard} from '../builtin-plugins/cryoclaw-dashboards/task-lifecycle.mjs';

const message=(boardId,cardId)=>`Update\n\n[cryoclaw-dashboard-target]\nboardId=${boardId}\ncardId=${cardId}\nKeep this target.\n[/cryoclaw-dashboard-target]`;
async function fixture(t){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-lifecycle-')),store=createDashboardStore({stateDir,secret:'fixture'}),jobs=new Map(),calls=[];
 t.after(()=>{store.close();fs.rmSync(stateDir,{recursive:true,force:true});});
 const request=async(method,p)=>{calls.push({method,...p});if(method==='cron.get'){if(!jobs.has(p.id))throw Error('Unknown job');return structuredClone(jobs.get(p.id));}if(method==='cron.update'){const job=jobs.get(p.id);assert.equal(p.expectedConfigRevision,job.configRevision);Object.assign(job,p.patch);job.configRevision+='x';return structuredClone(job);}throw Error('Unexpected cron method');};
 const board=(await store.execute({action:'create',title:'Board'})).board;
 for(const cardId of ['one','two'])await store.execute({action:'publish_card',boardId:board.id,cardId,title:cardId,html:'<b>Card</b>'});
 const link=async(id,cardId='one',targetCard=cardId)=>{jobs.set(id,{id,configRevision:'v1',enabled:true,payload:{kind:'agentTurn',message:message(board.id,targetCard)}});await store.execute({action:'link_task',boardId:board.id,cardId,jobId:id});};
 return {stateDir,store,jobs,calls,board,request,link};
}
for(const action of ['archive','delete','remove_card'])test(`${action} centrally pauses only linked jobs for the exact board and card`,async t=>{
 const f=await fixture(t);await f.link('owned');await f.link('wrong-card','one','two');await f.link('other-card','two');f.jobs.set('unlinked',{id:'unlinked',enabled:true,payload:{kind:'agentTurn',message:message(f.board.id,'one')}});
 await f.store.execute({action,boardId:f.board.id,cardId:'one',confirmDelete:true},undefined,undefined,f.request);
 assert.equal(f.jobs.get('owned').enabled,false);assert.equal(f.jobs.get('wrong-card').enabled,true);assert.equal(f.jobs.get('unlinked').enabled,true);assert.equal(f.jobs.get('other-card').enabled,action==='remove_card');assert.ok(f.calls.every(c=>c.method!=='cron.list'));
});
test('missing cron authority prevents archive and preserves the board',async t=>{
 const f=await fixture(t);await f.link('owned');await assert.rejects(f.store.execute({action:'archive',boardId:f.board.id},undefined,undefined,async()=>{throw Error('missing scope: operator.admin');}),/operator.admin/);assert.equal((await f.store.list()).boards[0].archived,false);
});
test('enabling and archiving share one lifecycle queue; an archived target cannot be enabled',async t=>{
 const f=await fixture(t);await f.link('owned');f.jobs.get('owned').enabled=false;let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const request=async(method,p)=>{if(method==='cron.update'&&p.patch.enabled){entered();await gate;}return f.request(method,p);};
 const enable=f.store.execute({action:'enable_task',boardId:f.board.id,cardId:'one',jobId:'owned'},undefined,undefined,request);await started;
 const archive=f.store.execute({action:'archive',boardId:f.board.id},undefined,undefined,f.request);release();await enable;await archive;assert.equal(f.jobs.get('owned').enabled,false);
 await assert.rejects(f.store.execute({action:'enable_task',boardId:f.board.id,cardId:'one',jobId:'owned'},undefined,undefined,f.request),/Restore|unavailable/i);assert.equal(f.jobs.get('owned').enabled,false);
});
test('a concurrent store change while pausing cannot delete an unpaused new binding',async t=>{
 const f=await fixture(t);await f.link('owned');const sibling=createDashboardStore({stateDir:f.stateDir,secret:'fixture'});
 let changed=false;const request=async(method,p)=>{const result=await f.request(method,p);if(!changed){changed=true;await sibling.execute({action:'link_task',boardId:f.board.id,cardId:'one',jobId:'new-job'});}return result;};
 try{await assert.rejects(f.store.execute({action:'delete',boardId:f.board.id,confirmDelete:true},undefined,undefined,request),/changed/i);assert.equal((await f.store.list()).boards.length,1);}finally{sibling.close();}
});
test('authenticated dispatch unwraps failures and never requests synthetic scopes',async()=>{
 const calls=[];let ok=true;const request=createAuthenticatedCronRequest(async()=>({dispatchGatewayMethod:async(...args)=>{calls.push(args);return ok?{ok:true,payload:{id:'owned'}}:{ok:false,error:{message:'missing scope: operator.admin'}};}}));
 assert.deepEqual(await request('cron.get',{id:'owned'}),{id:'owned'});ok=false;await assert.rejects(request('cron.update',{id:'owned',patch:{enabled:false}}),/operator.admin/);assert.equal(calls.every(args=>args.length===2),true);
});
test('target markers reject wrong cards, partial markers and ambiguous multiple blocks',()=>{
 const job=message=>({payload:{kind:'agentTurn',message}});const valid=message('board','card');assert.equal(targetsDashboardCard(job(valid),'board','card'),true);assert.equal(targetsDashboardCard(job(valid),'board','other'),false);assert.equal(targetsDashboardCard(job(valid.replace('[/cryoclaw-dashboard-target]','')),'board','card'),false);assert.equal(targetsDashboardCard(job(valid+'\n'+valid),'board','card'),false);
});
test('a job definition changed after lookup is never paused or archived',async t=>{
 const f=await fixture(t);await f.link('owned');const request=async(method,p)=>{if(method==='cron.update'){f.jobs.get(p.id).configRevision='changed';throw Error('Cron job changed; refresh');}return f.request(method,p);};
 await assert.rejects(f.store.execute({action:'archive',boardId:f.board.id},undefined,undefined,request),/changed/);assert.equal(f.jobs.get('owned').enabled,true);assert.equal((await f.store.list()).boards[0].archived,false);
});
test('cross-store archival during activation is detected and the exact task is paused again',async t=>{
 const f=await fixture(t);await f.link('owned');f.jobs.get('owned').enabled=false;const sibling=createDashboardStore({stateDir:f.stateDir,secret:'fixture'});let changed=false;
 const request=async(method,p)=>{if(method==='cron.update'&&p.patch.enabled&&!changed){changed=true;await sibling.execute({action:'archive',boardId:f.board.id},undefined,undefined,f.request);}return f.request(method,p);};
 try{await assert.rejects(f.store.execute({action:'enable_task',boardId:f.board.id,cardId:'one',jobId:'owned'},undefined,undefined,request),/changed/);assert.equal((await f.store.list({includeArchived:true})).boards[0].archived,true);assert.equal(f.jobs.get('owned').enabled,false);}finally{sibling.close();}
});
test('canceled lifecycle requests perform no cron writes and keep the board active',async t=>{
 const f=await fixture(t);await f.link('owned');await assert.rejects(f.store.execute({action:'archive',boardId:f.board.id},()=>{throw Error('canceled');},undefined,f.request),/canceled/);assert.equal(f.calls.length,0);assert.equal((await f.store.list()).boards[0].archived,false);
});
