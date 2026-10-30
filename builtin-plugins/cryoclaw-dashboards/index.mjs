import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createDashboardStore} from './store.mjs';
import {createSourceBroker} from './network.mjs';
import {injectRuntime} from './runtime.mjs';
import {readSystemSample,systemDocument} from './system.mjs';
import {queryParameters,queryData} from './query.mjs';
import {templatePreview} from './templates.mjs';
import {authenticatedCronRequest} from './task-lifecycle.mjs';

const sourceSchema={type:'array',maxItems:4,items:{type:'object',additionalProperties:false,required:['id','url'],properties:{id:{type:'string',maxLength:64},url:{type:'string',maxLength:4096},format:{type:'string',enum:['json','text']},refreshSeconds:{type:'integer',minimum:60,maximum:86400}}}};
export const parameters={type:'object',additionalProperties:false,required:['action'],properties:{
  action:{type:'string',enum:['list','list_templates','create','create_example','create_template','add_template','read_card','publish_card','remove_card','rename','archive','restore','delete','link_task','unlink_task']},
  templateId:{type:'string',maxLength:64},
  boardId:{type:'string',maxLength:64},cardId:{type:'string',maxLength:64},title:{type:'string',maxLength:100},description:{type:'string',maxLength:240},
  kind:{type:'string',enum:['html','system']},html:{type:'string',maxLength:131072},accent:{type:'string',enum:['paper','ice','ink','mint']},includeArchived:{type:'boolean'},confirmDelete:{type:'boolean'},
  jobId:{type:'string',maxLength:128},taskTitle:{type:'string',maxLength:100},
  dataSources:sourceSchema,assets:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['id','url'],properties:{id:{type:'string',maxLength:64},url:{type:'string',maxLength:4096}}}},
  layout:{type:'object',additionalProperties:false,properties:{w:{type:'number',minimum:2,maximum:12},h:{type:'integer',minimum:180,maximum:1000},order:{type:'integer',minimum:0,maximum:10000},free:{type:'boolean'}}},
}};
const prefix='/__cryoclaw__/dashboards/';
const previewVersion='1.3.0';
const previewPolicy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms";
export default {
  id:'cryoclaw-dashboards',name:'CryoClaw Dashboards',
  register(api){
    const stateDir=process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),'.openclaw'),token=process.env.OPENCLAW_GATEWAY_TOKEN||api.config?.gateway?.auth?.token;
    const secret=createHash('sha256').update(typeof token==='string'?token:randomBytes(32)).update('cryoclaw-dashboards:v1').digest(),store=createDashboardStore({stateDir,secret}),broker=createSourceBroker({readCache:key=>store.readSourceCache(key),writeCache:(key,entry)=>store.writeSourceCache(key,entry)});
    let systemPending,systemCached;const system=()=>systemCached&&Date.now()-systemCached.sampledAt<1000?Promise.resolve(systemCached):systemPending??=(readSystemSample(stateDir).then(s=>systemCached=s).finally(()=>{systemPending=null;}));
    const data=async p=>broker.data(await store.source(p.boardId,p.cardId,p.id));
    const method=(name,scope,handler)=>api.registerGatewayMethod?.(name,async context=>{const {params,respond}=context;try{respond(true,await handler(params??{},context));}catch(error){respond(false,undefined,{code:'INVALID_REQUEST',message:error instanceof Error?error.message:'Dashboard operation failed'});}},{scope});
    method('cryoclaw.dashboards.list','operator.read',params=>store.list(params));
    method('cryoclaw.dashboards.templates','operator.read',async params=>{const result=await store.templates(params);return params.templateId?{...result,previewPath:`${prefix}preview/${result.id}?v=${previewVersion}`}:result;});
    method('cryoclaw.dashboards.mutate','operator.write',({requestId,...params},context)=>store.execute(params,()=>{context.signal?.throwIfAborted();context.sessionMutationCommitGuard?.();},typeof requestId==='string'?requestId.slice(0,128):undefined,authenticatedCronRequest));
    method('cryoclaw.dashboards.pin','operator.write',p=>store.pin(p.boardId,p.cardId));
    method('cryoclaw.dashboards.getState','operator.read',p=>store.getState(p.boardId,p.cardId));
    method('cryoclaw.dashboards.setState','operator.write',p=>store.setState(p.boardId,p.cardId,p.value));
    method('cryoclaw.dashboards.data','operator.read',data);
    method('cryoclaw.dashboards.system','operator.read',system);
    api.registerHttpRoute?.({path:prefix,match:'prefix',auth:'plugin',handler:async(req,res)=>{
      const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*'};
      const json=(status,value)=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
      try{
        const url=new URL(req.url,'http://127.0.0.1'),parts=url.pathname.slice(prefix.length).split('/');
        if(!url.pathname.startsWith(prefix)||req.url.split('?')[0]!==url.pathname)throw Error('Invalid card URL');
        // A standalone document avoids inheriting the shell's inline-script ban. Only built-in fixtures are public.
        if(parts[0]==='preview'){
          if(req.method!=='GET'){res.writeHead(405,{...headers,Allow:'GET'});res.end();return true;}
          if(parts.length!==2||[...url.searchParams.keys()].some(key=>key!=='v'))throw Error('Invalid preview URL');
          const preview=templatePreview(parts[1]);
          res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':previewPolicy});res.end(preview.html);return true;
        }
        if(parts.length!==2)throw Error('Invalid card URL');
        const [boardId,cardId]=parts,card=await store.document(boardId,cardId,url.searchParams.get('ticket')),action=url.searchParams.get('api');
        if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD, POST'});res.end();return true;}
        if(action==='setState'){
          if(req.method!=='POST'||!card.writable)throw Error('Write ticket required');let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)throw Error('Card state exceeds 32 KiB');chunks.push(chunk);}json(200,await store.setState(boardId,cardId,JSON.parse(Buffer.concat(chunks).toString('utf8'))));return true;
        }
        if(req.method==='POST')throw Error('Invalid operation');
        if(action==='getState'){json(200,await store.getState(boardId,cardId));return true;}
        if(action==='data'){json(200,await data({boardId,cardId,id:url.searchParams.get('id')}));return true;}
        if(action==='system'){json(200,await system());return true;}
        if(action==='asset'){
          const asset=await broker.asset(await store.source(boardId,cardId,url.searchParams.get('id'),true));let start=0,end=asset.body.length-1,status=200;const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
          if(req.headers.range&&!range){res.writeHead(416,headers);res.end();return true;}
          if(range){start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),end):end;if(start>end){res.writeHead(416,{...headers,'Content-Range':`bytes */${asset.body.length}`});res.end();return true;}status=206;}
          res.writeHead(status,{...headers,'Content-Type':asset.mime,'Accept-Ranges':'bytes','Content-Length':end-start+1,...status===206?{'Content-Range':`bytes ${start}-${end}/${asset.body.length}`}:{}});res.end(req.method==='HEAD'?undefined:asset.body.subarray(start,end+1));return true;
        }
        if(action)throw Error('Unknown card operation');const html=card.kind==='system'?systemDocument(await system()):card.html;
        // Opaque sandbox blocks host DOM/storage. Network is limited to this card's capability endpoints.
        const origin=`http://127.0.0.1:${api.config?.gateway?.port??18789}`,csp=`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: ${origin}; media-src blob: ${origin}; font-src data: ${origin}; connect-src ${origin}; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms allow-popups`;
        res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp});res.end(req.method==='HEAD'?undefined:injectRuntime(html));return true;
      }catch(error){json(403,{error:error instanceof Error?error.message:'Card unavailable'});return true;}
    }});
    api.registerTool({contextVersion:2,create(ctx){
      if(ctx.sandboxed)return null;
      return {name:'cryoclaw_dashboard',label:'Dashboard',description:'Create independent dashboards and self-contained HTML cards. List IDs before edits; user layout and local state are preserved. Runtime SDK supports declared public data, media, state and system metrics.',parameters,
        async execute(id,args,signal){const assertCurrent=()=>{if(signal?.aborted)throw Error('Dashboard operation canceled');ctx.assertInvocationCurrent();};assertCurrent();const requestCron=async(method,params)=>{if(!api.runtime?.gateway?.request)throw Error('Scheduled task access unavailable');return api.runtime.gateway.request(method,params);};const result=await store.execute(args,assertCurrent,id?`${ctx.sessionKey??''}:${id}`:undefined,requestCron);return {content:[{type:'text',text:JSON.stringify(result)}]};}};
    }},{optional:false});
    api.registerTool({contextVersion:2,create(ctx){return {name:'cryoclaw_query_data',label:'Query data',description:'Read public HTTPS data, local computer metrics or dashboard summaries in any task. No dashboard required. Returns source/time and bounded results; use JSON Pointer for focused fields.',parameters:queryParameters,
      async execute(_id,args,signal){const assertCurrent=()=>{if(signal?.aborted)throw Error('Data query canceled');ctx.assertInvocationCurrent();};const result=await queryData(args,{broker,system,store,assertCurrent,sandboxed:ctx.sandboxed});return {content:[{type:'text',text:JSON.stringify(result)}]};}};}},{optional:false});
  },
};
