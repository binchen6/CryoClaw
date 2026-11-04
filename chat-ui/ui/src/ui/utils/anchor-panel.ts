import {placePopover, type PlacePopoverOptions} from "./popover-placement.ts";

/** Preserve the trigger even when neither vertical side can fit a long menu. */
export function fitVerticalPopover(options: PlacePopoverOptions) {
  const gap=options.gap??8,padding=options.padding??12;
  const above=Math.max(0,options.anchor.top-padding-gap);
  const below=Math.max(0,options.viewport.height-padding-gap-options.anchor.top-options.anchor.height);
  const maxHeight=Math.max(1,Math.max(above,below));
  return {...placePopover({...options,panel:{...options.panel,height:Math.min(options.panel.height,maxHeight)}}),maxHeight};
}

const heights=new WeakMap<HTMLElement,{original:string;applied:string}>();
export function positionAnchorPanel(panel:HTMLElement,trigger:HTMLElement,above=false){
  panel.style.boxSizing="border-box";
  const previous=heights.get(panel);
  if(previous && panel.style.maxHeight===previous.applied)panel.style.maxHeight=previous.original;
  const original=panel.style.maxHeight,anchor=trigger.getBoundingClientRect();
  const position=fitVerticalPopover({anchor,panel:{width:panel.offsetWidth,height:panel.offsetHeight},
    viewport:{width:innerWidth,height:innerHeight},avoid:[anchor],
    candidates:above?[{side:"top",align:"start"},{side:"bottom",align:"start"}]:[{side:"bottom",align:"end"},{side:"top",align:"end"}]});
  if(panel.offsetHeight>position.maxHeight){panel.style.maxHeight=`${position.maxHeight}px`;heights.set(panel,{original,applied:panel.style.maxHeight});}
  else heights.delete(panel);
  Object.assign(panel.style,{position:"fixed",inset:"auto",margin:"0",left:`${position.left}px`,top:`${position.top}px`});
  panel.dataset.side=position.side;
  return position;
}
