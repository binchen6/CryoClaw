import * as fs from "node:fs";
import * as path from "node:path";
import { resolveGatewayPackageDir } from "./constants";
import { readUserConfigForWrite, writeUserConfig } from "./provider-config";
import { syncPluginAllowOnEnable } from "./plugin-allow-sync";

export function ensureBundledDeliverablesEnabled():void {
  const {config,baseSnapshot}=readUserConfigForWrite();
  if(config.plugins?.enabled===false)return;
  const plugins=config.plugins??={};const entries=plugins.entries??={};
  let changed=false;
  for(const id of ['cryoclaw-deliverables','cryoclaw-dashboards']){
    if(!fs.existsSync(path.join(resolveGatewayPackageDir(),"dist","extensions",id,"openclaw.plugin.json"))||entries[id]?.enabled===false)continue;
    if(entries[id]?.enabled===true&&(!plugins.allow?.length||plugins.allow.includes(id)))continue;
    entries[id]={...entries[id],enabled:true};syncPluginAllowOnEnable(config,id);changed=true;
  }
  if(changed)writeUserConfig(config,{baseSnapshot});
}
