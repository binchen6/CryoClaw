import {boardFrameOrigin} from './controllers/board.ts';
export type DashboardLayout={w:number;h:number;order:number};
export type DashboardCard={id:string;title:string;kind:'html'|'system';accent:string;revision:number;layout:DashboardLayout;frameUrl:string|null;taskLinks?:Array<{jobId:string;title:string}>};
export type Dashboard={id:string;title:string;description:string;revision:number;archived:boolean;updatedAt:number;cards:DashboardCard[]};
export type DashboardSnapshot={revision:number;unchanged?:boolean;boards?:Dashboard[]};
export type SystemSample={sampledAt:number;elapsedMs:number;cpuCount:number;cpuPercent:number|null;diskFree:number|null;diskTotal:number|null;platform:string;memoryFree:number;memoryTotal:number};
export const bound=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.round(value)));
export function dashboardFrameUrl(gatewayUrl:string,relative:string|null):string|null{
  const origin=boardFrameOrigin(gatewayUrl);if(!origin||!relative||!/^\/__cryoclaw__\/dashboards\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\?/.test(relative)||relative.includes('\\'))return null;
  try{const url=new URL(relative,origin);return url.origin===origin?url.href:null;}catch{return null;}
}
export function reorderDashboardCards(cards:DashboardCard[],from:string,to:string):DashboardCard[]{
  const ordered=[...cards].sort((a,b)=>a.layout.order-b.layout.order),a=ordered.findIndex(c=>c.id===from),b=ordered.findIndex(c=>c.id===to);
  if(a<0||b<0||a===b)return cards;const [card]=ordered.splice(a,1);ordered.splice(b,0,card);
  return ordered.map((c,index)=>({...c,layout:{...c.layout,order:index}}));
}
