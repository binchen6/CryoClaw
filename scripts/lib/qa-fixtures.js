'use strict';
const fs=require('node:fs'),path=require('node:path');
const OWNED=/^agent:main:(?:dashboard-qa|dashboard-live-qa|data-query-qa|deliverables-live-qa|release-smoke)-\d{13}$/;
const CRON_QA_NAME=/^(?:Automation:\s*)?QA\s*·\s*one native dashboard update$/;
function isOwnedQaSession(row,jobIds=new Set()){
 if(OWNED.test(row.key))return true;const match=/^agent:main:cron:([a-f\d-]{36})(?::run:[\w-]+)?$/.exec(row.key??'');
 return !!match&&(jobIds.has(match[1])||[row.displayName,row.label,row.derivedTitle].some(v=>typeof v==='string'&&CRON_QA_NAME.test(v)));
}
// Write ownership as soon as a fixture exists, so an interrupted run can be cleaned later.
function recordQaFixtures(out,value){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'qa-fixtures.json'),JSON.stringify({sessionKey:value.sessionKey,boardIds:value.boardIds??(value.dashboardId?[value.dashboardId]:value.boards??[]),jobIds:value.jobIds??value.jobs??[]},null,2));}
function collectQaFixtureIds(roots){
 const boards=new Set(),jobs=new Set();
 for(const root of roots){if(!fs.existsSync(root))continue;for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink())continue;for(const name of ['qa-fixtures.json','report.json','live-cron-report.json']){try{const r=JSON.parse(fs.readFileSync(path.join(root,entry.name,name),'utf8'));for(const id of r.boardIds??r.boards??[])if(typeof id==='string')boards.add(id);if(r.dashboardId)boards.add(r.dashboardId);if(r.liveDashboard?.boardId)boards.add(r.liveDashboard.boardId);for(const id of r.jobIds??r.jobs??[])if(typeof id==='string')jobs.add(id);if(r.liveCron?.jobId)jobs.add(r.liveCron.jobId);if(name==='live-cron-report.json'&&r.jobId)jobs.add(r.jobId);}catch{}}}}
 return {boardIds:[...boards],jobIds:[...jobs]};
}
async function cleanupOwnedQa(request,{boardIds=[],jobIds=[]}={}){
 const jobs=new Set(jobIds),report={sessions:[],jobs:[],boards:[],errors:[]};
 const cron=await request('cron.list',{includeDisabled:true});
 for(const job of cron.jobs??[])if(jobs.has(job.id)||CRON_QA_NAME.test(job.name??'')||boardIds.some(id=>job.payload?.message?.includes('[cryoclaw-dashboard-target]\nboardId='+id+'\n'))){jobs.add(job.id);await request('cron.remove',{id:job.id});report.jobs.push(job.id);}
 for(const archived of [false,true]){const rows=(await request('sessions.list',{includeGlobal:true,includeUnknown:true,...archived?{archived:true}:{}})).sessions??[];for(const row of rows){if(!isOwnedQaSession(row,jobs))continue;try{const deleted=await request('sessions.delete',{key:row.key,agentId:'main',expectedSessionId:row.sessionId,deleteTranscript:true,...archived?{archivedOnly:true}:{}});report.sessions.push({key:row.key,deleted:deleted.deleted,archivedFiles:deleted.archived??[]});}catch(e){report.errors.push({key:row.key,error:String(e)});}}}
 for(const id of boardIds){try{await request('cryoclaw.dashboards.mutate',{action:'archive',boardId:id});await request('cryoclaw.dashboards.mutate',{action:'delete',boardId:id});report.boards.push(id);}catch(e){if(!/not found/i.test(String(e)))report.errors.push({boardId:id,error:String(e)});}}
 return report;
}
module.exports={isOwnedQaSession,cleanupOwnedQa,recordQaFixtures,collectQaFixtureIds};
