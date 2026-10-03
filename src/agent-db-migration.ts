/**
 * Agent DB schema 自动迁移（内核 2026.9.4+ 适配）。
 *
 * 背景：openclaw 2026.9.7 起要求 agent 数据库 userVersion ≥ 24（2026.9.3 为 19），
 * 不满足时网关在启动准入阶段 exit 78 拒绝服务（"uses schema version 19; … run
 * openclaw doctor --fix to migrate session identities"）。迁移唯一入口是
 * `openclaw doctor --fix --non-interactive`（safe migrations only）。
 *
 * 死锁：网关每次启动都会先在 state 库 agent_database_leases 写一条租约再撞 schema
 * 门退出，exit 78 不清理租约 → 租约持续累积。doctor 的租约准入
 * （isAgentDatabaseLeaseStale）在「pid 被其他进程复用」且「进程启动时间读不到」时
 * 保守判活跃——被系统进程（svchost 等，kill(0) 报 EPERM）复用的陈旧租约永久阻塞
 * doctor（本机实测：3 周前的租约 pid 已被 svchost 复用，doctor 拒绝迁移）。
 *
 * 因此本模块在网关启动前自动完成：检测 → 清陈旧租约 → doctor --fix → 复检。
 * 陈旧租约判定（保守，宁留勿删）：
 *   - kill(pid,0) 报 ESRCH → 原持有进程已死 → 陈旧；
 *   - kill(pid,0) 报 EPERM → 现持有者特权高于当前用户；CryoClaw 网关/CLI 以普通
 *     用户完整性运行，提权进程不可能是原持有者 → 陈旧；
 *   - kill(pid,0) 成功（pid 存活且可信号）→ 可能是真持有者 → 保留（内核启动时间
 *     口径在 Electron 侧无法一致复现，不做时间比对）。
 * 会话级单次：本模块在网关 doStart 预启动段调用（App 单实例锁保证无并发实例），
 * 失败只记日志不阻断启动——网关随后照常尝试，若仍因 schema 被拒则走既有失败弹窗。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolveGatewayEntry, resolveNodeBin, resolveNodeExtraEnv, resolveUserStateDir } from "./constants";
import * as log from "./logger";

// openclaw 2026.9.4+ 的 agent DB schema 门（2026.9.3 为 19；17 以下另有 media 迁移，
// 一并由 doctor --fix 处理）
const REQUIRED_AGENT_DB_USER_VERSION = 24;
const DOCTOR_TIMEOUT_MS = 10 * 60_000; // 200MB 级 DB 的会话身份迁移可能较慢

// 会话级单次闸门：无论成败，一个 App 会话只尝试一轮（迁移是幂等的，重试交给
// 下次启动；避免启动路径上反复 spawn doctor）
let attempted = false;

/** 读 sqlite 文件头 user_version（偏移 60，大端 uint32）——无需打开数据库。 */
export function readSqliteUserVersion(filePath: string): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 60);
    if (read < 4) return null;
    return buf.readUInt32BE(0);
  } catch {
    return null;
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** 扫描需要迁移的 agent 数据库（0 < userVersion < 24；0 = 新库，内核自行初始化）。 */
export function findAgentDatabasesNeedingMigration(stateDir: string): string[] {
  const agentsDir = path.join(stateDir, "agents");
  const needed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const dbPath = path.join(agentsDir, entry, "agent", "openclaw-agent.sqlite");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dbPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const version = readSqliteUserVersion(dbPath);
    if (version !== null && version > 0 && version < REQUIRED_AGENT_DB_USER_VERSION) {
      needed.push(dbPath);
    }
  }
  return needed;
}

/**
 * 单条租约是否陈旧（可安全删除）。判定规则见模块头注；
 * 返回 false = 无法证明陈旧（保守保留）。
 */
export function isAgentDbLeaseStale(ownerPid: number): boolean {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return true;
  try {
    process.kill(ownerPid, 0);
    return false; // 存活且可信号：可能是真持有者，保留
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH：进程已死；EPERM：现持有者特权高于本进程（ CryoClaw 网关不提权运行，
    // 提权进程不可能是原持有者）。两者都证明原租约已失效。
    return code === "ESRCH" || code === "EPERM";
  }
}

/**
 * 清理 state 库中已失效的 agent DB 租约，返回删除条数。
 * 任何失败（库缺失/损坏/锁忙）都返回 0 并吞错——调用方随后 doctor 会给出原始拒绝。
 */
export function purgeStaleAgentDbLeases(stateDir: string): number {
  const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(stateDbPath)) return 0;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(stateDbPath);
    const tableExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_database_leases'")
      .get();
    if (!tableExists) return 0;
    const rows = db.prepare("SELECT lease_id, owner_pid FROM agent_database_leases").all() as Array<{
      lease_id: string;
      owner_pid: number;
    }>;
    const staleIds = rows.filter((row) => isAgentDbLeaseStale(row.owner_pid)).map((row) => row.lease_id);
    if (staleIds.length === 0) return 0;
    const del = db.prepare("DELETE FROM agent_database_leases WHERE lease_id = ?");
    let deleted = 0;
    db.exec("BEGIN");
    try {
      for (const id of staleIds) {
        deleted += Number(del.run(id).changes);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
    return deleted;
  } catch (err) {
    log.warn(`[agent-db-migration] 清理陈旧租约失败（继续原流程）: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function execDoctorFix(stateDir: string): Promise<{ stdout: string; stderr: string }> {
  const nodeBin = resolveNodeBin();
  const entry = resolveGatewayEntry();
  return new Promise((resolve, reject) => {
    execFile(
      nodeBin,
      ["--no-deprecation", entry, "doctor", "--fix", "--non-interactive"],
      {
        timeout: DOCTOR_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          ...resolveNodeExtraEnv(),
          OPENCLAW_STATE_DIR: stateDir,
        },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const rejection = new Error(String(stderr ?? "").trim() || err.message) as Error & {
            stdout?: string;
            stderr?: string;
          };
          rejection.stdout = String(stdout ?? "");
          rejection.stderr = String(stderr ?? "");
          reject(rejection);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

export type AgentDbMigrationResult = {
  /** 是否执行了迁移尝试 */
  attempted: boolean;
  /** 迁移前需要迁移的库数 */
  pendingBefore: number;
  /** 迁移后仍需迁移的库数（0 = 成功） */
  pendingAfter: number | null;
  /** 清理的陈旧租约条数 */
  purgedLeases: number;
  /** doctor 输出摘要（失败时含 stderr 尾部，供诊断日志） */
  detail?: string;
};

/**
 * 网关启动前的 agent DB schema 就绪检查（会话级单次）。
 * 无需迁移时零开销（一次目录扫描 + 一次 4 字节头读）；需要时先清陈旧租约再跑
 * doctor --fix --non-interactive，失败不抛错——调用方记录日志后照常启动网关，
 * 让既有的失败路径（弹窗/回退提示）兜底。
 */
export async function ensureAgentDbSchemaReady(): Promise<AgentDbMigrationResult | null> {
  if (attempted) return null;
  attempted = true;
  const stateDir = resolveUserStateDir();
  const pendingBefore = findAgentDatabasesNeedingMigration(stateDir).length;
  if (pendingBefore === 0) return null;

  log.info(`[agent-db-migration] 检测到 ${pendingBefore} 个 agent 数据库需要 schema 迁移（内核要求 userVersion ≥ ${REQUIRED_AGENT_DB_USER_VERSION}）`);
  const purgedLeases = purgeStaleAgentDbLeases(stateDir);
  if (purgedLeases > 0) {
    log.info(`[agent-db-migration] 已清理 ${purgedLeases} 条失效租约（防 doctor 租约准入误判）`);
  }

  const result: AgentDbMigrationResult = { attempted: true, pendingBefore, pendingAfter: null, purgedLeases };
  try {
    const { stdout, stderr } = await execDoctorFix(stateDir);
    const tail = (stderr || stdout).trim().slice(-400);
    log.info(`[agent-db-migration] doctor --fix 完成${tail ? `，输出尾部: ${tail}` : ""}`);
    result.detail = tail;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const tail = (e.stderr || e.message).trim().slice(-400);
    log.error(`[agent-db-migration] doctor --fix 失败: ${tail}`);
    result.detail = tail;
    result.pendingAfter = findAgentDatabasesNeedingMigration(stateDir).length;
    return result;
  }
  result.pendingAfter = findAgentDatabasesNeedingMigration(stateDir).length;
  if (result.pendingAfter > 0) {
    log.warn(`[agent-db-migration] 迁移后仍有 ${result.pendingAfter} 个库未达标（详见 gateway 日志）`);
  } else {
    log.info("[agent-db-migration] agent 数据库 schema 迁移完成");
  }
  return result;
}

// 供测试注入：重置会话级单次闸门
export function resetAgentDbMigrationForTest(): void {
  attempted = false;
}
