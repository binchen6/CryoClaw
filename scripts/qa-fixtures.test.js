const test=require('node:test'),assert=require('node:assert/strict');
const {isOwnedQaSession,cleanupOwnedQa}=require('./lib/qa-fixtures');
test('QA cleanup preserves real conversations and unrelated native tasks',()=>{
 for(const row of [{key:'agent:main:main',displayName:'QA'}, {key:'agent:main:ordinary',displayName:'Release QA · model dashboard'}, {key:'agent:main:cron:11111111-1111-1111-1111-111111111111:run:aaa',displayName:'Automation: Memory Dreaming'}])assert.equal(isOwnedQaSession(row),false);
 assert.equal(isOwnedQaSession({key:'agent:main:dashboard-live-qa-1792767816714'}),true);
 assert.equal(isOwnedQaSession({key:'agent:main:cron:11111111-1111-1111-1111-111111111111:run:aaa',displayName:'Automation: QA · one native dashboard update'}),true);
});
test('cleanup uses expected identity and checks active and archived records',async()=>{
 const calls=[],key='agent:main:dashboard-qa-1792767816714';
 const request=async(name,p)=>{calls.push({name,p});if(name==='cron.list')return {jobs:[]};if(name==='sessions.list')return {sessions:p.archived?[]:[{key,sessionId:'exact-id'},{key:'agent:main:main',sessionId:'protected'}]};if(name==='sessions.delete')return {deleted:true,archived:[]};return {};};
 const r=await cleanupOwnedQa(request);assert.equal(r.sessions.length,1);assert.deepEqual(calls.find(c=>c.name==='sessions.delete').p,{key,agentId:'main',expectedSessionId:'exact-id',deleteTranscript:true});assert.equal(calls.filter(c=>c.name==='sessions.list').length,2);
});
