const nativeCodexProvider=/^(codex|codex-cli|openai-codex)(?:\/|$)/;
export type ChannelPluginMap=ReadonlyMap<string,readonly string[]>;
export const DEFAULT_CHANNEL_PLUGINS:ChannelPluginMap=new Map([
  ['feishu',['feishu']],['qqbot',['qqbot']],['dingtalk-connector',['dingtalk-connector']],
  ['wecom-openclaw-plugin',['wecom']],['openclaw-weixin',['openclaw-weixin']],
]);
function usesCodexRuntime(value:any):boolean {
  return value?.agentRuntime?.id==='codex' || Array.isArray(value?.pickerRuntimes)&&value.pickerRuntimes.includes('codex');
}
function hasCodexModel(value: any): boolean {
  if(typeof value==='string')return nativeCodexProvider.test(value.trim());
  if(Array.isArray(value))return value.some(hasCodexModel);
  return !!value && typeof value==='object' && Object.values(value).some(hasCodexModel);
}
export function hasConfiguredCodexModel(config: any): boolean {
  for(const [provider,value] of Object.entries(config?.models?.providers??{}) as Array<[string,any]>) {
    if(Array.isArray(value?.models) && value.models.some((model:any)=>nativeCodexProvider.test(provider)||usesCodexRuntime(model)))return true;
  }
  const scopes=[config?.agents?.defaults,...(Array.isArray(config?.agents?.list)?config.agents.list:[])];
  return hasCodexModel(config?.tools?.exec?.reviewer?.model) || scopes.some(scope=>scope && (
    Object.entries(scope.models??{}).some(([key,value])=>nativeCodexProvider.test(key)||usesCodexRuntime(value))
    || usesCodexRuntime(scope) || hasCodexModel(scope.model) || hasCodexModel(scope.subagents?.model) || hasCodexModel(scope.heartbeat?.model)));
}
function channelEnabled(channel: any): boolean {
  if(!channel || channel.enabled===false)return false;
  return channel.enabled===true || Object.values(channel.accounts??{}).some((account:any)=>account?.enabled===true);
}
export function optionalPluginEnableBlock(config:any,id:string,channelPlugins:ChannelPluginMap=DEFAULT_CHANNEL_PLUGINS): string|null {
  if(id==='codex'&&!hasConfiguredCodexModel(config))return '请先配置 Codex 代理模型；ChatGPT 订阅账户请使用模型管理页的“启用并登录”。';
  const channels=channelPlugins.get(id);
  if(channels?.length&&!channels.some(channel=>channelEnabled(config?.channels?.[channel])))return `请先在设置中启用${id==='wecom-openclaw-plugin'?'企业微信':id==='openclaw-weixin'?'微信':channels.join(' / ')}渠道。`;
  return null;
}
export function disableOptionalPluginChannel(config:any,id:string,channelPlugins:ChannelPluginMap=DEFAULT_CHANNEL_PLUGINS):void {
  for(const channel of channelPlugins.get(id)??[])if(config.channels?.[channel])config.channels[channel].enabled=false;
}
/** Channel switches own their runtime flags; Codex keeps an explicit opt-out. */
export function reconcilePluginDemand(config: any, installed: ReadonlySet<string>=new Set(),channelPlugins:ChannelPluginMap=DEFAULT_CHANNEL_PLUGINS): string[] {
  const disabled:string[]=[];
  const demands: Array<[string,boolean]>=[['codex',hasConfiguredCodexModel(config)],
    ...Array.from(channelPlugins,([id,channels]):[string,boolean]=>[id,channels.some(channel=>channelEnabled(config?.channels?.[channel]))])];
  for(const [id,demand] of demands){
    const entry=config?.plugins?.entries?.[id];
    if(id==='codex'&&demand || !entry && !installed.has(id))continue;
    const allow=config?.plugins?.allow;
    const needsAllow=demand&&Array.isArray(allow)&&allow.length>0&&!allow.includes(id);
    if(entry?.enabled===demand&&!needsAllow)continue;
    const plugins=config.plugins??={};const entries=plugins.entries??={};
    entries[id]={...entry,enabled:demand};
    if(needsAllow)allow.push(id);
    disabled.push(id);
  }
  return disabled;
}
