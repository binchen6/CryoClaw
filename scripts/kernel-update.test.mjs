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
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-update-test-stage-"));
for (const name of [
  "kernel-update.mjs",
  "kernel-dist-patch.js",
  "kernel-channel.js",
  "rm-rec.js",
  "kernel-prune.js",
  "kernel-config-snapshot.js",
  "kernel-directory-swap.js",
  "gateway-dependency-policy.js",
  "kernel-runtime-policy.cjs",
]) {
  const src = fs.existsSync(path.join(HERE, "updater", name))
    ? path.join(HERE, "updater", name)
    : name === "kernel-runtime-policy.cjs" ? path.join(HERE, "..", "shared", name) : path.join(HERE, "lib", name);
  fs.copyFileSync(src, path.join(STAGE, name));
}
fs.cpSync(path.join(HERE, "..", "node_modules", "semver"), path.join(STAGE, "node_modules", "semver"), { recursive: true });

const { reconcileSwapDebris, planSwapRecovery, evaluateLock, acquireUpdaterLock, selectRollbackBackup, writeSwapJournal, readSwapJournal, stagePhysicalGateway, carryOverInjected, refreshSynchronizedVendorPlugins, assertVendoredPluginCompatibility } = await import(
  pathToFileURL(path.join(STAGE, "kernel-update.mjs")).href
);
process.once("exit", () => { try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch {} });

test("vendored official plugins must support the selected kernel before publication", t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"kernel-plugin-compat-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const plugin=path.join(root,"node_modules","openclaw","dist","extensions","feishu");fs.mkdirSync(plugin,{recursive:true});
 const manifest={name:"@openclaw/feishu",version:"2026.10.7",peerDependencies:{openclaw:">=2026.10.7"},openclaw:{compat:{pluginApi:">=2026.10.7"}}};
 fs.writeFileSync(path.join(plugin,"package.json"),JSON.stringify(manifest));fs.writeFileSync(path.join(plugin,".cryoclaw-vendor-stamp.json"),JSON.stringify({id:"feishu",packageName:manifest.name}));
 assert.deepEqual(assertVendoredPluginCompatibility(root,"2026.10.7"),["feishu"]);
 assert.throws(()=>assertVendoredPluginCompatibility(root,"2026.10.6"),/do not support OpenClaw 2026\.10\.6/);
 const stamp=path.join(plugin,".cryoclaw-vendor-stamp.json");fs.writeFileSync(stamp,"{}");assert.throws(()=>assertVendoredPluginCompatibility(root,"2026.10.7"),/vendor identity/);
});

test("synchronized vendor plugins update in staging without replacing independent plugins or trusting a wrong package", t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"kernel-sync-plugins-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const oldPkg=path.join(root,"old"),newPkg=path.join(root,"new"),staging=path.join(root,"plugins");
 const write=(base,relative,value)=>{const file=path.join(base,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==="string"?value:JSON.stringify(value));};
 for(const [id,packageName,version] of [["feishu","@openclaw/feishu","2026.10.7"],["qqbot","@openclaw/qqbot","2026.7.1"]]){
  write(oldPkg,`dist/extensions/${id}/package.json`,{name:packageName,version});
  write(oldPkg,`dist/extensions/${id}/.cryoclaw-vendor-stamp.json`,{id,packageName});
 }
 carryOverInjected(oldPkg,newPkg);
 const source="node_modules/@openclaw/feishu";write(staging,`${source}/package.json`,{name:"@openclaw/feishu",version:"2026.10.8"});write(staging,`${source}/openclaw.plugin.json`,"{}");
 assert.throws(()=>refreshSynchronizedVendorPlugins(oldPkg,newPkg,staging,"2026.10.9"),/version mismatch/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(newPkg,"dist/extensions/feishu/package.json"),"utf8")).version,"2026.10.7");
 write(staging,`${source}/package.json`,{name:"@openclaw/feishu",version:"2026.10.9"});write(staging,`${source}/dist/index.js`,"new feishu");
 assert.deepEqual(refreshSynchronizedVendorPlugins(oldPkg,newPkg,staging,"2026.10.9"),["feishu"]);
 assert.equal(JSON.parse(fs.readFileSync(path.join(newPkg,"dist/extensions/feishu/package.json"),"utf8")).version,"2026.10.9");
 assert.equal(fs.readFileSync(path.join(newPkg,"dist/extensions/feishu/dist/index.js"),"utf8"),"new feishu");
 assert.equal(JSON.parse(fs.readFileSync(path.join(newPkg,"dist/extensions/feishu/.cryoclaw-vendor-stamp.json"),"utf8")).spec,"@openclaw/feishu@2026.10.9");
 assert.equal(JSON.parse(fs.readFileSync(path.join(newPkg,"dist/extensions/qqbot/package.json"),"utf8")).version,"2026.7.1");
});

test("physical update staging copies dependencies once and reads injected artifacts from the intact old package", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-native-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, "gateway"), staged = path.join(root, "staged");
  const oldPackage = path.join(current, "node_modules", "openclaw");
  const write = (relative, value) => {
    const file = path.join(current, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  write("package.json", '{"dependencies":{"openclaw":"2026.10.5"}}');
  write("package-lock.json", '{"lockfileVersion":3}');
  write("node_modules/dependency/index.js", "original dependency");
  write("node_modules/openclaw/package.json", '{"version":"2026.10.5"}');
  write("node_modules/openclaw/dist/core.js", "obsolete core");
  write("node_modules/openclaw/skills/cryoclaw-skill/SKILL.md", "bundled skill");
  write("node_modules/openclaw/dist/extensions/custom/entry.mjs", "bundled plugin");
  write("node_modules/openclaw/dist/extensions/official/.cryoclaw-stamp.json", "stamp");
  write("node_modules/openclaw/dist/extensions/official/upstream.mjs", "old upstream");

  assert.equal(stagePhysicalGateway(current, staged), oldPackage);
  assert.equal(fs.existsSync(path.join(staged, "node_modules", "openclaw")), false, "the replaceable old core must never enter staging");
  assert.equal(fs.readFileSync(path.join(staged, "package-lock.json"), "utf8"), '{"lockfileVersion":3}');
  fs.writeFileSync(path.join(staged, "node_modules", "dependency", "index.js"), "npm changed staged dependency");
  assert.equal(fs.readFileSync(path.join(current, "node_modules", "dependency", "index.js"), "utf8"), "original dependency", "staged dependencies must not share mutable files with the live tree");

  const installed = path.join(staged, "node_modules", "openclaw");
  fs.mkdirSync(path.join(installed, "dist", "extensions", "official"), { recursive: true });
  fs.writeFileSync(path.join(installed, "dist", "extensions", "official", "upstream.mjs"), "new upstream");
  const carried = carryOverInjected(oldPackage, installed);
  assert.deepEqual(carried.map(relative => relative.replaceAll("\\", "/")).sort(), ["skills/cryoclaw-skill", "dist/extensions/custom", "dist/extensions/official/.cryoclaw-stamp.json"].sort());
  assert.equal(fs.readFileSync(path.join(installed, "skills", "cryoclaw-skill", "SKILL.md"), "utf8"), "bundled skill");
  assert.equal(fs.readFileSync(path.join(installed, "dist", "extensions", "official", "upstream.mjs"), "utf8"), "new upstream");
  assert.equal(fs.readFileSync(path.join(oldPackage, "dist", "core.js"), "utf8"), "obsolete core", "carryover must leave the rollback source intact");
});

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
  assert.equal(evaluateLock("   ", now, alive).held, true, "初始化中的空锁不得被夺取");
  assert.equal(evaluateLock("{ 半个 json", now, alive).held, true, "初始化中的半写锁不得被夺取");
  assert.deepEqual(evaluateLock("{ 半个 json", now, alive).reason, "unreadable");

  // 新锁 + PID 存活 → 忙
  assert.equal(evaluateLock(JSON.stringify({ pid: 42, startedAt: now - 1000 }), now, alive).held, true);
  // 年龄超过桌面 watchdog 也不能夺取独立 CLI 的活锁。
  const expired = evaluateLock(JSON.stringify({ pid: 42, startedAt: now - 16 * 60_000 }), now, alive);
  assert.equal(expired.held, true);
  assert.equal(expired.reason, "alive");
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
  assert.equal(evaluateLock("not-a-pid", now, alive).held, true);
  assert.equal(evaluateLock("0", now, alive).held, true);
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

test('updater lock publishes a complete owner atomically, rejects contention and releases only its owner', t => {
  const dir = makeBackupDir(); t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'update.lock'); let publications = 0;
  const io = {...fs, linkSync(source, target) {
    const record = JSON.parse(fs.readFileSync(source, 'utf8'));
    assert.equal(record.pid, process.pid); assert.match(record.owner, /^[a-f0-9-]+$/);
    assert.equal(fs.existsSync(target), false);
    fs.linkSync(source, target); publications++;
  }};
  const release = acquireUpdaterLock(file, {io});
  assert.equal(publications, 1);
  assert.throws(() => acquireUpdaterLock(file), /已有内核升级任务/);
  const replacement = {pid:process.pid,startedAt:Date.now(),owner:'replacement'};
  fs.writeFileSync(file, JSON.stringify(replacement)); release();
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')), replacement);
  fs.unlinkSync(file);
  const ownRelease = acquireUpdaterLock(file); ownRelease();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('unsupported hard links fail closed and clean only the private owner file', t => {
  const dir = makeBackupDir(); t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'update.lock'); fs.writeFileSync(path.join(dir,'unrelated'), 'keep');
  assert.throws(() => acquireUpdaterLock(file, {io:{...fs,linkSync(){throw Object.assign(Error('no hardlinks'),{code:'ENOTSUP'});}}}), /原子发布.*ENOTSUP/);
  assert.deepEqual(fs.readdirSync(dir), ['unrelated']);
});

test('failed private owner writes remove their own incomplete file without publishing a lock', t => {
  const dir=makeBackupDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'update.lock');
  const io={...fs,writeFileSync(target,value,options){fs.writeFileSync(target,'{"pid":',options);throw Object.assign(Error('disk write failed'),{code:'EIO'});}};
  assert.throws(()=>acquireUpdaterLock(file,{io}),/disk write failed/);
  assert.deepEqual(fs.readdirSync(dir),[]);
});

test('unknown legacy lock owners remain closed even when an old writer holds its FD beyond the former grace period', t => {
  const dir = makeBackupDir(); t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'update.lock');
  const fd=fs.openSync(file,'wx');
  try{
    fs.utimesSync(file,new Date(0),new Date(0));
    assert.throws(()=>acquireUpdaterLock(file),/缺少可验证的持有者.*确认旧更新器已退出/);
    const original=JSON.stringify({pid:process.pid,startedAt:Date.now()-60_000});
    fs.writeSync(fd,original);
    assert.equal(fs.readFileSync(file,'utf8'),original,'the old writer must still own the named lock');
    assert.throws(()=>acquireUpdaterLock(file),/已有内核升级任务/);
  }finally{fs.closeSync(fd);}
  fs.writeFileSync(file,'{"pid":');fs.utimesSync(file,new Date(0),new Date(0));
  assert.throws(()=>acquireUpdaterLock(file),/缺少可验证的持有者.*确认旧更新器已退出/);
  assert.equal(fs.readFileSync(file,'utf8'),'{"pid":');
  fs.unlinkSync(file);
  const deadPid = spawnSync(process.execPath, ['-e','']).pid;
  fs.writeFileSync(file, String(deadPid)); acquireUpdaterLock(file)();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a contender publishing first keeps its lock when another initialized owner loses publication', t => {
  const dir=makeBackupDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'update.lock');let winnerRelease, winnerRaw;
  const io={...fs,linkSync(source,target){
    if(!winnerRelease){winnerRelease=acquireUpdaterLock(file);winnerRaw=fs.readFileSync(file,'utf8');}
    fs.linkSync(source,target);
  }};
  assert.throws(()=>acquireUpdaterLock(file,{io}),/已有内核升级任务/);
  assert.equal(fs.readFileSync(file,'utf8'),winnerRaw);
  assert.deepEqual(fs.readdirSync(dir),['update.lock']);winnerRelease();
});

test('stale lock reclamation is serialized so a delayed remover cannot delete a new live owner', t => {
  const dir=makeBackupDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'update.lock'),deadPid=spawnSync(process.execPath,['-e','']).pid;
  fs.writeFileSync(file,String(deadPid)); let competingRelease, checked=false;
  const io={...fs,unlinkSync(target){
    if(target===file&&!checked){checked=true;
      try{competingRelease=acquireUpdaterLock(file);}catch(error){assert.match(error.message,/已有内核升级任务/);}
      assert.equal(competingRelease,undefined,'only one stale remover may progress');
    }
    fs.unlinkSync(target);
  }};
  try{const release=acquireUpdaterLock(file,{io});release();assert.equal(checked,true);assert.deepEqual(fs.readdirSync(dir),[]);}
  finally{competingRelease?.();}
});

test('orphan cleanup removes only a validated dead private owner and preserves live or unrelated evidence', t => {
  const dir=makeBackupDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'update.lock'),deadPid=spawnSync(process.execPath,['-e','']).pid;
  const owner='10000000-0000-4000-8000-000000000000';
  const dead=`update.lock.owner-${deadPid}-${owner}`,live=`update.lock.owner-${process.pid}-${owner}`;
  fs.writeFileSync(path.join(dir,dead),JSON.stringify({pid:deadPid,owner}));
  fs.writeFileSync(path.join(dir,live),JSON.stringify({pid:process.pid,owner}));
  fs.writeFileSync(path.join(dir,'update.lock.owner-unrelated'),'keep');
  const release=acquireUpdaterLock(file);release();
  assert.equal(fs.existsSync(path.join(dir,dead)),false);
  assert.deepEqual(fs.readdirSync(dir).sort(),[live,'update.lock.owner-unrelated'].sort());
});

test('a crashed stale-lock reclaimer is superseded atomically and its dead claim is cleaned after publication', t => {
  const dir=makeBackupDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'update.lock'),deadPid=spawnSync(process.execPath,['-e','']).pid;
  fs.writeFileSync(file,String(deadPid));const stat=fs.lstatSync(file),raw=fs.readFileSync(file,'utf8');
  const key=JSON.stringify([stat.dev,stat.ino,stat.birthtimeMs,raw]);
  const claim=file+'.reap-'+createHash('sha256').update(key).digest('hex');
  fs.writeFileSync(claim,JSON.stringify({pid:deadPid,startedAt:Date.now(),owner:'dead-reclaimer'}));
  const release=acquireUpdaterLock(file);release();
  assert.deepEqual(fs.readdirSync(dir),[]);
});

test('a finite chain of more than 32 dead reclaimers recovers without a permanent depth limit', t => {
  const dir=makeBackupDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'update.lock'),deadPid=spawnSync(process.execPath,['-e','']).pid;
  fs.writeFileSync(file,String(deadPid));let previous=file;
  for(let depth=0;depth<40;depth++){
    const stat=fs.lstatSync(previous),raw=fs.readFileSync(previous,'utf8');
    const key=JSON.stringify([stat.dev,stat.ino,stat.birthtimeMs,raw]);
    const claim=file+'.reap-'+createHash('sha256').update(key).digest('hex');
    fs.writeFileSync(claim,JSON.stringify({pid:deadPid,owner:'dead-reclaimer-'+depth}));previous=claim;
  }
  const release=acquireUpdaterLock(file);release();
  assert.deepEqual(fs.readdirSync(dir),[]);
});

test('cyclic dead reclaimer identities fail closed and retain the original evidence',t=>{
  const dir=makeBackupDir();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'update.lock'),deadPid=spawnSync(process.execPath,['-e','']).pid;
  fs.writeFileSync(file,String(deadPid));const stat=fs.lstatSync(file),raw=fs.readFileSync(file,'utf8');
  const key=JSON.stringify([stat.dev,stat.ino,stat.birthtimeMs,raw]);
  const claim=file+'.reap-'+createHash('sha256').update(key).digest('hex');fs.linkSync(file,claim);
  assert.throws(()=>acquireUpdaterLock(file),/清理链存在循环.*已保留现场/);
  assert.equal(fs.readFileSync(file,'utf8'),raw);
  assert.deepEqual(fs.readdirSync(dir).sort(),[path.basename(file),path.basename(claim)].sort());
});

test('rollback skips a failed update backup of the current version and ignores incomplete identities', async t => {
  const root = makeBackupDir(); t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  function backup(version, timestamp, actual=version) {
    const name=`gateway-${version}-${timestamp}`, dir=path.join(root,name), pkg=path.join(dir,'gateway/node_modules/openclaw');
    fs.mkdirSync(pkg,{recursive:true}); fs.writeFileSync(path.join(pkg,'package.json'), JSON.stringify({version:actual}));
    fs.writeFileSync(path.join(pkg,'openclaw.mjs'), 'export {};');
    fs.writeFileSync(path.join(dir,'physical-backup-complete.json'), JSON.stringify({version})); return name;
  }
  const previous=backup('2026.10.5',100); backup('2026.10.7',200);
  backup('2026.10.4',300,'2026.10.7');
  assert.deepEqual(await selectRollbackBackup('2026.10.7',{root,native:true}), {name:previous,version:'2026.10.5'});
  assert.equal(await selectRollbackBackup('2026.10.7',{root,native:true,names:['gateway-2026.10.7-200']}), null);
});

test('legacy ASAR rollback still restores a valid backup when the current version cannot be read',t=>{
  const r=makeResources(),root=makeBackupDir(),moduleDir=path.join(STAGE,'node_modules/@electron/asar');
  t.after(()=>{fs.rmSync(r.dir,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});fs.rmSync(moduleDir,{recursive:true,force:true});});
  fs.mkdirSync(moduleDir,{recursive:true});
  fs.writeFileSync(path.join(moduleDir,'package.json'),'{"name":"@electron/asar","type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(moduleDir,'index.js'),'import fs from "node:fs"; export function extractFile(file){return fs.readFileSync(file);}');
  fs.writeFileSync(r.asar,'damaged current archive');
  const backup=path.join(root,'gateway-2026.10.5-100');fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup,'gateway.asar'),'{"version":"2026.10.5"}');
  const out=runUpdater(r.dir,root,['--rollback']);
  assert.equal(out.status,0,out.stdout+out.stderr);
  assert.equal(JSON.parse(fs.readFileSync(r.asar,'utf8')).version,'2026.10.5');
});

test("L9：超过 15 分钟但 PID 存活的锁仍拒绝并发更新", () => {
  const r = makeResources();
  const backup = makeBackupDir();
  const lock = path.join(backup, "update.lock");
  try {
    // PID 用测试进程自身，证明长时间运行的独立 CLI 仍受到互斥保护。
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 16 * 60_000 }));

    const out = runUpdater(r.dir, backup);

    assert.equal(out.status, 1);
    assert.deepEqual(out.messages, ["已有内核升级任务在进行中"]);
    // 被拒绝的子进程不能修改原 owner。
    const relocked = JSON.parse(fs.readFileSync(lock, "utf-8"));
    assert.equal(relocked.pid, process.pid, "不能夺取仍存活的 CLI 更新器锁");
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
