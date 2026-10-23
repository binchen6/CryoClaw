import type {GatewayBrowserClient} from './gateway.ts';
export function dashboardTaskMessage(boardId:string,cardId:string,instructions:string){
  if(!/^[\w-]{1,64}$/.test(boardId)||! /^[\w-]{1,64}$/.test(cardId))throw Error('Invalid dashboard target');
  return `${instructions.trim()}\n\n[cryoclaw-dashboard-target]\nboardId=${boardId}\ncardId=${cardId}\nUse cryoclaw_dashboard read_card to inspect this card, then publish_card with the SAME boardId/cardId. Preserve user layout by omitting layout. Do not create another board or card. Keep state and taskLinks. Show actual source timestamps and failures.\n[/cryoclaw-dashboard-target]`;
}
export async function createDashboardTask(client:GatewayBrowserClient,{boardId,cardId,title,instructions,minutes}:{boardId:string;cardId:string;title:string;instructions:string;minutes:number}){
  if(!instructions.trim()||instructions.length>4000||!Number.isInteger(minutes)||minutes<1||minutes>10080)throw Error('Invalid scheduled update');
  // Publish the binding before enabling a new native job; partial failures leave it paused.
  const job=await client.request<{id:string}>('cron.add',{name:title.slice(0,100),enabled:false,schedule:{kind:'every',everyMs:minutes*60000},sessionTarget:'isolated',wakeMode:'now',delivery:{mode:'none'},payload:{kind:'agentTurn',message:dashboardTaskMessage(boardId,cardId,instructions)}});
  if(!job?.id)throw Error('Scheduled task ID was not returned');
  await client.request('cryoclaw.dashboards.mutate',{action:'link_task',boardId,cardId,jobId:job.id,taskTitle:title,requestId:crypto.randomUUID()});
  await client.request('cron.update',{id:job.id,patch:{enabled:true}});return job;
}
