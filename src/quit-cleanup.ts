// 退出时清理临时缓存（R20）。
//
// 背景：真机 $TEMP 实测积压 150+ 个 mkdtemp 残留目录（cryoclaw-pairing-store-*、
// oneclaw-openclaw-export-*、openclaw-plugin-* / openclaw-slug-* / openclaw-npm-pack-*），
// 应用与内核都只建不删。本模块在 before-quit（gateway 已停）时做有界清理。
//
// 原则：
// - 只动 tmpdir 下明确属于本应用/内核的目录前缀，用户数据（~/.openclaw 下的配置、
//   会话、workspace 等）不在这里，天然不受影响；
// - 运行时已知模式立即删；其余 cryoclaw-/oneclaw- 前缀目录按 mtime > 24h 才删
//   （防误删正在运行的 dev/测试进程的临时目录）；
// - 一切错误吞掉计数，绝不阻断退出。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as log from "./logger";

// 运行时已知临时目录：退出即删（gateway 已在 before-quit 先行停止）
const RUNTIME_TEMP_DIR_PATTERNS = [
  /^cryoclaw-openclaw-export-/, // openclaw-state-archive.ts 导出快照
  /^oneclaw-openclaw-export-/, // 改名前遗留
  /^openclaw-plugin-/, // 内核插件临时解包
  /^openclaw-slug-/, // 内核 slug 临时目录
  /^openclaw-npm-pack-/, // 内核 npm pack 临时目录
];

// 其余本系 mkdtemp 残留（含历史测试泄漏）：仅当 mtime 超过该阈值才删
const AGED_TEMP_DIR_PATTERN = /^(?:cryoclaw|oneclaw)-/;
const AGED_TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type QuitCleanupStats = { removedDirs: number; skipped: number; errors: number };

export function runQuitCleanup(opts?: { tmpdir?: string; now?: number }): QuitCleanupStats {
  const tmpdir = opts?.tmpdir ?? os.tmpdir();
  const now = opts?.now ?? Date.now();
  const stats: QuitCleanupStats = { removedDirs: 0, skipped: 0, errors: 0 };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpdir, { withFileTypes: true });
  } catch {
    return stats; // tmpdir 不可读就算了，不影响退出
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const isRuntime = RUNTIME_TEMP_DIR_PATTERNS.some((re) => re.test(name));
    const isAged = AGED_TEMP_DIR_PATTERN.test(name);
    if (!isRuntime && !isAged) continue;

    const full = path.join(tmpdir, name);
    try {
      if (!isRuntime) {
        // 龄期判断：只删 24h 前的残留
        const st = fs.statSync(full);
        if (now - st.mtimeMs < AGED_TEMP_DIR_MAX_AGE_MS) {
          stats.skipped++;
          continue;
        }
      }
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 2 });
      stats.removedDirs++;
    } catch {
      stats.errors++;
    }
  }

  if (stats.removedDirs > 0 || stats.errors > 0) {
    log.info(
      `[quit-cleanup] 临时目录清理：删除 ${stats.removedDirs}，跳过 ${stats.skipped}，失败 ${stats.errors}`,
    );
  }
  return stats;
}
