import type {DetectionResult} from '../../data/ipc-bridge.ts';
export type SetupFlow={currentStep:number;conflictResult:DetectionResult|null;detecting:boolean;detectError:string|null;generation:number};
export function createSetupFlow():SetupFlow{return {currentStep:-1,conflictResult:null,detecting:false,detectError:null,generation:0};}
export async function detectSetup(flow:SetupFlow,detect:()=>Promise<DetectionResult>,update:()=>void,timeoutMs=10000){
  const generation=++flow.generation;flow.detecting=true;flow.detectError=null;flow.currentStep=-1;update();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const result=await Promise.race([detect(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Installation check timed out')),timeoutMs);})]);
    if(generation!==flow.generation)return;
    flow.conflictResult=result.portInUse || result.globalInstalled?result:null;
    flow.currentStep=flow.conflictResult?0:1;
  }catch(error){if(generation===flow.generation)flow.detectError=String(error);}
  finally{clearTimeout(timer);if(generation===flow.generation){flow.detecting=false;update();}}
}
