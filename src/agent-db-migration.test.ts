// agent-db-migration 测试：user_version 头读取、待迁移库扫描、陈旧租约判定、
// 租约清理（真实 node:sqlite 内存库）。doctor --fix 编排与 gateway-process 接线
// 属集成面，不在单测覆盖内。electron 依赖（constants/logger）按仓库惯例 mock。
import { describe, expect, test, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./constants", () => ({
  resolveNodeBin: () => "node",
  resolveGatewayEntry: () => "openclaw.mjs",
  resolveNodeExtraEnv: () => ({}),
  resolveUserStateDir: () => os.tmpdir(),
}));
vi.mock("./logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import {
  findAgentDatabasesNeedingMigration,
  isAgentDbLeaseStale,
  purgeStaleAgentDbLeases,
  readSqliteUserVersion,
} from "./agent-db-migration";

function writeFakeSqlite(dir: string, name: string, userVersion: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const buf = Buffer.alloc(100);
  // sqlite 文件头魔数（前 16 字节），页大小等字段对头读取无影响
  buf.write("SQLite format 3\x00", 0, "utf8");
  buf.writeUInt32BE(userVersion, 60);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function makeStateDir() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-db-migration-"));
  afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

describe("readSqliteUserVersion", () => {
  test("读取偏移 60 的大端 uint32", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-db-uv-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(readSqliteUserVersion(writeFakeSqlite(dir, "db19.sqlite", 19))).toBe(19);
    expect(readSqliteUserVersion(writeFakeSqlite(dir, "db24.sqlite", 24))).toBe(24);
  });

  test("文件过短/缺失时返回 null", () => {
    expect(readSqliteUserVersion(path.join(os.tmpdir(), "agent-db-nonexistent.sqlite"))).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-db-short-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const p = path.join(dir, "short.sqlite");
    fs.writeFileSync(p, Buffer.alloc(10));
    expect(readSqliteUserVersion(p)).toBeNull();
  });
});

describe("findAgentDatabasesNeedingMigration", () => {
  test("只报 0 < userVersion < 24 的库", () => {
    const stateDir = makeStateDir();
    // main：v19 → 需要迁移；helper：v24 → 不需要；fresh：v0（新库）→ 不需要；空文件：跳过
    writeFakeSqlite(path.join(stateDir, "agents", "main", "agent"), "openclaw-agent.sqlite", 19);
    writeFakeSqlite(path.join(stateDir, "agents", "helper", "agent"), "openclaw-agent.sqlite", 24);
    writeFakeSqlite(path.join(stateDir, "agents", "fresh", "agent"), "openclaw-agent.sqlite", 0);
    fs.mkdirSync(path.join(stateDir, "agents", "empty", "agent"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "agents", "empty", "agent", "openclaw-agent.sqlite"), Buffer.alloc(0));

    const needed = findAgentDatabasesNeedingMigration(stateDir);
    expect(needed).toHaveLength(1);
    expect(needed[0]).toMatch(/agents[\\/]main[\\/]agent[\\/]openclaw-agent\.sqlite$/);
  });

  test("无 agents 目录时返回空", () => {
    const stateDir = makeStateDir();
    expect(findAgentDatabasesNeedingMigration(stateDir)).toEqual([]);
  });
});

describe("isAgentDbLeaseStale", () => {
  test("非法/负/NaN pid 判陈旧", () => {
    expect(isAgentDbLeaseStale(0)).toBe(true);
    expect(isAgentDbLeaseStale(-1)).toBe(true);
    expect(isAgentDbLeaseStale(Number.NaN)).toBe(true);
  });

  test("可信号存活进程保守保留", () => {
    expect(isAgentDbLeaseStale(process.pid)).toBe(false);
  });

  test("EPERM/ESRCH 路径不抛出且返回布尔（环境相关，语义见模块头注）", () => {
    // pid 4 = Windows System 进程：kill(0) 通常 EPERM → 判陈旧
    const result = isAgentDbLeaseStale(4);
    expect(typeof result).toBe("boolean");
  });
});

describe("purgeStaleAgentDbLeases", () => {
  test("只删可证明失效的租约，存活可信号进程的租约保留", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const stateDir = makeStateDir();
    fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE agent_database_leases (lease_id TEXT PRIMARY KEY, agent_id TEXT, path TEXT, owner_pid INTEGER, owner_start_time INTEGER, opened_at INTEGER)");
    const ins = db.prepare("INSERT INTO agent_database_leases (lease_id, agent_id, path, owner_pid, owner_start_time, opened_at) VALUES (?, 'main', 'p', ?, 0, 0)");
    ins.run("lease-dead", 999999999); // ESRCH → 删
    ins.run("lease-self", process.pid); // 可信号存活 → 留
    ins.run("lease-bad", 0); // 非法 pid → 删
    db.close();

    const deleted = purgeStaleAgentDbLeases(stateDir);
    expect(deleted).toBe(2);

    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const left = db2.prepare("SELECT lease_id FROM agent_database_leases").all() as Array<{ lease_id: string }>;
    db2.close();
    expect(left.map((r) => r.lease_id)).toEqual(["lease-self"]);
  });

  test("state 库缺失时返回 0 不抛错", () => {
    const stateDir = makeStateDir();
    expect(purgeStaleAgentDbLeases(stateDir)).toBe(0);
  });
});
