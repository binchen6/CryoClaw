import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {randomUUID,createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {starterCards} from './starter.mjs';
import {publicHttpsUrl} from './network.mjs';

const idPattern=/^[a-zA-Z0-9_-]{1,64}$/;
const bounded=(value,min,max)=>Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value))):min;
export function normalizeLayout(value={},previous={w:6,h:300,order:0}){
  return {w:bounded(value.w??previous.w,2,12),h:bounded(value.h??previous.h,180,1000),order:bounded(value.order??previous.order,0,10000)};
}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`Invalid ${label}`);return value.trim();}
export function createDashboardStore({stateDir,secret,now=()=>Date.now()}){
  const dir=path.join(stateDir,'cryoclaw-dashboards');let db;const tickets=new Map();
  function database(){if(!db){fs.mkdirSync(dir,{recursive:true});db=new DatabaseSync(path.join(dir,'dashboards.sqlite'));db.exec("PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS catalog(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL); INSERT OR IGNORE INTO catalog VALUES(1,'{\"version\":1,\"revision\":0,\"boards\":[]}');");}return db;}
  function read(){return JSON.parse(database().prepare('SELECT json FROM catalog WHERE id=1').get().json);}
  const summary=board=>({id:board.id,title:board.title,description:board.description,revision:board.revision,archived:!!board.archived,updatedAt:board.updatedAt,
    cards:board.cards.map(({html,state,dataSources,assets,...card})=>({...card,layout:{...card.layout}})).sort((a,b)=>a.layout.order-b.layout.order)});
  function mutate(run,assertCurrent=()=>{},operationId,hash){
    const connection=database();assertCurrent();connection.exec('BEGIN IMMEDIATE');try{
      if(operationId){const previous=connection.prepare('SELECT hash,result FROM operations WHERE id=?').get(operationId);if(previous){if(previous.hash!==hash)throw Error('Operation ID reused with different arguments');assertCurrent();connection.exec('COMMIT');return JSON.parse(previous.result);}}
      const next=read(),result=run(next);assertCurrent();
      next.revision++;const json=JSON.stringify(next);if(Buffer.byteLength(json)>4*1024*1024)throw Error('Dashboard storage is full; archive or simplify cards');
      const value=result(next);connection.prepare('UPDATE catalog SET json=? WHERE id=1').run(json);
      if(operationId){connection.prepare('INSERT INTO operations VALUES(?,?,?)').run(operationId,hash,JSON.stringify(value));connection.exec('DELETE FROM operations WHERE rowid NOT IN (SELECT rowid FROM operations ORDER BY rowid DESC LIMIT 256)');}assertCurrent();connection.exec('COMMIT');return value;
    }catch(error){connection.exec('ROLLBACK');throw error;}
  }
  const boardFor=(s,id)=>{const board=s.boards.find(b=>b.id===id);if(!board)throw Error('Dashboard not found');return board;};
  const touch=board=>{board.revision++;board.updatedAt=now();};
  function sign(payload){return createHmac('sha256',secret).update(payload).digest('base64url');}
  function frameUrl(board,card,write=false){const key=`${board.id}/${card.id}/${card.revision}/${write}`,cached=tickets.get(key);if(cached&&cached.until>now()+3600000)return cached.url;
    const until=now()+24*60*60*1000,payload=Buffer.from(JSON.stringify({b:board.id,c:card.id,e:until,w:write})).toString('base64url'),url=`/__cryoclaw__/dashboards/${board.id}/${card.id}?v=${card.revision}&ticket=${payload}.${sign(payload)}`;
    if(tickets.size>1024)tickets.clear();tickets.set(key,{until,url});return url;}
  return {
    async list({sinceRevision,includeArchived=false}={}){
      const s=read();if(sinceRevision===s.revision&&[...tickets.values()].every(t=>t.until>now()+3600000))return {revision:s.revision,unchanged:true};
      return {revision:s.revision,boards:s.boards.filter(b=>includeArchived||!b.archived).map(b=>({...summary(b),cards:summary(b).cards.map(c=>({...c,frameUrl:frameUrl(b,c)}))}))};
    },
    async execute(args,assertCurrent=()=>{},operationId){
      if(args.action==='list'){const result=await this.list({includeArchived:args.includeArchived===true});return {boards:result.boards.filter(b=>!args.boardId||b.id===args.boardId).map(({cards,...b})=>({...b,cardCount:cards.length,...args.boardId?{cards:cards.map(c=>({id:c.id,title:c.title,kind:c.kind,layout:c.layout,taskLinks:c.taskLinks??[]}))}:{}}))};}
      if(args.action==='read_card'){const b=boardFor(read(),args.boardId),c=b.cards.find(c=>c.id===args.cardId);if(!c)throw Error('Card not found');return {id:c.id,title:c.title,html:c.html,dataSources:c.dataSources??[],assets:c.assets??[],taskLinks:c.taskLinks??[]};}
      return mutate(s=>{
        if(args.action==='create'||args.action==='seed'){
          if(args.action==='seed'&&s.boards.length)return ()=>({board:summary(s.boards.find(b=>!b.archived)??s.boards[0])});
          if(s.boards.length>=32)throw Error('Dashboard limit reached');
          const board={id:randomUUID(),title:args.action==='seed'?'Hello World':text(args.title,80,'dashboard title'),description:typeof args.description==='string'?args.description.slice(0,240):'',cards:[],revision:1,updatedAt:now(),archived:false};
          if(args.action==='seed')board.cards=starterCards.map(c=>({...c,id:c.cardId,html:c.html??'',revision:1}));s.boards.push(board);
          return ()=>({board:summary(board)});
        }
        const board=boardFor(s,args.boardId);let publishedCardId;
        if(args.action==='rename'){board.title=text(args.title,80,'dashboard title');if(args.description!==undefined)board.description=text(args.description,240,'description');}
        else if(args.action==='archive'||args.action==='restore')board.archived=args.action==='archive';
        else if(args.action==='remove_card'){
          if(!board.cards.some(c=>c.id===args.cardId))throw Error('Card not found');board.cards=board.cards.filter(c=>c.id!==args.cardId);
        }else if(args.action==='link_task'||args.action==='unlink_task'){
          const card=board.cards.find(c=>c.id===args.cardId);if(board.archived||!card)throw Error('Card unavailable');if(typeof args.jobId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(args.jobId))throw Error('Invalid scheduled task ID');const links=(card.taskLinks??[]).filter(l=>l.jobId!==args.jobId);
          if(args.action==='link_task'){if(links.length>=4)throw Error('At most four scheduled tasks per card');links.push({jobId:args.jobId,title:typeof args.taskTitle==='string'?args.taskTitle.slice(0,100):args.jobId});}card.taskLinks=links;
        }else if(args.action==='publish_card'){
          if(board.archived)throw Error('Restore this dashboard before publishing');
          const id=args.cardId??randomUUID();if(!idPattern.test(id))throw Error('Invalid card ID');
          const previous=board.cards.find(c=>c.id===id),kind=args.kind??previous?.kind??'html';
          if(!['html','system'].includes(kind))throw Error('Unsupported card kind');
          const html=kind==='html'?args.html??previous?.html:'';
          if(typeof html!=='string'||kind==='html'&&!html.trim()||Buffer.byteLength(html)>131072)throw Error('Provide a self-contained HTML document under 128 KiB');
          if(!previous&&board.cards.length>=24)throw Error('Card limit reached');
          const card={id,title:text(args.title??previous?.title,100,'card title'),kind,html,revision:(previous?.revision??0)+1,
            state:previous?.state??null,taskLinks:previous?.taskLinks??[],dataSources:definitions(args.dataSources??previous?.dataSources??[],4,true),assets:definitions(args.assets??previous?.assets??[],8,false),
            accent:['paper','ice','ink','mint'].includes(args.accent)?args.accent:previous?.accent??'paper',
            layout:normalizeLayout(args.layout,previous?.layout??{w:6,h:300,order:board.cards.length})};
          if(previous)board.cards[board.cards.indexOf(previous)]=card;else board.cards.push(card);
          publishedCardId=id;
        }else if(args.action==='layout'){
          if(!Array.isArray(args.layouts)||args.layouts.length>24)throw Error('Invalid layout');
          for(const change of args.layouts){const card=board.cards.find(c=>c.id===change.cardId);if(!card)throw Error('Card was removed; refresh the dashboard');card.layout=normalizeLayout(change,card.layout);}
        }else throw Error('Unsupported dashboard action');
        touch(board);return ()=>({board:{id:board.id,title:board.title,revision:board.revision,cardCount:board.cards.length},...publishedCardId?{cardId:publishedCardId}:{}});
      },assertCurrent,operationId,createHash('sha256').update(JSON.stringify(args)).digest('hex'));
    },
    async pin(boardId,cardId){const b=boardFor(read(),boardId),c=b.cards.find(c=>c.id===cardId);if(b.archived||!c)throw Error('Card unavailable');return {frameUrl:frameUrl(b,c,true)};},
    async getState(boardId,cardId){const b=boardFor(read(),boardId),c=b.cards.find(c=>c.id===cardId);if(b.archived||!c)throw Error('Card unavailable');return c.state??null;},
    async setState(boardId,cardId,value){const json=JSON.stringify(value);if(!json||Buffer.byteLength(json)>32768)throw Error('Card state exceeds 32 KiB');return mutate(s=>{const b=boardFor(s,boardId),c=b.cards.find(c=>c.id===cardId);if(b.archived||!c)throw Error('Card unavailable');c.state=JSON.parse(json);return ()=>({saved:true});});},
    async source(boardId,cardId,id,asset=false){const b=boardFor(read(),boardId),c=b.cards.find(c=>c.id===cardId);if(b.archived||!c)throw Error('Card unavailable');const source=(asset?c.assets:c.dataSources)?.find(s=>s.id===id);if(!source)throw Error('Source not declared by this card');return {...source};},
    close(){db?.close();db=undefined;},
    async document(boardId,cardId,ticket){
      if(!idPattern.test(boardId)||!idPattern.test(cardId)||typeof ticket!=='string'||ticket.length>2048)throw Error('Invalid view ticket');
      const [payload,signature,...extra]=ticket.split('.');const expected=sign(payload??'');
      if(extra.length||!signature||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw Error('Invalid view ticket');
      const scope=JSON.parse(Buffer.from(payload,'base64url').toString());if(scope.b!==boardId||scope.c!==cardId||!Number.isFinite(scope.e)||scope.e<now()||scope.e>now()+24*60*60*1000+60000)throw Error('Expired view ticket');
      const board=boardFor(read(),boardId),card=board.cards.find(c=>c.id===cardId);if(board.archived||!card)throw Error('Card unavailable');return {kind:card.kind,html:card.html,title:card.title,writable:scope.w===true};
    },
  };
}
function definitions(value,max,data){if(!Array.isArray(value)||value.length>max)throw Error('Too many sources');const ids=new Set();return value.map(s=>{if(!s||!idPattern.test(s.id)||ids.has(s.id))throw Error('Invalid source ID');ids.add(s.id);const url=publicHttpsUrl(s.url).href;return {id:s.id,url,...data?{format:s.format==='text'?'text':'json',refreshSeconds:bounded(s.refreshSeconds??300,60,86400)}:{}};});}
