// quit-cleanup 单元测试：临时目录白名单清理——该删的删、该留的留
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runQuitCleanup } from "./quit-cleanup";

function mk(root: string, name: string, mtimeMs?: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "probe.txt"), "x");
  if (mtimeMs != null) {
    const t = new Date(mtimeMs);
    fs.utimesSync(dir, t, t);
  }
  return dir;
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

const NOW = Date.now();
const OLD = NOW - 48 * 3600 * 1000; // 48h 前
const FRESH = NOW - 60 * 1000; // 1 分钟前

describe("runQuitCleanup", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quit-cleanup-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("运行时已知模式无论新旧立即删除", () => {
    const a = mk(tmp, "cryoclaw-openclaw-export-abc", FRESH);
    const b = mk(tmp, "oneclaw-openclaw-export-xyz", FRESH);
    const c = mk(tmp, "openclaw-plugin-p1", FRESH);
    const d = mk(tmp, "openclaw-slug-s1", FRESH);
    const e = mk(tmp, "openclaw-npm-pack-n1", FRESH);
    const stats = runQuitCleanup({ tmpdir: tmp, now: NOW });
    assert.equal(stats.removedDirs, 5);
    for (const d2 of [a, b, c, d, e]) assert.ok(!exists(d2), d2);
  });

  it("cryoclaw-/oneclaw- 前缀目录按 24h 龄期删除", () => {
    const old1 = mk(tmp, "cryoclaw-pairing-store-old", OLD);
    const old2 = mk(tmp, "oneclaw-legacy-old", OLD);
    const fresh = mk(tmp, "cryoclaw-pairing-store-fresh", FRESH);
    const stats = runQuitCleanup({ tmpdir: tmp, now: NOW });
    assert.ok(!exists(old1));
    assert.ok(!exists(old2));
    assert.ok(exists(fresh), "新目录（并发 dev/测试可能在用）必须保留");
    assert.equal(stats.removedDirs, 2);
    assert.equal(stats.skipped, 1);
  });

  it("不相关目录与文件一律不动", () => {
    const keep1 = mk(tmp, "openclaw", OLD); // 内核每日日志目录
    const keep2 = mk(tmp, "openclaw_restore", OLD); // 状态导入恢复目录（前缀不命中）
    const keep3 = mk(tmp, "openclaw-197609", OLD); // gateway 锁目录（锁文件由 cleanGatewayLockFiles 管）
    const keep4 = mk(tmp, "unrelated-dir", OLD);
    const f = path.join(tmp, "cryoclaw-file-not-dir");
    fs.writeFileSync(f, "x");
    const stats = runQuitCleanup({ tmpdir: tmp, now: NOW });
    assert.equal(stats.removedDirs, 0);
    for (const d of [keep1, keep2, keep3, keep4, f]) assert.ok(exists(d), d);
  });

  it("tmpdir 不可读时静默返回，不抛错", () => {
    const stats = runQuitCleanup({ tmpdir: path.join(tmp, "no-such-dir"), now: NOW });
    assert.deepEqual(stats, { removedDirs: 0, skipped: 0, errors: 0 });
  });
});
