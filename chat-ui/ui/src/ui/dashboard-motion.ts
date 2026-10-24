type Box={left:number;top:number;width:number;height:number};
/** Convert screen geometry to a transform in the destination canvas coordinates. */
export function dashboardTransform(from:Box,to:Box,parentScale=1):string|null{
  if(![from.left,from.top,from.width,from.height,to.left,to.top,to.width,to.height,parentScale].every(Number.isFinite)||to.width<=0||to.height<=0||parentScale<=0)return null;
  return `translate(${(from.left-to.left)/parentScale}px, ${(from.top-to.top)/parentScale}px) scale(${from.width/to.width}, ${from.height/to.height})`;
}
