import { migrateOpenclawConfigForKernelUpgrade } from "./openclaw-config-migration";

type OpenclawStateImportLifecycleDeps = {
  // 排空在途 gateway 操作：取消待执行的 restart 定时器，并等待任何已触发的
  // start/restart 跑完，确保导入触碰文件系统前没有 spawn/启动仍在访问状态目录。
  quiesceGateway: () => Promise<void>;
  validateArchive: (filePath: string) => Promise<void>;
  stopGateway: () => Promise<void>;
  importArchive: (filePath: string) => Promise<void>;
  reconcileHostState: () => Promise<void>;
  syncImportedConfigState: () => void | Promise<void>;
  startGateway: () => Promise<void>;
  // 入口护栏（可选）：与内核升级互斥等外部冲突检查，抛错即拒绝导入
  assertImportAllowed?: () => void;
};

export function createOpenclawStateImportLifecycle(deps: OpenclawStateImportLifecycleDeps) {
  let importActive = false;

  return {
    isImportActive: () => importActive,
    async importOpenclawState(filePath: string): Promise<void> {
      if (importActive) {
        throw new Error("正在导入 .openclaw 数据包，请稍后再试。");
      }
      deps.assertImportAllowed?.();

      importActive = true;
      try {
        await deps.quiesceGateway();
        await deps.validateArchive(filePath);
        await deps.stopGateway();
        await deps.importArchive(filePath);
        await deps.reconcileHostState();
        await deps.syncImportedConfigState();
        // 归档可能来自旧内核机器：openclaw.json 里可能带废弃/旧落位字段，
        // 先按当前内核版本做配置适配迁移再启动，避免 strict 校验起不来
        migrateOpenclawConfigForKernelUpgrade();
        await deps.startGateway();
      } finally {
        importActive = false;
      }
    },
  };
}
