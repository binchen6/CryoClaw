import {starterCards} from './starter.mjs';
import {viewportScript,responsiveStyle} from './viewport.mjs';
import {previewFixture,systemPreviewDocument} from './preview.mjs';

const definitions=[
 ['quick-notes','随手记','Quick notes','随手记录，自动保存在当前卡片。','Capture ideas with local autosave.','productivity'],
 ['todo-habits','待办与习惯','Tasks & habits','把下一步变成可勾选的行动。','Keep tasks and daily habits together.','productivity'],
 ['pomodoro','番茄钟','Focus timer','专注与休息，按自己的节奏切换。','Alternate focus and rest at your pace.','productivity'],
 ['system-check','系统状态','System status','点击后检测本机状态，不需模型调用。','Check this computer without a model call.','productivity'],
 ['disk-space','剩余空间','Disk space','查看当前磁盘的可用空间。','Inspect available disk space.','productivity'],
 ['fx-rates','汇率','Exchange rates','有来源和时间的公开汇率数据。','Public exchange rates with source and time.','data'],
 ['market-watch','行情观察','Market watch','参考行情面板，数据以来源为准。','A market overview with explicit data sources.','data'],
 ['release-gallery','版本动态','Release journal','集中查看项目版本与更新记录。','Keep project releases in view.','data'],
 ['audio-lab','声音实验室','Audio lab','播放、波形和频谱，按需启动。','Playback and spectrum, started on demand.','creative'],
 ['pattern-lab','节奏实验室','Rhythm lab','编排节奏，自己的组合独立保存。','Sequence rhythms with independent local state.','creative'],
 ['style-lab','冰蓝调色间','Color studio','挑选色板，保存灵感。','Explore palettes and keep your choices.','creative'],
];
const presets=[
 {id:'productivity',title:'个人效率',titleEn:'Daily workspace',description:'集中记录想法、管理待办和习惯、安排专注时间，按需查看本机状态。',descriptionEn:'Notes, tasks, habits, focus time and on-demand system checks.',cards:['quick-notes','todo-habits','pomodoro','system-check']},
 {id:'briefing',title:'信息简报',titleEn:'Daily briefing',description:'关注公开数据与项目动态，更新时核对来源和时间，不补造缺失数据。',descriptionEn:'Follow public data and project updates, keeping sources and timestamps visible.',cards:['fx-rates','market-watch','release-gallery']},
 {id:'creative',title:'创作实验室',titleEn:'Creative studio',description:'声音、节奏与配色的小工作台，保留每张卡片的本机状态。',descriptionEn:'A local workspace for sound, rhythm and color.',cards:['audio-lab','pattern-lab','style-lab']},
];
export function templateCard(id){const definition=definitions.find(item=>item[0]===id),card=starterCards.find(item=>item.cardId===id);if(!definition||!card)throw Error('Unknown card template');return structuredClone(card);}
export function boardTemplate(id){const preset=presets.find(item=>item.id===id);if(!preset)throw Error('Unknown dashboard template');return {...preset,cards:preset.cards.map(templateCard)};}
export function templateCatalog(){return {cards:definitions.map(([id,title,titleEn,description,descriptionEn,category])=>{const {accent,layout}=templateCard(id);return {id,title,titleEn,description,descriptionEn,category,accent,layout};}),boards:presets.map(({cards,...preset})=>({...preset,cardCount:cards.length}))};}

/** A preview has no capability ticket, network, persistent state or parent actions. */
export function templatePreview(id){
 const card=templateCard(id);
 const html=(card.kind==='system'?systemPreviewDocument():card.html).replace('card.onpointerenter=()=>card.click();','');
 const fixture=JSON.stringify(previewFixture(id)).replace(/</g,'\\u003c');
 const runtime=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'"><script>(()=>{${viewportScript()}const fixture=${fixture};let state=fixture.state;const media=matchMedia('(prefers-reduced-motion: reduce)'),listeners=new Set();const motion={get active(){return !document.hidden},get reduced(){return media.matches},subscribe(fn){listeners.add(fn);fn({active:motion.active,reduced:motion.reduced});return()=>listeners.delete(fn)},animate(el,frames,options={}){return el.animate(frames,{...options,duration:media.matches?0:options.duration??240})},frame(draw,{fps=30}={}){let id,last=0,stopped=false;const tick=t=>{if(stopped)return;if(!document.hidden&&!media.matches&&t-last>=1000/fps){last=t;draw(t)}id=requestAnimationFrame(tick)};id=requestAnimationFrame(tick);return()=>{stopped=true;cancelAnimationFrame(id)}}};addEventListener('visibilitychange',()=>{for(const fn of listeners)fn({active:motion.active,reduced:motion.reduced})});Object.defineProperty(window,'cryoclawDashboard',{value:Object.freeze({version:2,preview:true,motion,viewport,getState:async()=>structuredClone(state),setState:async value=>{state=structuredClone(value);return {saved:true,preview:true}},data:async source=>{if(!Object.hasOwn(fixture.data,source))throw Error('Unknown preview data source');return {value:structuredClone(fixture.data[source]),preview:true}},system:async()=>structuredClone(fixture.system),asset:()=>'',compose:()=>false,tasks:()=>false,expand:()=>{},collapse:()=>{},refresh:()=>{},openLink:()=>{}})});})();<\/script>`;
 const withRuntime=/<head(?:\s[^>]*)?>/i.test(html)?html.replace(/<head(?:\s[^>]*)?>/i,match=>match+runtime):runtime+html;
 return {id,title:card.title,html:withRuntime.replace('</head>',responsiveStyle+'<style data-cryoclaw-preview>html{overflow-x:hidden}</style></head>')};
}
