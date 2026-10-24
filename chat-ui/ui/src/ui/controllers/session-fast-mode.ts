import type {GatewayBrowserClient} from '../gateway.ts';
import type {GatewaySessionRow,SessionsListResult} from '../types.ts';
export type FastMode=boolean|'auto'|'ultrafast';
export function sessionFastMode(row?:GatewaySessionRow):FastMode{
 const value=row?.effectiveFastMode??row?.fastMode;
 return value===true||value==='auto'||value==='ultrafast'?value:false;
}
type Host={client:GatewayBrowserClient|null;connected:boolean;sessionKey:string;sessionsResult:SessionsListResult|null;lastError:string|null;requestUpdate:()=>void};
export async function setSessionFastMode(host:Host,enabled:boolean):Promise<void>{
 const {client,sessionKey:key}=host;if(!client||!host.connected)return;
 try{await client.request('sessions.patch',{key,fastMode:enabled});
  if(client!==host.client||!host.connected)return;
  if(host.sessionsResult)host.sessionsResult={...host.sessionsResult,sessions:host.sessionsResult.sessions.map(row=>row.key===key?{...row,fastMode:enabled,effectiveFastMode:enabled,effectiveFastModeSource:'session'}:row)};
 }catch(error){if(client===host.client&&key===host.sessionKey)host.lastError=String(error);}
 host.requestUpdate();
}
