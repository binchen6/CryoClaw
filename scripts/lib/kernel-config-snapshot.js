// kernel-config-snapshot.js — 内核备份时附存 openclaw.json 配置快照
//
// 由 kernel-update.mjs 在备份旧内核时调用：把用户主配置复制到备份目录，
// 回退后若新配置与旧内核不兼容，用户可据此手动核对/恢复。回退流程刻意
// 不自动恢复配置，避免覆盖用户在回退前新写的配置。

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// 用户状态目录：与 kernel-update.mjs clearCompileCache 的解析保持一致
function resolveOpenclawStateDir(env = process.env) {
  if (env.OPENCLAW_STATE_DIR) return env.OPENCLAW_STATE_DIR;
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  return path.join(home, ".openclaw");
}

// 把 <stateDir>/openclaw.json 复制到 <backupDir>/openclaw.json。
// 源文件不存在时返回 null（跳过）；成功返回快照路径；失败抛错由调用方降级为告警。
function snapshotOpenclawConfig(backupDir, stateDir = resolveOpenclawStateDir()) {
  const src = path.join(stateDir, "openclaw.json");
  if (!fs.existsSync(src)) return null;
  const dst = path.join(backupDir, "openclaw.json");
  fs.copyFileSync(src, dst);
  return dst;
}

module.exports = { resolveOpenclawStateDir, snapshotOpenclawConfig };
