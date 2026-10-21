import * as fs from "node:fs";
import * as path from "node:path";
import {randomUUID} from "node:crypto";

export const LOCAL_SKILL_MARKER=".cryoclaw-local.json";
export function isLocalSkill(root:string,slug:string):boolean {
  if(fs.existsSync(path.join(root,slug,LOCAL_SKILL_MARKER)))return true;
  for(const base of [root,path.dirname(root)]){
    try{if(JSON.parse(fs.readFileSync(path.join(base,".clawhub","lock.json"),"utf8"))?.skills?.[slug])return false;}catch{}
  }
  return true;
}
/** Import a self-contained skill atomically; never follow links or replace an installed skill. */
export function importLocalSkill(source:string,destinationRoot:string):string {
  const root=fs.realpathSync(source),slug=path.basename(root);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(slug))throw Error("技能目录名须为字母、数字、点、横线或下划线 / Invalid skill directory name");
  const skill=path.join(root,"SKILL.md");
  if(fs.lstatSync(skill).isSymbolicLink() || !fs.statSync(skill).isFile())throw Error("请选择包含 SKILL.md 的技能目录 / Select a directory containing SKILL.md");
  fs.mkdirSync(destinationRoot,{recursive:true});
  const nested=path.relative(root,fs.realpathSync(destinationRoot));
  if(!nested || (!nested.startsWith("..") && !path.isAbsolute(nested)))throw Error("不能从技能安装目录的父目录导入 / Source cannot contain the skills installation directory");
  const target=path.join(destinationRoot,slug);
  if(fs.existsSync(target))throw Error("同名技能已存在，请先移除或重命名 / A skill with this directory name already exists");
  const staging=path.join(destinationRoot,`.import-${randomUUID()}`);
  let bytes=0,files=0;
  const copy=(from:string,to:string)=>{
    const stat=fs.lstatSync(from);
    if(stat.isSymbolicLink())throw Error("技能包含符号链接，请改用独立文件 / Symbolic links are not supported in skill imports");
    if(stat.isDirectory()){
      if(++files>2000)throw Error("技能文件过多 / Too many skill files");
      fs.mkdirSync(to);
      for(const name of fs.readdirSync(from))if(![".git","node_modules",LOCAL_SKILL_MARKER].includes(name))copy(path.join(from,name),path.join(to,name));
    }else{
      if(!stat.isFile() || ++files>2000 || (bytes+=stat.size)>32*1024*1024)throw Error("技能须小于 32 MiB / Skill import exceeds 32 MiB");
      fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
    }
  };
  try{
    copy(root,staging);
    fs.writeFileSync(path.join(staging,LOCAL_SKILL_MARKER),JSON.stringify({importedAt:new Date().toISOString()}));
    fs.renameSync(staging,target);
    return slug;
  }finally{if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});}
}

export function validateLocalPlugin(source:string):string {
  const root=fs.realpathSync(source);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,"openclaw.plugin.json"),"utf8"));
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  const entries=Array.isArray(pkg.openclaw?.runtimeExtensions) && pkg.openclaw.runtimeExtensions.length?pkg.openclaw.runtimeExtensions:pkg.openclaw?.extensions;
  if(typeof manifest.id!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(manifest.id) || !Array.isArray(entries) || !entries.length)throw Error("目录缺少有效的插件清单或入口 / Invalid plugin manifest or entry");
  for(const entry of entries){
    if(typeof entry!=="string")throw Error("Invalid plugin entry");
    const resolved=fs.realpathSync(path.resolve(root,entry));
    const relative=path.relative(root,resolved);
    if(relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(resolved).isFile())throw Error("插件入口须在目录内 / Plugin entry must stay inside its directory");
  }
  return root;
}
