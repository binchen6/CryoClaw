import type {GatewayBrowserClient} from '../gateway.ts';
import {ResourceCache} from '../utils/resource-cache.ts';
import {mapSessionsUsage,mapUsageCost,mapUsageStatus,resolveUsageRange,type UsageRangeId,type UsageCostPayload,type UsageSessionsPayload,type UsageProviderStatus} from '../views/settings/tab-usage.lib.ts';
export type UsageSnapshot={cost:UsageCostPayload;sessions:UsageSessionsPayload;providerStatus:UsageProviderStatus[]};
type Gateway={client:GatewayBrowserClient|null;connected:boolean};
const caches=new WeakMap<GatewayBrowserClient,ResourceCache<UsageSnapshot>>();
function cacheFor(client:GatewayBrowserClient){let cache=caches.get(client);if(!cache){cache=new ResourceCache<UsageSnapshot>(30000,8);caches.set(client,cache);}return cache;}
function key(range:UsageRangeId){const dates=resolveUsageRange(range);return {dates,key:`${range}:${dates.startDate}:${dates.endDate}`};}
export function peekUsageSnapshot(gateway:Gateway,range:UsageRangeId):UsageSnapshot|undefined{return gateway.client?cacheFor(gateway.client).peek(key(range).key):undefined;}
export function loadUsageSnapshot(gateway:Gateway,range:UsageRangeId,force=false):Promise<UsageSnapshot>{
  const client=gateway.client;if(!client || !gateway.connected)return Promise.reject(Error('Gateway not connected'));
  const {dates,key:cacheKey}=key(range);
  return cacheFor(client).read(cacheKey,async()=>{
    const [cost,sessions,status]=await Promise.all([
      client.request('usage.cost',dates).catch(()=>null),
      client.request('sessions.usage',{...dates,limit:1000,groupBy:'instance'}),
      client.request('usage.status',{}).catch(()=>null),
    ]);
    return {cost:mapUsageCost(cost),sessions:mapSessionsUsage(sessions),providerStatus:mapUsageStatus(status)};
  },force);
}
