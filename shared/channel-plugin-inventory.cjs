'use strict';
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');

// Keep discovery, install-index validation and duplicate precedence owned by the kernel.
// This imports metadata modules only; it never imports a plugin entry point.
async function kernelExport(distDir,prefix,name){
 for(const file of fs.readdirSync(distDir).filter(file=>file.startsWith(prefix)&&file.endsWith('.mjs'))){
  const source=fs.readFileSync(path.join(distDir,file),'utf8');
  const exports=source.match(/export\s*\{([^}]+)\}/g)?.join(' ')??'';
  const alias=exports.match(new RegExp('\\b'+name+'\\s+as\\s+(\\w+)\\b'))?.[1];
  if(alias){const module=await import(pathToFileURL(path.join(distDir,file)).href);if(typeof module[alias]==='function')return module[alias];}
 }
 throw new Error(`Kernel metadata contract unavailable: ${name}`);
}
async function loadInventory({distDir,config,env=process.env,allowErrors=false}){
 const [registry,workspace]=await Promise.all([
  kernelExport(distDir,'manifest-registry-','loadPluginManifestRegistryCore'),
  kernelExport(distDir,'agent-scope-config-','tryResolveConfiguredAgentWorkspaceDir'),
 ]);
 const result=registry({config,env,workspaceDir:workspace(config,env)});
 const failure=result.diagnostics.find(item=>item.level==='error');
 if(failure&&!allowErrors)throw new Error(`Plugin metadata discovery failed: ${failure.message}`);
 return result.plugins.map(plugin=>({id:plugin.id,channels:plugin.channels}));
}
module.exports={loadInventory};
if(process.argv[1]==='cryoclaw-channel-inventory'){
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 loadInventory(input).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
