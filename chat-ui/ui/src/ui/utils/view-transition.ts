let active: {skipTransition():void} | undefined;
/** Snapshot only the named content area; rapid navigation keeps the latest action. */
export function transitionView(change: () => void): void {
  const doc = document as Document & {startViewTransition?: (update:()=>Promise<void>)=>{skipTransition():void;finished:Promise<void>;ready?:Promise<void>;updateCallbackDone?:Promise<void>}};
  if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {change();return;}
  active?.skipTransition();
  let applied=false;
  const apply=()=>{if(!applied){applied=true;change();}};
  let transition;
  try { transition=doc.startViewTransition(async()=>{apply();await Promise.resolve();}); }
  catch { apply();return; }
  active=transition;
  void transition.ready?.catch(()=>{});
  void transition.updateCallbackDone?.catch(()=>{});
  void transition.finished.catch(()=>{}).finally(()=>{if(active===transition)active=undefined;});
}
