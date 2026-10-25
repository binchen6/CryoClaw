/** Renders the production Lit views with public, fictional demo data, without a gateway. */
import {render} from '../chat-ui/ui/node_modules/lit';
import {OpenClawApp} from '../chat-ui/ui/src/ui/app';
import {renderApp} from '../chat-ui/ui/src/ui/app-render';
import {workspaceViewState as ws} from '../chat-ui/ui/src/ui/controllers/workspace';
import {applyAppearance,normalizeAppearance,withAppearanceMode} from '../chat-ui/ui/src/ui/appearance-profile';
import {BUILTIN_THEMES} from '../chat-ui/ui/src/ui/theme-library';
import {startThemeEditor,attachThemeUi} from '../chat-ui/ui/src/ui/theme-live';

const app=new OpenClawApp();
// Keep the element detached: its production lifecycle must not connect to a real gateway.
const host=document.querySelector('#production-ui')!;
let scheduled=false;
const redraw=()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;render(renderApp(app),host);});};
app.requestUpdate=redraw as any;
attachThemeUi(app);
app.applySettings=((settings:any)=>{app.settings=settings;redraw();}) as any;
const config={models:{providers:{moonshot:{baseUrl:'https://api.moonshot.cn/v1',apiKey:'__OPENCLAW_REDACTED__',api:'openai-completions',models:[{id:'kimi-k3',name:'Kimi K3',reasoning:true,input:['text','image'],contextWindow:256000,maxTokens:32000}]},anthropic:{baseUrl:'https://api.anthropic.com',apiKey:'__OPENCLAW_REDACTED__',api:'anthropic-messages',models:[{id:'claude-sonnet-4-5',name:'Claude Sonnet',reasoning:true,input:['text','image'],contextWindow:200000,maxTokens:16000}]},deepseek:{baseUrl:'https://api.deepseek.com',apiKey:'__OPENCLAW_REDACTED__',api:'openai-completions',models:[{id:'deepseek-chat',name:'DeepSeek',input:['text'],contextWindow:128000,maxTokens:8000}]}}},agents:{defaults:{model:{primary:'moonshot/kimi-k3',fallbacks:['anthropic/claude-sonnet-4-5','deepseek/deepseek-chat']},workspace:'C:/Demo/周报项目'},list:[{id:'main',name:'工作助手'}]},channels:{},tools:{exec:{mode:'ask'}}};
const client={request:async(method:string,params:any={})=>{
  if(method==='config.patch'){
    const primary=JSON.parse(params.raw)?.agents?.defaults?.model?.primary;
    if(typeof primary==='string')config.agents.defaults.model.primary=primary;
    return {ok:true};
  }
  if(method==='config.get')return{hash:'public-demo-config',config,raw:JSON.stringify(config)};
  if(method==='models.list')return{models:app.configuredModels.map(m=>({id:m.key.split('/')[1],name:m.name,provider:m.provider,contextWindow:200000,reasoning:true,input:['text','image']}))};
  if(method==='agents.list')return{agents:[{id:'main',name:'工作助手',model:'moonshot/kimi-k3'}],defaultId:'main'};
  if(method==='sessions.list')return app.sessionsResult;
  return {};
}};
Object.assign(app,{connected:true,onboarding:false,client,assistantName:'CryoClaw',assistantAvatar:null,sessionKey:'agent:main:demo',currentModel:'moonshot/kimi-k3',thinkingLevel:'high',chatThinkingLevel:'high',thinkingLevels:['off','low','medium','high'],configuredModels:[{key:'moonshot/kimi-k3',name:'Kimi K3',provider:'moonshot',isDefault:true},{key:'anthropic/claude-sonnet-4-5',name:'Claude Sonnet',provider:'anthropic',isDefault:false},{key:'deepseek/deepseek-chat',name:'DeepSeek',provider:'deepseek',isDefault:false}],sessionsResult:{sessions:[{key:'agent:main:demo',displayName:'调研与周报',label:'调研与周报',updatedAt:1792371600000},{key:'agent:main:plan',displayName:'产品方案讨论',label:'产品方案讨论',updatedAt:1792368000000}]},gitRepoOptions:[{path:'C:/Demo/周报项目',kind:'workspace',branch:'main'}],gitRepoPath:'C:/Demo/周报项目',worktrees:[],chatVisibleMessageCount:50,webbridgeChecking:false,webbridgeBrowserName:'Chrome',webbridgeExtensionState:'enabled',webbridgeNeedsRepair:false});
app.settings={...app.settings,theme:'light',cryoclawView:'chat',navCollapsed:false,sidebarWidth:230,pinnedWorkspaces:[{id:'demo',name:'周报项目',icon:'📁',path:'C:/Demo/周报项目'}],sessionWorkspaceMap:{'agent:main:demo':'demo'},sessionKey:'agent:main:demo'};
const content='# 本周工作计划\n\n## 调研与交付\n\n- [x] 整理网页资料，保留来源\n- [x] 生成 Word 周报与 Excel 数据汇总\n- [x] 制作 PowerPoint 团队汇报\n- [ ] 与团队确认下一步行动\n\n## 下一步\n\n把关键结论带回对话，继续完善方案。\n';
Object.assign(ws,{root:'C:/Demo/周报项目',currentPath:'C:/Demo/周报项目',agentRoot:'C:/Demo/周报项目',loading:false,selectedFile:'C:/Demo/周报项目/工作计划.md',selectedFileName:'工作计划.md',fileContent:content,draft:content,fileHash:'demo-hash',baseHash:'demo-hash',fileSize:500,fileLoading:false,draftStatus:'草稿已备份',recentFiles:[{name:'工作计划.md',path:'C:/Demo/周报项目/工作计划.md',isDir:false},{name:'调研笔记.md',path:'C:/Demo/周报项目/调研笔记.md',isDir:false}],items:['工作计划.md','调研笔记.md','调研周报.docx','数据汇总.xlsx','团队汇报.pptx'].map(name=>({name,path:`C:/Demo/周报项目/${name}`,isDir:false})),history:['C:/Demo/周报项目'],historyIndex:0});

(window as any).showDemoScene=async(scene:string)=>{
  app.settings={...app.settings,cryoclawView:scene.startsWith('theme')||scene==='models'?'settings':scene==='workspace'?'workspace':'chat'};
  app.settingsTabHint=scene==='models'?'provider':scene.startsWith('theme')?'appearance':null;
  app.chatMessages=[{role:'user',content:[{type:'text',text:'整理网页资料，生成 Word 周报、Excel 数据汇总和 PowerPoint 汇报。'}],timestamp:1792371600000},{role:'assistant',content:[{type:'text',text:'已通过 WebBridge 整理网页资料，关键结论与来源已汇总。\n\n### 交付文件\n\nMEDIA:C:/Demo/周报项目/调研周报.docx\nMEDIA:C:/Demo/周报项目/数据汇总.xlsx\nMEDIA:C:/Demo/周报项目/团队汇报.pptx'}],timestamp:1792371610000}];
  if(scene==='theme-dark'||scene==='theme-studio'){
    const theme=BUILTIN_THEMES.find(t=>t.id==='graphite')!;
    app.settings={...app.settings,theme:'dark',appearance:withAppearanceMode(theme.appearance,'dark',true)};
    app.theme='dark';app.themeResolved='dark';document.documentElement.dataset.theme='dark';
    applyAppearance(app.settings.appearance!);
  }else{
    app.settings={...app.settings,theme:'light',appearance:normalizeAppearance(undefined)};app.theme='light';app.themeResolved='light';document.documentElement.dataset.theme='light';applyAppearance(app.settings.appearance!);
  }
  redraw();await new Promise(resolve=>setTimeout(resolve,500));
  // Settings keeps a draft per visit. Select the built-in tile through the real handler.
  if(scene==='theme-dark'||scene==='theme-studio'){
    const tile=[...document.querySelectorAll('button')].find(el=>el.textContent?.includes('石墨'));
    tile?.click();await new Promise(resolve=>setTimeout(resolve,200));
    const dark=[...document.querySelectorAll('button')].find(el=>el.textContent?.trim()==='深色');dark?.click();
  }
  if(scene==='theme-studio'){
    app.settings={...app.settings,cryoclawView:'chat'};
    startThemeEditor(app,app.settings.appearance,'我的石墨工作台',false);
    redraw();
  }
  await new Promise(resolve=>setTimeout(resolve,350));
  // The detached fixture has no production shell observer; refresh node bindings after mount.
  applyAppearance({...app.settings.appearance!,radius:(app.settings.appearance?.radius??12)+.001});
  applyAppearance(app.settings.appearance!);
};
redraw();
