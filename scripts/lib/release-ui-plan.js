"use strict";

// Pair boundary conditions by default; --full remains available for a theme or shell rewrite.
function buildPlan(navCount, settingsCount, full = false) {
  if (!Number.isInteger(navCount) || navCount < 4 || !Number.isInteger(settingsCount) || settingsCount < 1) {
    throw Error("Missing main navigation or settings tabs");
  }
  const corners = full
    ? [[1440,"light"],[800,"light"],[1440,"dark"],[800,"dark"]]
    : [[1440,"light"],[800,"dark"]];
  const scenes = [];
  const add = (route,index,width,theme,lang="zh",extra={}) => scenes.push({
    route,index,width,theme,lang,dsf:1,motion:false,...extra,
    name:`${route}-${index}-${width}-${theme}-${lang}${extra.suffix || ""}`,
  });
  for (let index=0;index<navCount;index++) for (const [width,theme] of corners) {
    add("main",index,width,theme,"zh",{screenshot:width===1440 && theme==="light"});
  }
  for (let index=0;index<settingsCount;index++) {
    const variants=full || index===0 ? corners : [corners[index%corners.length]];
    for (const [width,theme] of variants) add("settings",index,width,theme,"zh",{screenshot:index===0 && width===1440 && theme==="light"});
  }
  for (const dsf of [1.25,1.5]) add("main",0,1440,"light","zh",{dsf,suffix:`-dpi-${dsf}`});
  add("main",0,800,"dark","zh",{motion:true,suffix:"-reduced-motion"});
  for (let index=0;index<navCount;index++) add("main",index,1440,"light","en");
  add("settings",0,800,"dark","en");
  return scenes;
}

function hardFailures(result) {
  const errors=[];
  if(result.overlaps?.length)errors.push("component overlap");
  if(result.bare?.length)errors.push("untranslated UI key");
  if(result.text?.pageHOverflow)errors.push("page horizontal overflow");
  if(result.rendererExceptions)errors.push("renderer exception");
  return errors;
}

module.exports={buildPlan,hardFailures};
