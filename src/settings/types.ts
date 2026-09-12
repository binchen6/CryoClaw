/**
 * Settings IPC 模块共享的注册参数。
 * main.ts 只调用一次 registerSettingsIpc（见 ../settings-ipc.ts 薄入口），
 * 由它把同一份 opts 分发给 src/settings/ 下的各域注册函数。
 */
export interface SettingsIpcOptions {
  importOpenclawState: (filePath: string) => Promise<void>;
  requestGatewayRestart?: () => void;
  getGatewayToken?: () => string;
  /** 停止 gateway（恢复出厂等删配置场景必须先停，防内核 config observer 写回复活） */
  stopGateway?: () => Promise<void>;
  /** 取消挂起的崩溃自动重启定时器（R71）：恢复/导入静默 gateway 前调用，防其定时器把 gateway 拉到半恢复状态上 */
  cancelScheduledCrashRestart?: () => void;
  /**
   * 恢复备份后运行存量配置迁移（dingtalk 废弃字段 / browser profile / 内核版本门控迁移）。
   * 备份可能来自旧版本：不迁移直接重启 gateway 会被 strict 校验拒绝（同导入生命周期）。
   */
  migrateRestoredConfig?: () => void;
}
