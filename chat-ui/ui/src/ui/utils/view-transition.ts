let active: {skipTransition():void} | undefined;
/** Snapshot only the named content area; rapid navigation keeps the latest action. */
export function transitionView(change: () => void): void {
  const doc = document as Document & {startViewTransition?: (update:()=>Promise<void>)=>{skipTransition():void;finished:Promise<void>}};
  if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {change();return;}
  active?.skipTransition();
  const transition=doc.startViewTransition(async()=>{change();await Promise.resolve();});
  active=transition;
  void transition.finished.catch(()=>{}).finally(()=>{if(active===transition)active=undefined;});
}
