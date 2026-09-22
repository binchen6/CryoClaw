import * as fs from "fs";
import * as path from "path";
import * as log from "./logger";
import {
  resolveConfigBackupDir,
  resolveLastKnownGoodConfigPath,
  resolveUserConfigPath,
  resolveUserStateDir,
} from "./constants";
import { syncOpenClawStateAfterWrite } from "./openclaw-health-state";
import { writeFileAtomicSync } from "./atomic-write";
import { formatTimestamp } from "./time-format";

const BACKUP_FILE_PREFIX = "openclaw-";
const BACKUP_FILE_EXT = ".json";
const MAX_BACKUP_FILES = 10;
// 连写窗口：窗口内不再产生新备份，见 shouldSkipBackup
const BACKUP_MIN_INTERVAL_MS = 60_000;
const SETUP_BASELINE_FILE = "openclaw-setup-baseline.json";

export interface ConfigBackupItem {
  fileName: string;
  createdAt: string;
  size: number;
}

export interface ConfigRecoveryData {
  configPath: string;
  backupDir: string;
  lastKnownGoodPath: string;
  hasLastKnownGood: boolean;
  lastKnownGoodUpdatedAt: string | null;
  backups: ConfigBackupItem[];
}

export interface UserConfigHealth {
  exists: boolean;
  validJson: boolean;
  parseError?: string;
}

// 检查当前 openclaw.json 的可解析性，供启动前诊断使用。
// 「可解析」= 合法 JSON 且根节点是对象：合法 JSON 标量/数组（openclaw.json 内容为
// `"hello"` / `123` / `[]`）布局合法但同样是损坏，provider-config 的读取与写前保险丝
// 都按损坏处理（读取给 {}、保险丝拒绝整文件覆盖）。这里若不判非对象，用户会卡在
// 「保存永远报内容损坏、启动却不给恢复入口」的死角。
export function inspectUserConfigHealth(): UserConfigHealth {
  const configPath = resolveUserConfigPath();
  if (!fs.existsSync(configPath)) return { exists: false, validJson: false };

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { exists: true, validJson: false, parseError: "配置根节点不是 JSON 对象" };
    }
    return { exists: true, validJson: true };
  } catch (err: any) {
    return {
      exists: true,
      validJson: false,
      parseError: err?.message ?? "JSON parse failed",
    };
  }
}

// 在覆盖写入配置前自动备份当前文件（仅备份可解析 JSON）。
// 去重（P3-3）：setup:complete 一次最多连写 3 次、内核升级启动期 5 个迁移各写一次，
// 不做去重时 10 个槽位会被同秒的近似副本瞬间占满，把真正有回退价值的旧备份挤掉。
// opts.force：显式恢复动作（回退备份/一键回退 last-known-good）承诺「恢复前先备份当前
// 配置以便回滚」，不能被连写窗口吃掉——只跳过时间窗口，内容一致的重复备份仍跳过。
export function backupCurrentUserConfig(opts: { force?: boolean } = {}): void {
  const configPath = resolveUserConfigPath();
  const raw = readValidConfigRaw(configPath);
  if (!raw) return;
  if (shouldSkipBackup(raw, opts.force === true)) return;

  const backupDir = ensureBackupDir();
  const fileName = buildBackupFileName(backupDir);
  fs.writeFileSync(path.join(backupDir, fileName), raw, "utf-8");
  pruneOldBackups(backupDir);
}

// 跳过条件（命中即不产生新文件、不消耗槽位）：
// 1) 内容与目录中最新一份备份完全一致——幂等迁移/重复保存写入字节相同，备份无新增信息；
// 2) 距最新一份备份 < BACKUP_MIN_INTERVAL_MS——连写产生的中间态是「写了一半的配置」，
//    回退价值低于被它挤掉的旧备份。
// 判定失败（读到一半被杀软锁、mtime 非法）一律按"要备份"处理：宁可多备份一份，
// 也不能静默不备份。
function shouldSkipBackup(raw: string, force: boolean): boolean {
  const [latest] = listUserConfigBackups();
  if (!latest) return false;

  try {
    const latestRaw = fs.readFileSync(path.join(resolveConfigBackupDir(), latest.fileName), "utf-8");
    if (latestRaw === raw) return true;
  } catch {
    // 读失败（瞬时占用/条目消失）：不据此跳过
  }

  if (force) return false;
  const ageMs = Date.now() - Date.parse(latest.createdAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < BACKUP_MIN_INTERVAL_MS;
}

// 列出历史备份，按时间倒序返回，供设置页恢复 UI 展示。
// 纯查询无副作用：修剪只在写后备份（backupCurrentUserConfig）时执行，
// 避免展示列表的瞬刻删文件。readdir 与 stat 之间存在 TOCTOU 窗口（杀软
// 隔离/手动清理会让条目中途消失），stat 失败的条目直接跳过。
function listUserConfigBackups(): ConfigBackupItem[] {
  const backupDir = resolveConfigBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  const files = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isBackupFileName(entry.name))
    .map((entry) => entry.name);

  const items = files
    .map((fileName) => {
      const stat = safeStatSync(path.join(backupDir, fileName));
      if (!stat) return null;
      return {
        fileName,
        createdAt: stat.mtime.toISOString(),
        size: stat.size,
      } satisfies ConfigBackupItem;
    })
    .filter((item): item is ConfigBackupItem => item !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return items;
}

// 首次 setup 成功后保留一份基线配置，后续不覆盖，便于回退到“刚完成引导”状态。
export function recordSetupBaselineConfigSnapshot(): void {
  const configPath = resolveUserConfigPath();
  const raw = readValidConfigRaw(configPath);
  if (!raw) return;

  const stateDir = resolveUserStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const baselinePath = path.join(stateDir, SETUP_BASELINE_FILE);
  // 边界守卫：拼接结果必须仍在状态目录内
  const rel = path.relative(stateDir, baselinePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return;
  if (fs.existsSync(baselinePath)) return;

  fs.writeFileSync(baselinePath, raw, "utf-8");
}

// 恢复指定备份到 openclaw.json，恢复前先备份当前可解析配置以便回滚。
// force：回滚承诺不受连写窗口影响（见 backupCurrentUserConfig 的 opts.force）
export function restoreUserConfigBackup(fileName: string): void {
  if (!isBackupFileName(fileName)) {
    throw new Error("非法备份文件名");
  }

  const backupPath = path.join(resolveConfigBackupDir(), fileName);
  if (!fs.existsSync(backupPath)) {
    throw new Error("备份文件不存在");
  }

  const raw = readValidConfigRaw(backupPath);
  if (!raw) {
    throw new Error("备份文件不是有效配置（根节点必须是 JSON 对象）");
  }

  backupCurrentUserConfig({ force: true });
  writeConfigRaw(raw);
}

// 记录“最近一次可启动”的配置快照，供启动失败时一键回退。
// best-effort 语义：快照写失败（杀软文件锁/磁盘满等）不得让调用方
// （ensureGatewayRunning 启动成功路径，位于其 per-attempt try 之外）整体失败。
export function recordLastKnownGoodConfigSnapshot(): void {
  const configPath = resolveUserConfigPath();
  const raw = readValidConfigRaw(configPath);
  if (!raw) return;

  try {
    const stateDir = resolveUserStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    const snapshotPath = resolveLastKnownGoodConfigPath();

    if (fs.existsSync(snapshotPath)) {
      try {
        const prevRaw = fs.readFileSync(snapshotPath, "utf-8");
        if (prevRaw === raw) return;
      } catch {
        // ignore
      }
    }

    fs.writeFileSync(snapshotPath, raw, "utf-8");
  } catch (err) {
    // 快照不可用只影响“一键回退”，下次启动成功会再尝试刷新
    log.warn(`记录最近可用配置快照失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 一键恢复“最近一次可启动”快照，恢复前同样备份当前配置（force：回滚承诺不受连写窗口影响）。
export function restoreLastKnownGoodConfigSnapshot(): void {
  const snapshotPath = resolveLastKnownGoodConfigPath();
  if (!fs.existsSync(snapshotPath)) {
    throw new Error("没有可用的最近成功快照");
  }

  const raw = readValidConfigRaw(snapshotPath);
  if (!raw) {
    throw new Error("最近成功快照损坏");
  }

  backupCurrentUserConfig({ force: true });
  writeConfigRaw(raw);
}

// 汇总恢复页面需要的元信息，减少渲染进程重复拼接逻辑。
export function getConfigRecoveryData(): ConfigRecoveryData {
  const lastKnownGoodPath = resolveLastKnownGoodConfigPath();
  let lastKnownGoodUpdatedAt: string | null = null;

  if (fs.existsSync(lastKnownGoodPath)) {
    try {
      lastKnownGoodUpdatedAt = fs.statSync(lastKnownGoodPath).mtime.toISOString();
    } catch {
      lastKnownGoodUpdatedAt = null;
    }
  }

  return {
    configPath: resolveUserConfigPath(),
    backupDir: resolveConfigBackupDir(),
    lastKnownGoodPath,
    hasLastKnownGood: fs.existsSync(lastKnownGoodPath),
    lastKnownGoodUpdatedAt,
    backups: listUserConfigBackups(),
  };
}

// 读取并校验 JSON，失败时返回空，避免把损坏配置写入备份链路。
// 根节点必须是对象：合法 JSON 标量/数组同样是损坏（provider-config 的读取/写前保险丝
// 与 inspectUserConfigHealth 同口径）。否则这种文件既会被当成"可备份配置"占一个槽位，
// 也能被 restore 覆盖回 openclaw.json ——恢复完立刻落进"所有保存都被保险丝拒绝"的状态。
function readValidConfigRaw(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return raw;
  } catch {
    return null;
  }
}

// 统一写入 openclaw.json，保持恢复路径和正常保存路径行为一致。
// 原子写（tmp + fsync + rename）：恢复路径是用户的最后救命稻草，写一半崩溃（强杀/
// 断电）留下被截断的配置尤其不该；模式对齐 extension-mirror 的 ensurePluginsAllow。
function writeConfigRaw(raw: string): void {
  const stateDir = resolveUserStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = resolveUserConfigPath();
  writeFileAtomicSync(configPath, raw);
  syncOpenClawStateAfterWrite(configPath);
}

// 确保备份目录存在，避免首次保存时写文件失败。
function ensureBackupDir(): string {
  const backupDir = resolveConfigBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

// 生成秒级时间戳文件名；同秒多次保存时自动追加两位序号防冲突。
function buildBackupFileName(backupDir: string): string {
  const stamp = formatTimestamp(new Date());
  const base = `${BACKUP_FILE_PREFIX}${stamp}`;
  const primary = `${base}${BACKUP_FILE_EXT}`;
  if (!fs.existsSync(path.join(backupDir, primary))) return primary;

  for (let i = 1; i < 100; i++) {
    const suffix = String(i).padStart(2, "0");
    const candidate = `${base}-${suffix}${BACKUP_FILE_EXT}`;
    if (!fs.existsSync(path.join(backupDir, candidate))) return candidate;
  }

  return `${base}-${Date.now()}${BACKUP_FILE_EXT}`;
}

// 统一校验备份文件名，阻断路径穿越与非备份文件访问。
function isBackupFileName(fileName: string): boolean {
  return /^openclaw-\d{8}-\d{6}(?:-\d{2}|\-\d{13})?\.json$/.test(fileName);
}

// 限制备份数量，避免长期运行下无上限增长占满用户磁盘。
// readdir 与 stat 之间存在 TOCTOU 窗口（杀软隔离/手动清理会让条目中途消失），
// stat 失败的条目跳过本次修剪，不得让一次配置保存莫名失败。
function pruneOldBackups(backupDir: string): void {
  const files = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isBackupFileName(entry.name))
    .map((entry) => entry.name);

  if (files.length <= MAX_BACKUP_FILES) return;

  const entries: { fileName: string; mtimeMs: number }[] = [];
  for (const fileName of files) {
    const stat = safeStatSync(path.join(backupDir, fileName));
    if (!stat) continue;
    entries.push({ fileName, mtimeMs: stat.mtimeMs });
  }
  const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const toDelete = sorted.slice(MAX_BACKUP_FILES);
  for (const item of toDelete) {
    try {
      fs.unlinkSync(path.join(backupDir, item.fileName));
    } catch {
      // ignore
    }
  }
}

// readdir→statSync 的 TOCTOU 防护：文件中途消失（杀软隔离/手动清理）时
// statSync 抛 ENOENT 等错误，返回 null 由调用方跳过该条目。
function safeStatSync(abs: string): fs.Stats | null {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}
