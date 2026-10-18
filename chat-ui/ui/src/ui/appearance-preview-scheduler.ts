const scheduled=new WeakMap<object,{frame:number;callback:()=>void}>();
export function scheduleAppearancePreview(owner:object,callback:()=>void):void {
  const current=scheduled.get(owner);if(current){current.callback=callback;return;}
  const entry={frame:0,callback};entry.frame=requestAnimationFrame(()=>{scheduled.delete(owner);entry.callback();});scheduled.set(owner,entry);
}
export function cancelAppearancePreview(owner:object):void {const entry=scheduled.get(owner);if(entry)cancelAnimationFrame(entry.frame);scheduled.delete(owner);}
