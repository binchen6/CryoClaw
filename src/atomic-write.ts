import * as fs from "fs";

/**
 * atomic-write.ts — 关键配置文件的原子写工具（tmp + fsync + rename）。
 *
 * 语义对齐 provider-config / config-backup / cryoclaw-config / gateway-auth 各处
 * 既有的「.tmp + rename」模式，并补上缺失的 fsync：rename 只保证文件系统元数据
 * 顺序，不加 fsync 时断电可能落到「rename 已见、数据块未落盘」的中间态——最坏
 * 情况 openclaw.json 变成零长度文件，启动直接进入恢复流程。代价是每次写多一次
 * syncSync（配置写均为用户操作频率，可忽略）。
 *
 * 注意：Windows/Node 无目录句柄 fsync 的公开 API，目录项持久性由 NTFS 元数据
 * 日志保证，此处不做目录级 fsync（POSIX 上同样省略——平台差异不值得引入分歧实现）。
 */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    throw err;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    throw err;
  }
}

// 目录创建 + 原子写的常用组合（调用方普遍先 mkdirSync 状态目录）
export function writeFileAtomicSyncWithDir(dir: string, filePath: string, data: string): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(filePath, data);
}
