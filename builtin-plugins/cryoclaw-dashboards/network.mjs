import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

export function publicHttpsUrl(value){
  if(typeof value!=='string'||value.length>4096)throw Error('Invalid public source URL');const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||isIP(url.hostname.replace(/^\[|\]$/g,''))||!url.hostname.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname))throw Error('Sources must use public HTTPS hosts');
  for(const key of url.searchParams.keys())if(/(?:api.?key|token|secret|signature|authorization)/i.test(key))throw Error('Use public sources without credentials');return url;
}
export function isPublicAddress(address){
  if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a>=224);}
  if(isIP(address)===6){const canonical=new URL(`http://[${address}]`).hostname.slice(1,-1);return /^2[0-9a-f]{3}:/.test(canonical)&&!/^2001:(?:[01]?[0-9a-f]{1,2}:|db8:)/.test(canonical)&&!canonical.startsWith('2002:');}return false;
}
const dnsCache=new Map(),dnsPending=new Map();
export async function publicDns(hostname){
  const cached=dnsCache.get(hostname);if(cached&&cached.until>Date.now())return cached.addresses;if(dnsPending.has(hostname))return dnsPending.get(hostname);
  const task=(async()=>{try{
    const response=await fetchPublicBody(`https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`,{resolver:async()=>[{address:'223.5.5.5',family:4}],maxBytes:16384,redirects:0,expires:Date.now()+4500});
    const result=JSON.parse(response.body.toString('utf8')),rows=result.Answer?.filter(r=>r.type===1)??[];if(result.Status!==0||!rows.length||rows.length>32)throw Error('Public DNS unavailable');
    const addresses=rows.map(row=>({address:row.data,family:4}));if(addresses.some(row=>!isPublicAddress(row.address)))throw Error('Private public-DNS answer rejected');
    if(dnsCache.size>=64)dnsCache.delete(dnsCache.keys().next().value);dnsCache.set(hostname,{addresses,until:Date.now()+Math.min(300,Math.max(1,Math.min(...rows.map(r=>r.TTL||60))))*1000});return addresses;
  }finally{dnsPending.delete(hostname);}})();dnsPending.set(hostname,task);return task;
}
export async function resolvePublicHost(url,resolver=lookup,fallback=publicDns){let addresses=await resolver(url.hostname,{all:true,verbatim:true});
  // TUN Fake-IP is never used as a destination. Resolve independently over pinned TLS,
  // then apply the same public-address checks and pin the resulting connection.
  if(addresses.length&&addresses.every(row=>/^198\.(?:18|19)\./.test(row.address)))addresses=await fallback(url.hostname);
  if(!addresses.length||addresses.some(row=>!isPublicAddress(row.address)))throw Error('Private or reserved source address rejected');return addresses[0];}
function deadline(promise,ms){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Source timed out')),ms);})]).finally(()=>clearTimeout(timer));}
export async function fetchPublicBody(value,{resolver=lookup,request=https.request,maxBytes=131072,redirects=3,expires=Date.now()+15000,accept='application/json, text/plain'}={}){
  const url=publicHttpsUrl(value),remaining=()=>Math.max(1,expires-Date.now());if(Date.now()>=expires)throw Error('Source timed out');
  const address=await deadline(resolvePublicHost(url,resolver),Math.min(5000,remaining()));
  const result=await new Promise((resolve,reject)=>{
    let bytes=0,settled=false,timer;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const req=request(url,{method:'GET',autoSelectFamily:false,agent:false,servername:url.hostname,lookup:(_host,_options,callback)=>callback(null,address.address,address.family),headers:{Accept:accept,'User-Agent':'CryoClaw-Dashboards/1.0 (+https://github.com/binchen6/CryoClaw)'}},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();finish(null,{redirect:res.headers.location});return;}
      if(res.statusCode!==200){res.resume();finish(Error(`Source returned HTTP ${res.statusCode}`));return;}
      if(Number(res.headers['content-length'])>maxBytes){finish(Error('Source exceeds its size budget'));res.destroy();return;}
      const chunks=[];res.on('data',chunk=>{const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>maxBytes){finish(Error('Source exceeds its size budget'));res.destroy();}else chunks.push(buffer);});
      res.on('end',()=>finish(null,{body:Buffer.concat(chunks),mime:String(res.headers['content-type']??'application/octet-stream').split(';')[0]}));res.on('error',error=>finish(error));res.on('aborted',()=>finish(Error('Source transfer interrupted')));
    });
    if(!settled)timer=setTimeout(()=>{finish(Error('Source timed out'));req.destroy();},remaining());req.on('error',error=>finish(error));req.end();
  });
  if('redirect' in result){if(!result.redirect||redirects<=0)throw Error('Too many source redirects');return fetchPublicBody(new URL(result.redirect,url).href,{resolver,request,maxBytes,redirects:redirects-1,expires,accept});}return result;
}
export async function fetchPublicData(value,options){return (await fetchPublicBody(value,options)).body.toString('utf8');}
export function createSourceBroker({fetchBody=fetchPublicBody,now=Date.now}={}){
  const cache=new Map(),pending=new Map();let active=0,assetBytes=0;
  async function obtain(source,asset){const key=(asset?'asset:':`data:${source.format}:${source.refreshSeconds}:`)+source.url,cached=cache.get(key);if(cached&&cached.until>now())return cached.value;if(pending.has(key))return pending.get(key);if(active>=4)throw Error('Sources are busy; retry shortly');active++;
    const task=(async()=>{try{const response=await fetchBody(source.url,{maxBytes:asset?32*1024*1024:524288,expires:now()+(asset?30000:15000),accept:asset?'image/*, audio/*, video/*, font/*':'application/json, text/plain'});
      if(asset&&!/^(?:image\/(?:png|jpeg|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+|font\/[\w.+-]+)$/.test(response.mime))throw Error('Unsupported media type');
      const value=asset?response:{value:source.format==='text'?response.body.toString('utf8'):JSON.parse(response.body.toString('utf8')),source:source.url,fetchedAt:now()};
      if(cached?.size)assetBytes-=cached.size;cache.delete(key);const size=asset?response.body.length:0;assetBytes+=size;cache.set(key,{value,size,until:now()+(asset?3600000:source.refreshSeconds*1000)});
      while(cache.size>64||assetBytes>64*1024*1024){const first=cache.keys().next().value;assetBytes-=cache.get(first).size;cache.delete(first);}return value;
    }finally{active--;pending.delete(key);}})();pending.set(key,task);return task;
  }return {data:source=>obtain(source,false),asset:source=>obtain(source,true)};
}
