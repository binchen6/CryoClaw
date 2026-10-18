export function clampRange(value:number,min:number,max:number):number {
  return Number.isFinite(value)?Math.max(min,Math.min(max,Number(value.toFixed(6)))):min;
}
export function adjustRange(value:number,direction:number,min:number,max:number,step:number,shift=false,alt=false):number {
  return clampRange(value+direction*step*(shift ? .1 : alt ? 10 : 1),min,max);
}
