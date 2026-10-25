import {boardFrameOrigin} from './controllers/board.ts';
import {getLocale} from './i18n.ts';
export type DashboardLayout={w:number;h:number;order:number;free?:boolean};
export type DashboardCard={id:string;title:string;kind:'html'|'system';accent:string;revision:number;layout:DashboardLayout;frameUrl:string|null;taskLinks?:Array<{jobId:string;title:string}>};
export type Dashboard={id:string;title:string;description:string;revision:number;archived:boolean;updatedAt:number;cards:DashboardCard[]};
export type DashboardSnapshot={revision:number;unchanged?:boolean;boards?:Dashboard[]};
export type SystemSample={sampledAt:number;elapsedMs:number;cpuCount:number;cpuPercent:number|null;diskFree:number|null;diskTotal:number|null;platform:string;memoryFree:number;memoryTotal:number};
export const bound=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.round(value)));
export const dashboardSize=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.round(value*1000)/1000));

/** Pack consecutive cards without changing reading order or shrinking content height. */
export function arrangeDashboardCards(cards:DashboardCard[]):DashboardCard[]{
 const ordered=[...cards].sort((a,b)=>a.layout.order-b.layout.order),result:DashboardCard[]=[];
 const pack=(group:DashboardCard[])=>{
  const cost=new Array(group.length+1).fill(Infinity),next=new Array(group.length);cost[group.length]=0;
  for(let i=group.length-1;i>=0;i--)for(let n=1;n<=3&&i+n<=group.length;n++){
   const row=group.slice(i,i+n),sum=row.reduce((s,c)=>s+c.layout.w,0);
   const penalty=(12-sum)**2+(n===1&&sum<8?36:0)+cost[i+n];
   if(penalty<cost[i]){cost[i]=penalty;next[i]=n;}
  }
  for(let i=0;i<group.length;){const row=group.slice(i,i+next[i]),sum=row.reduce((s,c)=>s+c.layout.w,0),height=Math.max(...row.map(c=>c.layout.h));let used=0;
   row.forEach((card,index)=>{const w=index===row.length-1?12-used:dashboardSize(card.layout.w*12/sum,2,12);used+=w;result.push({...card,layout:{...card.layout,w,h:height}});});i+=row.length;
  }
 };
 let group:DashboardCard[]=[];for(const card of ordered){if(card.layout.w>=10.5){pack(group);group=[];result.push({...card,layout:{...card.layout,w:12}});}else group.push(card);}pack(group);
 return result.map((card,order)=>({...card,layout:{...card.layout,free:false,order}}));
}
export function dashboardFrameUrl(gatewayUrl:string,relative:string|null):string|null{
  const origin=boardFrameOrigin(gatewayUrl);if(!origin||!relative||!/^\/__cryoclaw__\/dashboards\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\?/.test(relative)||relative.includes('\\'))return null;
  try{const url=new URL(relative,origin);return url.origin===origin?url.href:null;}catch{return null;}
}
export function reorderDashboardCards(cards:DashboardCard[],from:string,to:string):DashboardCard[]{
  const ordered=[...cards].sort((a,b)=>a.layout.order-b.layout.order),a=ordered.findIndex(c=>c.id===from),b=ordered.findIndex(c=>c.id===to);
  if(a<0||b<0||a===b)return cards;const [card]=ordered.splice(a,1);ordered.splice(b,0,card);
  return ordered.map((c,index)=>({...c,layout:{...c.layout,order:index}}));
}

export function formatDashboardTimestamp(timestamp:number):string{
  const seconds=Math.round((Date.now()-timestamp)/1000),absolute=Math.abs(seconds),locale=getLocale()==='zh'?'zh-CN':'en';
  if(absolute<60)return locale==='zh-CN'?'刚刚':'just now';
  for(const [unit,secondsPerUnit] of [['day',86400],['hour',3600],['minute',60]] as const){
    if(absolute>=secondsPerUnit)return new Intl.RelativeTimeFormat(locale,{numeric:'always'}).format(-Math.round(seconds/secondsPerUnit),unit);
  }
  return locale==='zh-CN'?'刚刚':'just now';
}
