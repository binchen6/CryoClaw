type Verification={success:boolean;message?:string;supportsImage?:boolean};
/** Persist precisely the selection that was verified, even if external code edits the form. */
export async function verifySetupSelection<T extends object>(selection:T,verify:(selection:T)=>Promise<Verification>,save:(selection:T,result:Verification)=>Promise<void>,saving:()=>void){
  const captured={...selection};const result=await verify(captured);
  if(!result.success)return result;
  saving();await save(captured,result);return result;
}
