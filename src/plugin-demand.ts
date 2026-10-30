import {readUserConfigForWrite,writeUserConfig} from "./provider-config";
import {resolveGatewayPackageDir,resolveUserStateDir,resolveNodeBin,resolveNodeExtraEnv} from './constants';
import {readChannelPluginInventory} from './channel-plugin-inventory';
import {reconcilePluginDemand} from "./plugin-demand-policy";
import * as log from "./logger";

export async function ensureOptionalPluginDemand(): Promise<void> {
  const {config,baseSnapshot}=readUserConfigForWrite();
  const {installed,channels}=await currentChannelPluginInventory(config);
  const changed=reconcilePluginDemand(config,installed,channels);
  if(!changed.length)return;
  writeUserConfig(config,{baseSnapshot});
  log.info(`[plugins] Runtime demand reconciled: ${changed.join(', ')}`);
}

export function currentChannelPluginInventory(config:any,allowErrors=false){
  return readChannelPluginInventory(resolveNodeBin(),resolveGatewayPackageDir(),resolveUserStateDir(),config,resolveNodeExtraEnv(),allowErrors);
}
