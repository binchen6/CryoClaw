// kernel-update.mjs 单元测试
//   - reconcileSwapDebris：换装残留自愈（含 journal 成对恢复）
//   - planSwapRecovery：成对恢复判定的纯函数
//   - evaluateLock / acquireLock：内核更新锁（PID 复用 + 过期兜底）
//
// kernel-update.mjs 是运行时装扮脚本，其同级依赖（kernel-dist-patch.js 等）由
// package-resources.js 在打包时拷入 updater/——开发树里不存在，直接 import 会
// 解析失败。这里仿照打包行为把脚本 + 依赖 stage 到临时目录后 import。
// main() 有 isMain 守卫，import 不会触发真正的内核升级；锁用例把 stage 后的脚本
// 作为子进程运行（acquireLock 拒绝时会 process.exit(1)，进程内调用会带走测试进程）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-update-test-stage-"));
for (const name of [
  "kernel-update.mjs",
  "kernel-dist-patch.js",
  "kernel-channel.js",
  "rm-rec.js",
  "kernel-prune.js",
  "kernel-config-snapshot.js",
]) {
  const src = fs.existsSync(path.join(HERE, "updater", name))
    ? path.join(HERE, "updater", name)
    : path.join(HERE, "lib", name);
  fs.copyFileSync(src, path.join(STAGE, name));
}

const { reconcileSwapDebris, planSwapRecovery, evaluateLock, writeSwapJournal, readSwapJournal } = await import(
  pathToFileURL(path.join(STAGE, "kernel-update.mjs")).href
);
process.once("exit", () => { try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch {} });

// 每个用例一套 resources 目录：asar / unpacked 正式物 + 残留物
function makeResources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-recon-"));
  return {
    dir,
    asar: path.join(dir, "gateway.asar"),
    unpacked: path.join(dir, "gateway.asar.unpacked"),
    logs: [] ,
  };
}

// 换装 journal：用模块导出的真实写侧落盘（写/读路径漂移会被用例直接抓住），
// 文件名约定 = <asarPath>.swap-journal.json
function writeJournal(r, { ts, step, stagedUnpacked = true, hadOldUnpacked = true, targetVersion = "2026.9.3" }) {
  assert.ok(writeSwapJournal(r.asar, { targetVersion, fromVersion: "2026.8.2", ts, step, stagedUnpacked, hadOldUnpacked }));
  assert.ok(fs.existsSync(`${r.asar}.swap-journal.json`), "journal 落在 <asarPath>.swap-journal.json");
}

test("journal 写读往返：字段与文件名一致；不合法内容读回 null（退回旧逻辑）", () => {
  const r = makeResources();
  try {
    writeJournal(r, { ts: 1700000000009, step: 3, stagedUnpacked: false, hadOldUnpacked: true, targetVersion: "2026.9.4" });
    assert.deepEqual(readSwapJournal(r.asar), {
      targetVersion: "2026.9.4",
      ts: 1700000000009,
      step: 3,
      stagedUnpacked: false,
      hadOldUnpacked: true,
    });

    // 截断/字段越界/非法 JSON → null（不去猜，退回无 journal 的旧逻辑）
    for (const bad of ['{"ts":1,"step":', '{"ts":1,"step":9}', '{"ts":0,"step":1}', "not json", "[]"]) {
      fs.writeFileSync(`${r.asar}.swap-journal.json`, bad);
      assert.equal(readSwapJournal(r.asar), null, `非法 journal 应读回 null: ${bad}`);
    }
    // 文件不存在同样是 null
    fs.rmSync(`${r.asar}.swap-journal.json`, { force: true });
    assert.equal(readSwapJournal(r.asar), null);

    // strict=true：落盘失败必须抛出（换装前落不下 journal 即中止换装）
    const ghost = path.join(r.dir, "no-such-dir", "gateway.asar");
    assert.throws(() => writeSwapJournal(ghost, { ts: 1, step: 0 }, true));
    assert.equal(writeSwapJournal(ghost, { ts: 1, step: 0 }), false, "非严格模式只返回 false");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("既有行为：.new-/.old- 残留被清理，正式物不动", () => {
  const r = makeResources();
  try {
    fs.writeFileSync(r.asar, "asar-content");
    fs.mkdirSync(r.unpacked);
    fs.writeFileSync(path.join(r.unpacked, "x.node"), "x");
    fs.writeFileSync(`${r.asar}.old-100`, "old-asar");
    fs.writeFileSync(`${r.asar}.new-200`, "new-asar");
    fs.mkdirSync(`${r.unpacked}.old-100`);
    fs.mkdirSync(`${r.unpacked}.new-200`);

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.equal(fs.readFileSync(r.asar, "utf-8"), "asar-content", "正式 asar 不动");
    assert.ok(fs.existsSync(r.unpacked), "正式 unpacked 不动");
    assert.deepEqual(
      fs.readdirSync(r.dir).sort(),
      ["gateway.asar", "gateway.asar.unpacked"],
      "全部 .new-/.old- 残留被清理",
    );
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test(".rbk- 残留被清理（回退成功路径崩溃的兜底，每份 100-200MB）", () => {
  const r = makeResources();
  try {
    fs.writeFileSync(r.asar, "asar-content");
    fs.mkdirSync(r.unpacked);
    fs.writeFileSync(`${r.asar}.rbk-100`, "rbk-asar");
    fs.mkdirSync(`${r.unpacked}.rbk-100`);
    fs.writeFileSync(path.join(`${r.unpacked}.rbk-100`, "y.node"), "y");

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.deepEqual(
      fs.readdirSync(r.dir).sort(),
      ["gateway.asar", "gateway.asar.unpacked"],
      "全部 .rbk- 残留被清理",
    );
    assert.ok(
      r.logs.some((m) => m.includes(".rbk-")),
      "清理动作应有日志",
    );
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("asar 缺失 + 无 .new-/.old- + 成对 .rbk- → 还原最新一份为正式名", () => {
  const r = makeResources();
  try {
    // 回退换装后、删除 .rbk 前崩溃：正式名缺失，两侧各留一份 .rbk（取最新时间戳）
    fs.writeFileSync(`${r.asar}.rbk-100`, "old-asar-v1");
    fs.writeFileSync(`${r.asar}.rbk-200`, "old-asar-v2");
    fs.mkdirSync(`${r.unpacked}.rbk-100`);
    fs.mkdirSync(`${r.unpacked}.rbk-200`);
    fs.writeFileSync(path.join(`${r.unpacked}.rbk-200`, "z.node"), "z");

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.equal(fs.readFileSync(r.asar, "utf-8"), "old-asar-v2", "最新 .rbk- 进位为 gateway.asar");
    assert.ok(fs.existsSync(path.join(r.unpacked, "z.node")), "最新 .rbk- unpacked 一并恢复");
    assert.deepEqual(fs.readdirSync(r.dir).sort(), ["gateway.asar", "gateway.asar.unpacked"], "无残留");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("asar 缺失 + 只有 asar .rbk-（安装本无 unpacked）→ 单边还原 asar", () => {
  const r = makeResources();
  try {
    fs.writeFileSync(`${r.asar}.rbk-100`, "old-asar");

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.equal(fs.readFileSync(r.asar, "utf-8"), "old-asar", "asar 从 .rbk- 还原");
    assert.deepEqual(fs.readdirSync(r.dir), ["gateway.asar"]);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("保守：asar 缺失但 unpacked 正式物在位（混版不可判定）→ 不还原 .rbk-，只清理", () => {
  const r = makeResources();
  try {
    // 回退换装进行到哪一步已不可判定：单边进位可能拼出「旧 asar + 新 unpacked」
    fs.mkdirSync(r.unpacked);
    fs.writeFileSync(path.join(r.unpacked, "new.node"), "new");
    fs.writeFileSync(`${r.asar}.rbk-100`, "old-asar");
    fs.mkdirSync(`${r.unpacked}.rbk-100`);

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.ok(!fs.existsSync(r.asar), "不成对不动：asar 保持缺失（由上层 fail 响亮报错）");
    assert.ok(fs.existsSync(path.join(r.unpacked, "new.node")), "unpacked 正式物不动");
    assert.deepEqual(fs.readdirSync(r.dir).sort(), ["gateway.asar.unpacked"], ".rbk- 残留被清理");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

// ── L8：换装 journal 成对自愈（rename 序列中途崩溃 → 不得拼出「新 asar + 旧 unpacked」）──

test("L8 纯判定：journal + 新版成套 → 整套新版进位（腾位在前、asar 最后）", () => {
  // 崩溃在 ①（旧 asar 挪去 .old-）与 ②（旧 unpacked 挪去 .old-）之间：
  // 正式名上只剩旧 unpacked，.new- 里是整套新版
  const plan = planSwapRecovery({
    step: 1,
    stagedUnpacked: true,
    hadOldUnpacked: true,
    formalAsar: false,
    formalUnpacked: true,
    newAsar: true,
    newUnpacked: true,
    oldAsar: true,
    oldUnpacked: false,
  });
  assert.equal(plan.action, "rollforward");
  assert.deepEqual(plan.moves, [
    { from: "unpacked", to: "oldUnpacked" },
    { from: "newUnpacked", to: "unpacked" },
    { from: "newAsar", to: "asar" },
  ]);
});

test("L8 纯判定：rename 序列还没开始（step=0）→ 先腾开正式名再整套进位", () => {
  const plan = planSwapRecovery({
    step: 0,
    stagedUnpacked: true,
    hadOldUnpacked: true,
    formalAsar: true,
    formalUnpacked: true,
    newAsar: true,
    newUnpacked: true,
    oldAsar: false,
    oldUnpacked: false,
  });
  assert.equal(plan.action, "rollforward");
  assert.deepEqual(plan.moves, [
    { from: "asar", to: "oldAsar" },
    { from: "unpacked", to: "oldUnpacked" },
    { from: "newUnpacked", to: "unpacked" },
    { from: "newAsar", to: "asar" },
  ]);
});

test("L8 纯判定：换装已完成（asar 已进位、journal 未删）→ settled 不动正式名", () => {
  const plan = planSwapRecovery({
    step: 4,
    stagedUnpacked: true,
    hadOldUnpacked: true,
    formalAsar: true,
    formalUnpacked: true,
    newAsar: false,
    newUnpacked: false,
    oldAsar: true,
    oldUnpacked: true,
  });
  assert.equal(plan.action, "settled");
  assert.deepEqual(plan.moves, []);
});

test("L8 纯判定：新版缺 unpacked（凑不齐一整套）→ 整套旧版还原，不单边进位", () => {
  const plan = planSwapRecovery({
    step: 1,
    stagedUnpacked: true,
    hadOldUnpacked: true,
    formalAsar: false,
    formalUnpacked: true,
    newAsar: true,
    newUnpacked: false,
    oldAsar: true,
    oldUnpacked: false,
  });
  assert.equal(plan.action, "rollback");
  assert.deepEqual(plan.moves, [{ from: "oldAsar", to: "asar" }]);
});

test("L8 纯判定：两边都不成套 → unpaired（不动任何正式名）", () => {
  const plan = planSwapRecovery({
    step: 1,
    stagedUnpacked: true,
    hadOldUnpacked: true,
    formalAsar: false,
    formalUnpacked: true,
    newAsar: true,
    newUnpacked: false,
    oldAsar: false,
    oldUnpacked: false,
  });
  assert.equal(plan.action, "unpaired");
  assert.deepEqual(plan.moves, []);
});

test("L8：中断现场（step=1，asar 已挪走 + 旧 unpacked 仍在正式名）→ 恢复为整套新版", () => {
  const r = makeResources();
  const ts = 1700000000000;
  try {
    // ① 之后 ② 之前崩溃：gateway.asar 在 .old-<ts>，正式名上只有旧 unpacked
    fs.mkdirSync(r.unpacked);
    fs.writeFileSync(path.join(r.unpacked, "old.node"), "old");
    fs.writeFileSync(`${r.asar}.old-${ts}`, "old-asar");
    fs.writeFileSync(`${r.asar}.new-${ts}`, "new-asar");
    fs.mkdirSync(`${r.unpacked}.new-${ts}`);
    fs.writeFileSync(path.join(`${r.unpacked}.new-${ts}`, "new.node"), "new");
    writeJournal(r, { ts, step: 1 });

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.equal(fs.readFileSync(r.asar, "utf-8"), "new-asar", "asar 进位为新版");
    assert.equal(fs.readFileSync(path.join(r.unpacked, "new.node"), "utf-8"), "new", "unpacked 也是新版");
    assert.ok(!fs.existsSync(path.join(r.unpacked, "old.node")), "不得留下旧 unpacked（版本错配）");
    assert.deepEqual(fs.readdirSync(r.dir).sort(), ["gateway.asar", "gateway.asar.unpacked"], "残留清理干净");
    assert.ok(!fs.existsSync(`${r.asar}.swap-journal.json`), "journal 已删除");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("L8：journal + 正式名全缺、.new-/.old- 成套 → 整套新版进位", () => {
  const r = makeResources();
  const ts = 1700000000001;
  try {
    // ② 之后 ③ 之前崩溃：正式 asar/unpacked 都缺失，两侧各留一整套
    fs.writeFileSync(`${r.asar}.old-${ts}`, "old-asar");
    fs.mkdirSync(`${r.unpacked}.old-${ts}`);
    fs.writeFileSync(path.join(`${r.unpacked}.old-${ts}`, "old.node"), "old");
    fs.writeFileSync(`${r.asar}.new-${ts}`, "new-asar");
    fs.mkdirSync(`${r.unpacked}.new-${ts}`);
    fs.writeFileSync(path.join(`${r.unpacked}.new-${ts}`, "new.node"), "new");
    writeJournal(r, { ts, step: 2 });

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.equal(fs.readFileSync(r.asar, "utf-8"), "new-asar", "整套新版进位");
    assert.equal(fs.readFileSync(path.join(r.unpacked, "new.node"), "utf-8"), "new");
    assert.deepEqual(fs.readdirSync(r.dir).sort(), ["gateway.asar", "gateway.asar.unpacked"]);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("L8：journal + .new- 不完整（缺 unpacked）→ 整套回退旧版，不拼混版", () => {
  const r = makeResources();
  const ts = 1700000000002;
  try {
    // 新版 unpacked 缺失（复制未成/被杀软拦掉）：只剩 .new- asar，单边进位必成混版
    fs.mkdirSync(r.unpacked);
    fs.writeFileSync(path.join(r.unpacked, "old.node"), "old");
    fs.writeFileSync(`${r.asar}.old-${ts}`, "old-asar");
    fs.writeFileSync(`${r.asar}.new-${ts}`, "new-asar");
    writeJournal(r, { ts, step: 1 });

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.equal(fs.readFileSync(r.asar, "utf-8"), "old-asar", "整套回退旧版");
    assert.ok(fs.existsSync(path.join(r.unpacked, "old.node")), "旧 unpacked 保持原样");
    assert.deepEqual(fs.readdirSync(r.dir).sort(), ["gateway.asar", "gateway.asar.unpacked"]);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("L8：journal 两边都不成套 → 保留 journal 与残留，不动正式名", () => {
  const r = makeResources();
  const ts = 1700000000003;
  try {
    fs.writeFileSync(`${r.asar}.new-${ts}`, "new-asar");
    writeJournal(r, { ts, step: 1 });

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.ok(!fs.existsSync(r.asar), "asar 保持缺失（由上层 fail 响亮报错）");
    assert.ok(fs.existsSync(`${r.asar}.new-${ts}`), "残留保留待人工处理");
    assert.ok(fs.existsSync(`${r.asar}.swap-journal.json`), "journal 保留");
    assert.ok(r.logs.some((m) => m.includes("journal")), "应有诊断日志");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("L8：无 journal 的旧现场行为不变（.new- 不全时仍单边还原 .old-）", () => {
  const r = makeResources();
  try {
    // 没有 journal → 走既有逻辑：.new- 未过 100MB 完整性下限，回落到 .old- 单边还原
    fs.mkdirSync(r.unpacked);
    fs.writeFileSync(path.join(r.unpacked, "old.node"), "old");
    fs.writeFileSync(`${r.asar}.old-100`, "old-asar");
    fs.writeFileSync(`${r.asar}.new-200`, "new-asar");

    reconcileSwapDebris((m) => r.logs.push(m), r.asar, r.unpacked);

    assert.equal(fs.readFileSync(r.asar, "utf-8"), "old-asar", "旧逻辑不变：.old- 单边还原");
    assert.deepEqual(fs.readdirSync(r.dir).sort(), ["gateway.asar", "gateway.asar.unpacked"]);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

// ── L9：内核更新锁（Windows PID 复用永久死锁）──

test("端到端：真实入口（--check，无锁态）也会对中断现场成对自愈", () => {
  const r = makeResources();
  const backup = makeBackupDir();
  const ts = 1700000000010;
  try {
    // 与 L8 集成用例同一中断现场，但走真实 main()（console.log 的日志行在 stdout）
    fs.mkdirSync(r.unpacked);
    fs.writeFileSync(path.join(r.unpacked, "old.node"), "old");
    fs.writeFileSync(`${r.asar}.old-${ts}`, "old-asar");
    fs.writeFileSync(`${r.asar}.new-${ts}`, "new-asar");
    fs.mkdirSync(`${r.unpacked}.new-${ts}`);
    fs.writeFileSync(path.join(`${r.unpacked}.new-${ts}`, "new.node"), "new");
    writeJournal(r, { ts, step: 1 });

    const out = runUpdater(r.dir, backup, ["--check"]);

    assert.match(out.stdout, /换装成对恢复/, `应有成对恢复日志，实际 stdout: ${out.stdout.slice(0, 400)}`);
    assert.equal(fs.readFileSync(r.asar, "utf-8"), "new-asar", "asar 进位为新版");
    assert.equal(fs.readFileSync(path.join(r.unpacked, "new.node"), "utf-8"), "new", "unpacked 同代");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
});

test("L9 纯判定：锁内容解析与过期/存活/兼容分支", () => {
  const now = 1_700_000_000_000;
  const alive = () => true;
  const dead = () => false;

  assert.equal(evaluateLock(null, now, alive).held, false, "无锁文件");
  assert.equal(evaluateLock("   ", now, alive).held, false, "空内容按陈旧处理");
  assert.equal(evaluateLock("{ 半个 json", now, alive).held, false, "残缺 JSON 按陈旧处理");
  assert.deepEqual(evaluateLock("{ 半个 json", now, alive).reason, "unreadable");

  // 新锁 + PID 存活 → 忙
  assert.equal(evaluateLock(JSON.stringify({ pid: 42, startedAt: now - 1000 }), now, alive).held, true);
  // 过期锁 + PID 存活 → 判死（PID 复用正是这个分支要救的场景）
  const expired = evaluateLock(JSON.stringify({ pid: 42, startedAt: now - 16 * 60_000 }), now, alive);
  assert.equal(expired.held, false);
  assert.equal(expired.reason, "expired");
  // 过期锁 + PID 已退出 → 同样判死
  assert.equal(evaluateLock(JSON.stringify({ pid: 42, startedAt: now - 16 * 60_000 }), now, dead).held, false);
  // 时钟回拨（startedAt 在未来）不当作过期
  assert.equal(evaluateLock(JSON.stringify({ pid: 42, startedAt: now + 60_000 }), now, alive).held, true);
  // JSON 缺 startedAt → 只按 PID 判定
  assert.equal(evaluateLock(JSON.stringify({ pid: 42 }), now, alive).held, true);
  assert.equal(evaluateLock(JSON.stringify({ pid: 42 }), now, dead).held, false);
  // 旧格式纯 PID → 只按 PID 判定（无超时）
  assert.equal(evaluateLock("42", now, alive).held, true);
  assert.equal(evaluateLock("42", now, dead).held, false);
  assert.equal(evaluateLock("not-a-pid", now, alive).held, false);
  assert.equal(evaluateLock("0", now, alive).held, false);
});

// 子进程跑 stage 后的脚本：acquireLock 拒绝会 process.exit(1)，进程内调用会带走测试进程。
// resources 目录为空 → 拿到锁后必然停在「找不到 gateway.asar」这一句（不会真的换装）。
// 注意：fail() 是 process.exit(1)，main() 的 finally 不会执行——拿到锁后失败会留下
// 本次进程的锁文件（陈旧锁由下次运行的 PID 判定/超时兜底清理）。
function runUpdater(resourcesDir, backupDir, args = []) {
  const res = spawnSync(process.execPath, [path.join(STAGE, "kernel-update.mjs"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      CRYOCLAW_KERNEL_BACKUP_DIR: backupDir,
      CRYOCLAW_KERNEL_RESOURCES_DIR: resourcesDir,
    },
  });
  const messages = [];
  for (const line of (res.stdout || "").split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev && ev.type === "error") messages.push(ev.message);
    } catch {}
  }
  return { status: res.status, pid: res.pid, messages, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function makeBackupDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kernel-lock-"));
}

test("L9：过期锁（startedAt 超 15 分钟 + PID 存活）→ 清理后继续", () => {
  const r = makeResources();
  const backup = makeBackupDir();
  const lock = path.join(backup, "update.lock");
  try {
    // PID 用测试进程自身（确定存活）：仅凭 PID 判活时这条锁会被误判成「有人正在升级」
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 16 * 60_000 }));

    const out = runUpdater(r.dir, backup);

    assert.equal(out.status, 1);
    assert.deepEqual(out.messages, [`找不到 gateway.asar: ${path.join(r.dir, "gateway.asar")}`], "应越过过期锁继续执行");
    // 过期锁被清理后重新落锁；子进程随后 fail() 直接 exit，锁留在盘上是本次进程的
    const relocked = JSON.parse(fs.readFileSync(lock, "utf-8"));
    assert.equal(relocked.pid, out.pid, "锁已由幸存进程重新持有（过期锁未残留）");
    assert.ok(Date.now() - relocked.startedAt < 60_000, "重新落锁的 startedAt 是本次运行时间");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
});

test("L9：新锁（PID 存活）→ 拒绝并发升级，锁保持", () => {
  const r = makeResources();
  const backup = makeBackupDir();
  const lock = path.join(backup, "update.lock");
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    const out = runUpdater(r.dir, backup);

    assert.deepEqual(out.messages, ["已有内核升级任务在进行中"]);
    assert.ok(fs.existsSync(lock), "在跑的锁不得被清理");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
});

test("L9：旧格式纯 PID 锁（PID 存活）→ 向后兼容仍拒绝", () => {
  const r = makeResources();
  const backup = makeBackupDir();
  const lock = path.join(backup, "update.lock");
  try {
    fs.writeFileSync(lock, String(process.pid));

    const out = runUpdater(r.dir, backup);

    assert.deepEqual(out.messages, ["已有内核升级任务在进行中"]);
    assert.ok(fs.existsSync(lock));
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
});

test("L9：旧格式纯 PID 锁（PID 已退出）→ 兼容清理后继续", () => {
  const r = makeResources();
  const backup = makeBackupDir();
  const lock = path.join(backup, "update.lock");
  try {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid; // 已退出的子进程 PID
    fs.writeFileSync(lock, String(deadPid));

    const out = runUpdater(r.dir, backup);

    assert.equal(out.status, 1);
    assert.deepEqual(out.messages, [`找不到 gateway.asar: ${path.join(r.dir, "gateway.asar")}`], "死锁被清理后继续");
    const relocked = JSON.parse(fs.readFileSync(lock, "utf-8"));
    assert.equal(relocked.pid, out.pid, "旧格式死锁被清理并换成新格式（{pid,startedAt}）");
    assert.notEqual(relocked.pid, deadPid);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
});
