import test from 'node:test';import assert from 'node:assert/strict';import {createDashboardTask,dashboardTaskMessage} from './dashboard-tasks.ts';import type {GatewayBrowserClient} from './gateway.ts';
test('scheduled card update links a paused native job then delegates activation to the dashboard lifecycle',async()=>{
 const calls:Array<{name:string;params:unknown}>=[];const client={request:async(name:string,params:unknown)=>{calls.push({name,params});return name==='cron.add'?{id:'job-1'}:{};}} as unknown as GatewayBrowserClient;
 await createDashboardTask(client,{boardId:'board',cardId:'card',title:'Report',instructions:'Update actual data',minutes:60});
 assert.deepEqual(calls.map(c=>c.name),['cron.add','cryoclaw.dashboards.mutate','cryoclaw.dashboards.mutate']);
 const add=calls[0].params as {enabled:boolean;payload:{message:string};schedule:{everyMs:number}};assert.equal(add.enabled,false);assert.equal(add.schedule.everyMs,3600000);assert.match(add.payload.message,/SAME boardId\/cardId/);assert.match(add.payload.message,/boardId=board\ncardId=card/);
 assert.equal((calls[1].params as {action:string}).action,'link_task');const {requestId,...activation}=calls[2].params as Record<string,unknown>;assert.ok(requestId);assert.deepEqual(activation,{action:'enable_task',boardId:'board',cardId:'card',jobId:'job-1'});
});
test('failed binding leaves the native job paused',async()=>{
 const names:string[]=[];const client={request:async(name:string)=>{names.push(name);if(name==='cron.add')return {id:'job-1'};throw Error('link failed');}} as unknown as GatewayBrowserClient;
 await assert.rejects(createDashboardTask(client,{boardId:'board',cardId:'card',title:'Report',instructions:'Update',minutes:60}),/link failed/);assert.deepEqual(names,['cron.add','cryoclaw.dashboards.mutate']);assert.throws(()=>dashboardTaskMessage('../bad','card','update'));
});
test('an activation refusal is returned without a direct cron enable fallback',async()=>{
 const calls:string[]=[];const client={request:async(name:string,params:{action?:string})=>{calls.push(name);if(name==='cron.add')return {id:'job-1'};if(params.action==='enable_task')throw Error('Dashboard task unavailable');return {};}} as unknown as GatewayBrowserClient;
 await assert.rejects(createDashboardTask(client,{boardId:'board',cardId:'card',title:'Report',instructions:'Update',minutes:60}),/unavailable/);assert.equal(calls.includes('cron.update'),false);
});
