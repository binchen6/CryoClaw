// config-backup 的 TOCTOU 防护与纯查询语义：
// 1) readdir→statSync 之间条目消失（杀软隔离/手动清理）时 list/prune 不抛错、跳过该条目
// 2) listUserConfigBackups 是纯查询，不再内联 prune（修剪只在写后备份时执行）
import { test, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// vitest 4 无法直接 spyOn Node 内置模块的 ESM namespace：
// mock 整个 fs，仅把 statSync 包装成 vi.fn（默认透传 actual），用于模拟 TOCTOU。
// actual 引用保存在 hoisted 容器里，供拦截实现透传（不能调用被 mock 的 vi.fn 自身，会递归）
const actualFsRef = vi.hoisted(() => ({ current: null as null | typeof import("fs") }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  actualFsRef.current = actual;
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
  };
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-backup-test-"));
const backupDir = path.join(tmpDir, "config-backups");
const cfgPath = path.join(tmpDir, "openclaw.json");

vi.mock("./constants", () => ({
  resolveUserStateDir: () => tmpDir,
  resolveConfigBackupDir: () => backupDir,
  resolveUserConfigPath: () => cfgPath,
  resolveLastKnownGoodConfigPath: () => path.join(tmpDir, "openclaw.last-known-good.json"),
  resolveLogsDir: () => path.join(tmpDir, "logs"),
}));
// writeConfigRaw 的旁路同步（openclaw health baseline）与本测试无关
vi.mock("./openclaw-health-state", () => ({ syncOpenClawStateAfterWrite: () => {} }));

// 备份文件名：openclaw-<8位日期>-<6位时间>.json（须匹配 isBackupFileName）
function backupName(seq: number): string {
  return `openclaw-20250101-${String(seq).padStart(6, "0")}.json`;
}

function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory, stat"), { code: "ENOENT" });
}

function seedBackups(seqs: number[]): string[] {
  fs.rmSync(backupDir, { recursive: true, force: true }); // 兜底清理前序测试残留
  fs.mkdirSync(backupDir, { recursive: true });
  const names = seqs.map(backupName);
  const base = Date.now() - 100_000;
  names.forEach((n, i) => {
    fs.writeFileSync(path.join(backupDir, n), JSON.stringify({ seq: seqs[i] }), "utf-8");
    // mtime 递增，让倒序排序可预期
    const t = new Date(base + i * 1000);
    fs.utimesSync(path.join(backupDir, n), t, t);
  });
  return names;
}

test("listUserConfigBackups：readdir 后条目消失（stat ENOENT）时跳过该条目", async () => {
  const { getConfigRecoveryData } = await import("./config-backup");
  seedBackups([1, 2, 3]);

  vi.mocked(fs.statSync).mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p).endsWith(backupName(2))) throw enoent();
    return (actualFsRef.current!.statSync as any)(p, ...rest);
  }) as any);
  const data = getConfigRecoveryData();
  expect(data.backups.map((b) => b.fileName)).toEqual([backupName(3), backupName(1)]);
  vi.mocked(fs.statSync).mockRestore();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

test("pruneOldBackups：修剪途中条目消失（stat ENOENT）时不抛错、跳过该条目", async () => {
  const { backupCurrentUserConfig } = await import("./config-backup");
  seedBackups(Array.from({ length: 12 }, (_, i) => i)); // 超过 MAX_BACKUP_FILES=10
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1 }), "utf-8");

  // 最旧的备份在 readdir 后被杀软隔离：statSync 抛 ENOENT
  const victim = backupName(0);
  let enoentHit = false;
  vi.mocked(fs.statSync).mockImplementation(((p: any, ...rest: any[]) => {
    if (String(p).endsWith(victim)) {
      enoentHit = true;
      throw enoent();
    }
    return (actualFsRef.current!.statSync as any)(p, ...rest);
  }) as any);
  // 不得让一次配置保存莫名失败
  expect(() => backupCurrentUserConfig()).not.toThrow();
  vi.mocked(fs.statSync).mockRestore();
  expect(enoentHit).toBe(true); // 确实命中了 ENOENT 分支
  // 12 旧 + 1 新 = 13；被跳过的最旧条目不被删除 → 删 2 个 → 剩 11
  const remaining = fs.readdirSync(backupDir).filter((f) => f.endsWith(".json"));
  expect(remaining.length).toBe(11);
  expect(remaining).toContain(victim);
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(cfgPath, { force: true });
});

test("listUserConfigBackups：纯查询不再触发 prune（超过上限也不删文件）", async () => {
  const { getConfigRecoveryData } = await import("./config-backup");
  seedBackups(Array.from({ length: 12 }, (_, i) => 20 + i)); // 超过 MAX_BACKUP_FILES=10

  const data = getConfigRecoveryData();
  // 若仍内联 prune，返回与磁盘都只会剩 10 条
  expect(data.backups.length).toBe(12);
  expect(fs.readdirSync(backupDir).filter((f) => f.endsWith(".json")).length).toBe(12);
  fs.rmSync(backupDir, { recursive: true, force: true });
});

// ── 备份去重（P3-3）：setup:complete 连写 3 次 / 升级启动期 5 个迁移各写一次时，
//    10 个槽位不被同秒近似副本占满 ──

function backupFiles(): string[] {
  return fs.readdirSync(backupDir).filter((f) => f.endsWith(".json"));
}

// 把最新一份备份的 mtime 推到指定秒之前（模拟"连写窗口已过"，无需真的等 60s）
function ageLatestBackup(secondsAgo: number): void {
  const names = backupFiles()
    .map((n) => ({ n, m: fs.statSync(path.join(backupDir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(path.join(backupDir, names[0].n), t, t);
}

function resetBackupFixture(content: string): void {
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(cfgPath, content, "utf-8");
}

test("backupCurrentUserConfig 去重：内容与最新备份完全一致时不新增文件", async () => {
  const { backupCurrentUserConfig } = await import("./config-backup");
  resetBackupFixture(JSON.stringify({ version: 1 }));

  backupCurrentUserConfig();
  expect(backupFiles().length).toBe(1);

  // 同字节重复保存（幂等迁移/重复点击保存）：备份无新增信息，不消耗槽位
  backupCurrentUserConfig();
  expect(backupFiles().length).toBe(1);

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(cfgPath, { force: true });
});

test("backupCurrentUserConfig 去重：距上一份 < 60s 的连写不再新增备份（槽位不被挤掉）", async () => {
  const { backupCurrentUserConfig } = await import("./config-backup");
  resetBackupFixture(JSON.stringify({ step: 0 }));

  backupCurrentUserConfig(); // 连写窗口的第一份
  const first = backupFiles()[0];

  // 同秒内的后续连写：中间态是"写了一半的配置"，回退价值低于被它挤掉的旧备份
  for (const step of [1, 2, 3]) {
    fs.writeFileSync(cfgPath, JSON.stringify({ step }), "utf-8");
    backupCurrentUserConfig();
  }
  expect(backupFiles()).toEqual([first]);
  expect(JSON.parse(fs.readFileSync(path.join(backupDir, first), "utf-8"))).toEqual({ step: 0 });

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(cfgPath, { force: true });
});

test("backupCurrentUserConfig：连写窗口已过且内容变化时仍新增备份", async () => {
  const { backupCurrentUserConfig } = await import("./config-backup");
  resetBackupFixture(JSON.stringify({ version: 1 }));

  backupCurrentUserConfig();
  expect(backupFiles().length).toBe(1);

  ageLatestBackup(61); // 距上一份备份 >= BACKUP_MIN_INTERVAL_MS
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 2 }), "utf-8");
  backupCurrentUserConfig();

  expect(backupFiles().length).toBe(2);
  const contents = backupFiles().map((n) => fs.readFileSync(path.join(backupDir, n), "utf-8"));
  expect(contents).toContain(JSON.stringify({ version: 1 }));
  expect(contents).toContain(JSON.stringify({ version: 2 }));

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(cfgPath, { force: true });
});

test("backupCurrentUserConfig force：显式恢复前的备份不受连写窗口限制", async () => {
  const { backupCurrentUserConfig } = await import("./config-backup");
  resetBackupFixture(JSON.stringify({ version: 1 }));

  backupCurrentUserConfig();
  fs.writeFileSync(cfgPath, JSON.stringify({ version: 2 }), "utf-8");
  // 恢复路径承诺「恢复前先备份当前配置以便回滚」，不能被 60s 窗口吃掉
  backupCurrentUserConfig({ force: true });

  expect(backupFiles().length).toBe(2);

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(cfgPath, { force: true });
});

test("标量/数组根节点的配置不进入备份链路（既不备份也不恢复）", async () => {
  const { backupCurrentUserConfig, restoreUserConfigBackup } = await import("./config-backup");

  // 1) 当前配置根节点是标量 → 不产生备份（无回退价值，还会白占槽位）
  resetBackupFixture('"hello"');
  backupCurrentUserConfig();
  expect(backupFiles().length).toBe(0);
  fs.rmSync(cfgPath, { force: true });

  // 2) 备份目录里存在标量根节点的文件 → 拒绝恢复：恢复完会立刻落进
  //    「所有保存都被写前保险丝拒绝」的状态
  resetBackupFixture(JSON.stringify({ version: 1 }));
  const badName = backupName(999);
  fs.writeFileSync(path.join(backupDir, badName), "123", "utf-8");
  expect(() => restoreUserConfigBackup(badName)).toThrow(/根节点必须是 JSON 对象/);
  // 当前配置未被改写
  expect(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))).toEqual({ version: 1 });

  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(cfgPath, { force: true });
});

test("inspectUserConfigHealth：根节点是标量/数组时同样按损坏上报（否则用户卡在无恢复入口）", async () => {
  const { inspectUserConfigHealth } = await import("./config-backup");
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const raw of ['"hello"', "123", "[]"]) {
    fs.writeFileSync(cfgPath, raw, "utf-8");
    const health = inspectUserConfigHealth();
    expect(health.exists).toBe(true);
    expect(health.validJson).toBe(false);
    expect(health.parseError).toMatch(/根节点/);
  }

  fs.writeFileSync(cfgPath, JSON.stringify({ version: 1 }), "utf-8");
  expect(inspectUserConfigHealth()).toEqual({ exists: true, validJson: true });

  fs.writeFileSync(cfgPath, "{ not json", "utf-8");
  expect(inspectUserConfigHealth().validJson).toBe(false);

  fs.rmSync(cfgPath, { force: true });
});
