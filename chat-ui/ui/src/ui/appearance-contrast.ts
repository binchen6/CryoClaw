import type {AppearanceProfile} from "./appearance-profile.ts";

export function contrastRatio(a:string,b:string):number {
  const luminance=(hex:string)=>{
    const rgb=hex.slice(1).match(/../g)!.map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  };
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
/** Report only specified color pairs; inherited tokens are resolved by the current theme. */
export function appearanceContrastIssues(profile:AppearanceProfile):Array<{mode:string;role:string;ratio:number}> {
  const variants=profile.palettes?Object.entries({...profile.palettes,[profile.paletteMode??"light"]:profile.colors}):[[profile.paletteMode??"light",profile.colors]] as const;
  const issues:Array<{mode:string;role:string;ratio:number}>=[];
  for(const [mode,colors] of variants){
    if(!colors)continue;
    for(const [foreground,background] of [["text","background"],["muted","background"],["text","surface"],["userText","userBubble"],["assistantText","assistantBubble"]] as const){
      const a=colors[foreground],b=colors[background];if(!a || !b)continue;
      const ratio=contrastRatio(a,b);if(ratio<4.5)issues.push({mode,role:`${foreground}/${background}`,ratio});
    }
  }
  return issues;
}
