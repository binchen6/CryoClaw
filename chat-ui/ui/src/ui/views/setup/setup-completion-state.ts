type Browser={id:string;name:string}|null;
export function createCompletionOptions(){return {launchAtLoginSupported:false,launchAtLogin:false,defaultBrowser:null as Browser,defaultBrowserLoaded:false,enableWebbridge:false,optionsLoaded:false,initializing:false,optionsFailed:false,generation:0,launchTouched:false,browserTouched:false,starting:false,completed:false};}
export type CompletionOptions=ReturnType<typeof createCompletionOptions>;
export async function loadCompletionOptions(state:CompletionOptions,launch:()=>Promise<{supported?:boolean;enabled?:boolean}>,browser:()=>Promise<Browser>,update:()=>void,timeoutMs=8000){
  const generation=++state.generation;state.initializing=true;state.optionsLoaded=false;state.optionsFailed=false;update();
  const bounded=async<T>(load:()=>Promise<T>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([Promise.resolve().then(load),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Startup option timed out')),timeoutMs);})]);}finally{clearTimeout(timer);}};
  const [login,defaultBrowser]=await Promise.allSettled([bounded(launch),bounded(browser)]);
  if(generation!==state.generation)return;
  state.launchAtLoginSupported=login.status==='fulfilled' && login.value.supported===true;
  if(!state.launchTouched)state.launchAtLogin=login.status==='fulfilled' && login.value.enabled===true;
  state.defaultBrowser=defaultBrowser.status==='fulfilled'?defaultBrowser.value:null;
  state.defaultBrowserLoaded=true;
  if(!state.defaultBrowser || !state.browserTouched)state.enableWebbridge=!!state.defaultBrowser;
  state.optionsFailed=login.status==='rejected' || defaultBrowser.status==='rejected';
  state.optionsLoaded=true;state.initializing=false;update();
}
export function completionPayload(state:CompletionOptions){
  return {installCli:true,sessionMemory:true,enableWebbridge:!!state.defaultBrowser && state.optionsLoaded && state.enableWebbridge,...(state.launchAtLoginSupported?{launchAtLogin:state.launchAtLogin}:{})};
}
export async function finishSetup(state:CompletionOptions,complete:(payload:ReturnType<typeof completionPayload>)=>Promise<{success:boolean;message?:string}>,update:()=>void){
  if(state.starting || !state.optionsLoaded)return false;
  const payload=completionPayload(state);state.starting=true;update();
  try{const result=await complete(payload);if(!result?.success)throw Error(result?.message??'Setup did not complete');state.completed=true;return true;}
  finally{state.starting=false;update();}
}
