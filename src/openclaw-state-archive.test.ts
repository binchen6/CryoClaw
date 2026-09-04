// openclaw-state-archive 导入保障测试（L2）：
//   - 导入前先把当前状态导出为应急归档（状态目录之外，滚动保留最近 2 份）
//   - 应急归档导出失败 → 中止导入，状态目录原样保留
//   - 解压中途失败 → best-effort 从应急归档自动还原，错误文案带归档位置
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// readArchive 默认走真实实现；用例在 failOnCalls 登记要注入失败的调用序号，
// 以触发“解压/还原中途失败”路径（校验阶段仍走真实 ZIP 解析）。
// 调用序：1=导入前校验，2=解压到状态目录，3=应急归档还原。
const mockCtl = { callCount: 0, failOnCalls: [] as number[] };

vi.mock("./openclaw-state-archive-zip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-archive-zip")>();
  return {
    readArchive: (...args: Parameters<typeof actual.readArchive>) => {
      mockCtl.callCount++;
      if (mockCtl.failOnCalls.includes(mockCtl.callCount)) {
        throw new Error("解压中断（测试注入）");
      }
      return actual.readArchive(...args);
    },
  };
});

// 动态 import：vi.mock 工厂在模块被 import 时才执行，此时 mockCtl 已初始化
async function loadArchive() {
  return import("./openclaw-state-archive");
}

let tmpDir: string;
let stateDir: string;
let backupDir: string;

beforeEach(() => {
  mockCtl.callCount = 0;
  mockCtl.failOnCalls = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-archive-test-"));
  stateDir = path.join(tmpDir, "state");
  backupDir = path.join(tmpDir, "import-backup");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({ v: "A" }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 用给定文件集合造一份合法导入归档
async function makeImportZip(files: Record<string, string>): Promise<string> {
  const { exportOpenclawStateToArchive } = await loadArchive();
  const srcDir = fs.mkdtempSync(path.join(tmpDir, "src-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const zipPath = path.join(tmpDir, `import-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await exportOpenclawStateToArchive(srcDir, zipPath);
  return zipPath;
}

function listBackups(): string[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((n) => n.startsWith("state-pre-import-")).sort();
}

test("成功导入前生成应急归档", async () => {
  const { importOpenclawStateFromArchive } = await loadArchive();
  const zipB = await makeImportZip({
    "openclaw.json": JSON.stringify({ v: "B" }),
    "data/note.txt": "hello",
  });
  await importOpenclawStateFromArchive(zipB, stateDir, backupDir);

  expect(JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"))).toEqual({ v: "B" });
  expect(fs.readFileSync(path.join(stateDir, "data", "note.txt"), "utf-8")).toBe("hello");
  expect(listBackups()).toHaveLength(1);
});

test("应急归档滚动保留最近 2 份", async () => {
  const { importOpenclawStateFromArchive } = await loadArchive();
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "state-pre-import-20000101-000000.zip"), "old");
  fs.writeFileSync(path.join(backupDir, "state-pre-import-20000102-000000.zip"), "old");

  const zipB = await makeImportZip({ "openclaw.json": JSON.stringify({ v: "B" }) });
  await importOpenclawStateFromArchive(zipB, stateDir, backupDir);

  const names = listBackups();
  expect(names).toHaveLength(2);
  expect(names[0]).toBe("state-pre-import-20000102-000000.zip");
  expect(names[1].startsWith("state-pre-import-2")).toBe(true);
});

test("应急归档导出失败时中止导入，状态目录原样保留", async () => {
  const { importOpenclawStateFromArchive } = await loadArchive();
  // backupDir 的父路径是普通文件 → mkdir 必失败
  const blocker = path.join(tmpDir, "blocker");
  fs.writeFileSync(blocker, "file");
  const badBackupDir = path.join(blocker, "sub");

  const zipB = await makeImportZip({ "openclaw.json": JSON.stringify({ v: "B" }) });
  await expect(importOpenclawStateFromArchive(zipB, stateDir, badBackupDir)).rejects.toThrow("已中止导入");
  // 状态未被清空
  expect(JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"))).toEqual({ v: "A" });
});

test("解压中途失败时从应急归档自动还原", async () => {
  const { importOpenclawStateFromArchive } = await loadArchive();
  mockCtl.failOnCalls = [2]; // 解压阶段注入失败
  const zipB = await makeImportZip({ "openclaw.json": JSON.stringify({ v: "B" }) });

  const err = await importOpenclawStateFromArchive(zipB, stateDir, backupDir).then(
    () => null,
    (e) => e as Error,
  );
  expect(err).not.toBeNull();
  expect(err!.message).toContain("已从应急归档自动还原");
  expect(err!.message).toContain("state-pre-import-");
  // 状态恢复为导入前的 A
  expect(JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf-8"))).toEqual({ v: "A" });
});

test("自动还原也失败时错误文案指向应急归档位置", async () => {
  const { importOpenclawStateFromArchive } = await loadArchive();
  mockCtl.failOnCalls = [2, 3]; // 解压与还原都注入失败
  const zipB = await makeImportZip({ "openclaw.json": JSON.stringify({ v: "B" }) });

  const err = await importOpenclawStateFromArchive(zipB, stateDir, backupDir).then(
    () => null,
    (e) => e as Error,
  );
  expect(err).not.toBeNull();
  expect(err!.message).toContain("自动还原也失败");
  expect(err!.message).toContain("state-pre-import-");
  expect(err!.message).toContain("手动恢复");
});
