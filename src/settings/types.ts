/**
 * Settings IPC 模块共享的注册参数。
 * main.ts 只调用一次 registerSettingsIpc（见 ../settings-ipc.ts 薄入口），
 * 由它把同一份 opts 分发给 src/settings/ 下的各域注册函数。
 */
export interface SettingsIpcOptions {
  importOpenclawState: (filePath: string) => Promise<void>;
  requestGatewayRestart?: () => void;
  getGatewayToken?: () => string;
}
