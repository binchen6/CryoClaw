const marker='[cryoclaw-dashboard-target]';
export function targetsDashboardCard(job,boardId,cardId){
 const message=job?.payload?.message;
 if(job?.payload?.kind!=='agentTurn'||typeof message!=='string')return false;
 // A user may link an unrelated native task. Only our single, complete target
 // block confers lifecycle ownership; matching titles or board IDs is not enough.
 const start=message.indexOf(marker),end=message.indexOf('[/cryoclaw-dashboard-target]');
 return start>=0&&start===message.lastIndexOf(marker)&&end>start&&end===message.lastIndexOf('[/cryoclaw-dashboard-target]')&&
   message.slice(start,end).startsWith(`${marker}\nboardId=${boardId}\ncardId=${cardId}\n`);
}
export function dashboardTaskTargets(board,cardId){
 return board.cards.filter(card=>cardId===undefined||card.id===cardId).flatMap(card=>(card.taskLinks??[]).map(link=>({boardId:board.id,cardId:card.id,jobId:link.jobId})));
}
export async function setDashboardTaskEnabled(job,enabled,request){
 if(typeof job?.configRevision!=='string'||!job.configRevision)throw Error('Scheduled task revision unavailable; refresh before managing updates');
 return request('cron.update',{id:job.id,patch:{enabled},expectedConfigRevision:job.configRevision});
}
export async function pauseDashboardTasks(targets,request,assertCurrent){
 const visited=new Set();let paused=0;
 for(const target of targets){
  assertCurrent();const key=`${target.cardId}/${target.jobId}`;if(visited.has(key))continue;visited.add(key);
  const job=await request('cron.get',{id:target.jobId});assertCurrent();
  if(job?.id!==target.jobId)throw Error('Scheduled task lookup returned an invalid identity');
  if(!targetsDashboardCard(job,target.boardId,target.cardId)||!job.enabled)continue;
  await setDashboardTaskEnabled(job,false,request);assertCurrent();paused++;
 }
 return paused;
}
export async function compensateDashboardTaskActivation(target,request,error){
 try{await pauseDashboardTasks([target],request,()=>{});}
 catch(cleanup){throw Error(`${error.message}; could not confirm the scheduled update is paused: ${cleanup.message}. Check this task in scheduled tasks before retrying.`,{cause:error});}
 throw error;
}
// This public SDK dispatch retains the authenticated RPC caller. Its raw
// response must be checked: authorization failures are not successful pauses.
export function createAuthenticatedCronRequest(load=()=>import('openclaw/plugin-sdk/gateway-method-runtime')){
 return async(method,params)=>{
  const {dispatchGatewayMethod}=await load();
  const response=await dispatchGatewayMethod(method,params);
  if(!response?.ok)throw Error(response?.error?.message??'Scheduled task access denied');
  return response.payload;
 };
}
export const authenticatedCronRequest=createAuthenticatedCronRequest();
