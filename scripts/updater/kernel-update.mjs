#!/usr/bin/env node
/**
 * kernel-update.mjs — CryoClaw 内核（openclaw）运行时升级/回退
 *
 * 差分式 asar 换装：npm 安装新版 openclaw → 从旧 asar 搬入 CryoClaw 注入物
 * （skills、dist/extensions 下新包没有的插件目录）→ 重打共享补丁 → 冒烟 →
 * 重打 gateway.asar → 备份旧 asar → 换装 → 写状态文件。
 *
 * 运行环境：CryoClaw-CLI.exe / CryoClaw.exe + ELECTRON_RUN_AS_NODE=1（Node ≥22）。
 * 安装位置：<install>/resources/resources/updater/kernel-update.mjs，
 * 同级需有 kernel-dist-patch.js、kernel-prune.js、rm-rec.js 与 node_modules/（含 @electron/asar）。
 *
 * 用法：
 *   kernel-update.mjs                 升级到 registry latest
 *   kernel-update.mjs --tag <ver>     升级到指定版本（也可用于降级）
 *   kernel-update.mjs --check         只查询当前/最新版本
 *   kernel-update.mjs --rollback      回退到最近一次备份
 *   （CLI wrapper 透传时首个参数可能是 "update"，会被忽略）
 *
 * 进度协议：stdout 每行一个 JSON 对象
 *   {"type":"progress","step":string,"pct":0-100,"msg":string}
 *   {"type":"state","current":string,"latest":string,"updateAvailable":boolean}
 *   {"type":"done","action":"update"|"rollback","from":string,"to":string}
 *   {"type":"error","message":string}
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import kdp from "./kernel-dist-patch.js";

// Electron 的 fs 补丁会把 .asar 路径当归档目录拦截——copyFile/rename/rm 直接作用于
// gateway.asar 文件本身时会 ENOENT。original-fs 是未打补丁的原生 fs，本脚本所有
// 文件操作统一走它；开发环境（系统 node）没有 original-fs，回退普通 fs。
const xfs = (() => {
  try {
    return createRequire(import.meta.url)("original-fs");
  } catch {
    return fs;
  }
})();

// Windows + Node 24 的 fs.rmSync 偶发静默失败（目录仍存在但不抛错），递归目录删除
// 统一走 rm-rec.js 的 rmRecursive（带手动 fallback）。文件删除仍用 xfs.rmSync 即可。
const rmRecursive = createRequire(import.meta.url)("./rm-rec.js")(xfs);

// 运行时内核裁剪（kernel-prune.js）：npm 安装的新内核树是未裁剪的完整发布包，
// 不裁剪会让升级后的 gateway.asar 比出厂版本膨胀上百 MB（ffmpeg/koffi/.map 等）。
const { pruneGatewayTree } = createRequire(import.meta.url)("./kernel-prune.js")(xfs);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = (process.env.CRYOCLAW_NPM_REGISTRY || "https://registry.npmmirror.com").replace(/\/+$/, "");
const KERNEL_PACKAGE = "openclaw";
const UNPACK_GLOB = "{**/*.node,**/*.exe,**/*.dll,**/*.dylib,**/*.so,**/spawn-helper}";
const SMOKE_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_MS = 20_000;
const NPM_TIMEOUT_MS = 600_000;
const MAX_BACKUPS = 2;

const RESOURCES_DIR = process.env.CRYOCLAW_KERNEL_RESOURCES_DIR || path.resolve(SCRIPT_DIR, "..");
const BACKUP_ROOT =
  process.env.CRYOCLAW_KERNEL_BACKUP_DIR ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), "CryoClaw", "kernel-backup");
const STATE_FILE = path.join(BACKUP_ROOT, "kernel-update-state.json");
const LOCK_FILE = path.join(BACKUP_ROOT, "update.lock");

const ASAR_PATH = path.join(RESOURCES_DIR, "gateway.asar");
const ASAR_UNPACKED_DIR = path.join(RESOURCES_DIR, "gateway.asar.unpacked");

// V8 编译缓存目录（与 src/gateway-process.ts 的 NODE_COMPILE_CACHE 一致）。
// 内核换装/回退后旧缓存全部失效，清空避免残留旧版本的编译产物。
function clearCompileCache() {
  try {
    const home = (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
    const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
    rmRecursive(path.join(stateDir, "cache", "v8-compile"));
  } catch {}
}

// ── 进度协议 ──

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function progress(step, pct, msg) {
  emit({ type: "progress", step, pct, msg });
}
function fail(message, err) {
  emit({ type: "error", message: err ? `${message}: ${err.message || err}` : message });
  process.exit(1);
}

// ── 工具 ──

function resolveNpmBin() {
  return process.platform === "win32"
    ? path.join(RESOURCES_DIR, "runtime", "npm.cmd")
    : path.join(RESOURCES_DIR, "runtime", "npm");
}

function resolveNodeExe() {
  // CryoClaw-CLI.exe（CONSOLE 子系统）优先，回退主 exe；二者都靠 ELECTRON_RUN_AS_NODE 跑脚本
  const installRoot = path.resolve(RESOURCES_DIR, "..", "..");
  const cli = path.join(installRoot, "CryoClaw-CLI.exe");
  const main = path.join(installRoot, "CryoClaw.exe");
  if (process.env.CRYOCLAW_CLI_EXE && xfs.existsSync(process.env.CRYOCLAW_CLI_EXE)) return process.env.CRYOCLAW_CLI_EXE;
  if (xfs.existsSync(cli)) return cli;
  if (xfs.existsSync(main)) return main;
  return process.execPath; // 开发环境回退
}

function npmRun(args, cwd) {
  // Windows 上 npm 是 npm.cmd（批处理脚本），Node 直接 spawn .cmd 需要经 cmd.exe 解释。
  // 历史上用 shell:true + args 触发 Node 22+ DEP0190（args+shell 组合不安全），
  // 改为显式调用 cmd.exe /c npm.cmd args，shell:false 避免 DEP0190。
  const fullArgs = [...args, "--registry", REGISTRY];
  let cmd;
  let cmdArgs;
  if (process.platform === "win32") {
    cmd = "cmd.exe";
    cmdArgs = ["/c", resolveNpmBin(), ...fullArgs];
  } else {
    cmd = resolveNpmBin();
    cmdArgs = fullArgs;
  }
  // openclaw ≥2026.8 的 preinstall 会用裸 `node` 校验版本（>=22.22.3 <23 ||
  // >=24.15.0 <25 || >=25.9.0），按 PATH 解析——用户机器上可能没有系统 Node，
  // 或版本不在范围内（都会直接拒装）。把捆绑 runtime 目录前置到 PATH，确保
  // 生命周期脚本里的 `node` 命中我们钉的 22.x 运行时。
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  env[pathKey] = path.join(RESOURCES_DIR, "runtime") + path.delimiter + (env[pathKey] || "");
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args[0]} 退出码 ${result.status}: ${(result.stderr || result.stdout || "").slice(-800)}`);
  }
  return result.stdout;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: HTTP_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

async function fetchLatestVersion() {
  const data = await fetchJson(`${REGISTRY}/${KERNEL_PACKAGE}/latest`);
  if (!data || typeof data.version !== "string") throw new Error("registry 响应缺少 version");
  return data.version;
}

// asar 库懒加载（ESM-only 依赖，vendor 在同级 node_modules）
let asarLib = null;
async function asar() {
  if (!asarLib) asarLib = await import("@electron/asar");
  return asarLib;
}

function readVersionFromTree(gatewayDir) {
  const pkgPath = path.join(gatewayDir, "node_modules", KERNEL_PACKAGE, "package.json");
  const pkg = JSON.parse(xfs.readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

async function readCurrentVersion() {
  const a = await asar();
  const pkg = JSON.parse(
    a.extractFile(ASAR_PATH, path.join("node_modules", KERNEL_PACKAGE, "package.json")).toString()
  );
  return pkg.version;
}

// 从旧 openclaw 包目录把"新包没有"的 CryoClaw 注入物搬入新包目录。
// 覆盖两类：skills/（CryoClaw 内置 skills）与 dist/extensions/（kimi-search、
// dingtalk-connector、@openclaw/* vendor 等打包期注入的插件）。
// 返回搬运条目清单（用于日志与审计）。
//
// 注入物文件名新旧双名识别：旧版构建/旧内核里的注入物是 oneclaw-* 文件名
// （oneclaw-bundled-entry.mjs / .oneclaw-channel-shim.json / .oneclaw-<id>-stamp.json），
// 新版为 cryoclaw-*。上游已自带同名插件目录时，仍把其中"新包缺失"的注入物文件
// （两种命名都认）补搬过去，避免 channel shim 随换装丢失。
const INJECTED_ARTIFACT_RE = /^\.?(?:oneclaw|cryoclaw)-.*/;
function carryOverInjected(oldPkgDir, newPkgDir) {
  const carried = [];
  for (const sub of ["skills", path.join("dist", "extensions")]) {
    const oldSub = path.join(oldPkgDir, sub);
    const newSub = path.join(newPkgDir, sub);
    if (!xfs.existsSync(oldSub)) continue;
    xfs.mkdirSync(newSub, { recursive: true });
    for (const entry of xfs.readdirSync(oldSub, { withFileTypes: true })) {
      const dest = path.join(newSub, entry.name);
      if (xfs.existsSync(dest)) {
        // 上游自带该目录，用新版；但补齐旧树里新包缺失的注入物文件（新旧双名）
        if (entry.isDirectory()) {
          for (const f of xfs.readdirSync(path.join(oldSub, entry.name))) {
            if (!INJECTED_ARTIFACT_RE.test(f)) continue;
            const fdest = path.join(dest, f);
            if (xfs.existsSync(fdest)) continue;
            xfs.copyFileSync(path.join(oldSub, entry.name, f), fdest);
            carried.push(`${sub}/${entry.name}/${f}`);
          }
        }
        continue;
      }
      xfs.cpSync(path.join(oldSub, entry.name), dest, { recursive: true });
      carried.push(`${sub}/${entry.name}`);
    }
  }
  return carried;
}

// ── 锁与状态 ──

function acquireLock() {
  xfs.mkdirSync(BACKUP_ROOT, { recursive: true });
  if (xfs.existsSync(LOCK_FILE)) {
    let alive = false;
    try {
      const pid = Number(xfs.readFileSync(LOCK_FILE, "utf-8").trim());
      if (pid) {
        try {
          process.kill(pid, 0); // 不抛错即存活
          alive = true;
        } catch (e) {
          alive = !e || e.code !== "ESRCH"; // EPERM 等也视为存活
        }
      }
    } catch {}
    if (alive) fail("已有内核升级任务在进行中");
    xfs.rmSync(LOCK_FILE, { force: true }); //  stale lock，清理
  }
  xfs.writeFileSync(LOCK_FILE, String(process.pid), "utf-8");
}

function releaseLock() {
  try {
    xfs.rmSync(LOCK_FILE, { force: true });
  } catch {}
}

function writeState(patch) {
  xfs.mkdirSync(BACKUP_ROOT, { recursive: true });
  let prev = {};
  try {
    prev = JSON.parse(xfs.readFileSync(STATE_FILE, "utf-8"));
  } catch {}
  xfs.writeFileSync(STATE_FILE, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), "utf-8");
}

// 安全面：内核版本号格式校验。openclaw 采用日历版本号，形如 2026.7.1-2 / 2026.7.1-rc.3。
// 校验避免 --tag 后续被拼接进 npm 安装命令（npmRun）或写入 package.json 时引发注入
// （如 tag="foo bar --cache=./.npmrc"，会被 npm.cmd 解析成多个参数）。
// 允许：\d+\.\d+\.\d+ 后接可选 -< prerelease 标签 >；首尾不能含路径分隔符与空白。
const KERNEL_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function validateKernelVersion(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return false;
  return KERNEL_VERSION_RE.test(v);
}

// 备份目录命名规则：gateway-<version>-<timestamp-ms>
// listBackups 只接受严格匹配的目录名，防止 BACKUP_ROOT 下混入恶意目录被当成回退目标
// （version 仍用 KERNEL_VERSION_RE 校验，timestamp 必须是纯数字）。
const BACKUP_DIR_RE = /^gateway-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(\d+)$/;

function listBackups() {
  if (!xfs.existsSync(BACKUP_ROOT)) return [];
  return xfs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BACKUP_DIR_RE.test(e.name))
    .map((e) => e.name)
    // 只认完整备份（历史失败可能残留空目录）
    .filter((name) => xfs.existsSync(path.join(BACKUP_ROOT, name, "gateway.asar")))
    // 按名称尾部时间戳数字降序（字典序对位数不同的数字不可靠，NaN 排最后）
    .sort((a, b) => {
      const ta = Number(a.split("-").pop());
      const tb = Number(b.split("-").pop());
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });
}

// 从备份目录名解析内核版本号（严格按 BACKUP_DIR_RE 第 1 捕获组提取）
function backupVersionOf(name) {
  const m = BACKUP_DIR_RE.exec(name);
  return m ? m[1] : null;
}

// Gateway 运行中会持有 gateway.asar 句柄，rename 会 EPERM/EBUSY——给出可操作的提示。
function renameWithLockHint(src, dest) {
  try {
    xfs.renameSync(src, dest);
  } catch (e) {
    if (e && (e.code === "EPERM" || e.code === "EBUSY")) {
      throw new Error(
        "gateway.asar 被占用（Gateway 正在运行）。请改用设置页的内核升级（自动停启 Gateway），或先停止 Gateway 后重试"
      );
    }
    throw e;
  }
}

// ── 升级主流程 ──

async function cmdUpdate(tag) {
  // 安全面：--tag 后的版本号必须通过格式校验，否则中止升级（防止注入 npm 参数）
  if (tag != null && !validateKernelVersion(tag)) {
    fail(`--tag 版本号格式非法: ${JSON.stringify(tag)}（应为 N.N.N 或 N.N.N-pre）`);
  }
  progress("prepare", 2, "读取当前内核版本");
  const current = await readCurrentVersion();
  const target = tag || (await fetchLatestVersion());
  if (!validateKernelVersion(target)) {
    fail(`registry 返回的 latest 版本号格式非法: ${JSON.stringify(target)}`);
  }
  emit({ type: "state", current, latest: target, updateAvailable: current !== target });

  const staging = xfs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-kernel-update-"));
  let swapped = false;
  try {
    progress("download", 8, `npm 安装 ${KERNEL_PACKAGE}@${target}（staging）`);
    const stagingGateway = path.join(staging, "gateway");

    const a = await asar();
    a.extractAll(ASAR_PATH, stagingGateway);

    // 旧内核包挪出，npm 装新版后做注入物搬运
    const pkgDir = path.join(stagingGateway, "node_modules", KERNEL_PACKAGE);
    const oldPkgDir = path.join(staging, "openclaw-old");
    xfs.renameSync(pkgDir, oldPkgDir);

    // 记录旧树是否保留 llama 依赖（出厂构建默认裁掉；CRYOCLAW_KEEP_LLAMA 构建保留）。
    // npm install 会把它们重新装回来，升级后需按出厂状态对齐裁剪。
    const nmDir = path.join(stagingGateway, "node_modules");
    const keepLlama =
      xfs.existsSync(path.join(nmDir, "node-llama-cpp")) ||
      xfs.existsSync(path.join(nmDir, "@node-llama-cpp"));

    const gwPkgPath = path.join(stagingGateway, "package.json");
    const gwPkg = JSON.parse(xfs.readFileSync(gwPkgPath, "utf-8"));
    gwPkg.dependencies = { ...(gwPkg.dependencies || {}), [KERNEL_PACKAGE]: target };
    xfs.writeFileSync(gwPkgPath, JSON.stringify(gwPkg, null, 2), "utf-8");

    npmRun(["install", "--omit=dev", "--install-links", "--legacy-peer-deps", "--no-audit", "--no-fund"], stagingGateway);
    const installed = readVersionFromTree(stagingGateway);
    if (installed !== target) {
      throw new Error(`npm 安装结果版本 ${installed} 与目标 ${target} 不一致`);
    }

    // npm 装回的是完整发布包——按打包期口径裁剪死重（ffmpeg/koffi/prebuilds/.map 等），
    // 否则升级后的 gateway.asar 比出厂版本膨胀上百 MB。注入物搬运在裁剪之后，
    // 搬运内容来自已裁剪的旧树，不受影响。
    progress("prune", 25, "裁剪新内核冗余文件（ffmpeg/koffi/文档/地图文件）");
    const pruned = pruneGatewayTree(stagingGateway, { keepLlama });
    const prunedMB = (pruned.bytes / 1048576).toFixed(1);
    progress(
      "prune",
      28,
      `裁剪完成：删除 ${pruned.removedDirs} 个目录、${pruned.removedFiles} 个文件，节省 ${prunedMB} MB` +
        (pruned.errors.length > 0 ? `（${pruned.errors.length} 个步骤跳过）` : "")
    );

    progress("carryover", 30, "搬运 CryoClaw 注入的插件与 skills");
    const newPkgDir = path.join(stagingGateway, "node_modules", KERNEL_PACKAGE);
    const carried = carryOverInjected(oldPkgDir, newPkgDir);
    rmRecursive(oldPkgDir);
    progress("carryover", 35, `已搬运 ${carried.length} 个注入条目`);

    progress("patch", 45, "应用 asar 边界补丁与 windowsHide 补丁");
    const winResult = kdp.patchWindowsOpenclawArtifacts(stagingGateway, process.platform);
    const patched = kdp.patchAsarBoundaryCheck(stagingGateway);
    if (patched === 0) {
      throw new Error("asar 边界补丁未命中任何模块（上游结构变化？），中止升级");
    }
    // kimi 思考档位补丁为行为增强（非 asar 必需），未命中仅告警不中止
    if (kdp.patchKimiThinkingProfile(stagingGateway) === 0) {
      progress("patch", 46, "kimi 思考档位补丁未命中（上游已修复或结构变化），跳过");
    }

    progress("smoke", 58, `冒烟测试 openclaw --version`);
    const openclawMjs = path.join(newPkgDir, "openclaw.mjs");
    const smoke = spawnSync(resolveNodeExe(), [openclawMjs, "--version"], {
      encoding: "utf8",
      timeout: SMOKE_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCLAW_NO_RESPAWN: "1" },
    });
    if (smoke.error || smoke.status !== 0) {
      const detail = smoke.error ? smoke.error.message : (smoke.stderr || smoke.stdout || "").slice(-500);
      throw new Error(`新内核冒烟测试失败: ${detail}`);
    }

    progress("pack", 68, "重新打包 gateway.asar");
    const newAsar = path.join(staging, "gateway.asar");
    await a.createPackageWithOptions(stagingGateway, newAsar, { unpack: UNPACK_GLOB });
    const packedUnpacked = `${newAsar}.unpacked`;

    // 校验新 asar 内版本
    const packedVersion = JSON.parse(
      a.extractFile(newAsar, path.join("node_modules", KERNEL_PACKAGE, "package.json")).toString()
    ).version;
    if (packedVersion !== target) {
      throw new Error(`新 asar 内版本 ${packedVersion} 与目标 ${target} 不一致`);
    }

    progress("backup", 80, `备份当前内核 ${current}`);
    const backupDir = path.join(BACKUP_ROOT, `gateway-${current}-${Date.now()}`);
    xfs.mkdirSync(backupDir, { recursive: true });
    xfs.copyFileSync(ASAR_PATH, path.join(backupDir, "gateway.asar"));
    if (xfs.existsSync(ASAR_UNPACKED_DIR)) {
      xfs.cpSync(ASAR_UNPACKED_DIR, path.join(backupDir, "gateway.asar.unpacked"), { recursive: true });
    }

    progress("swap", 88, "换装新内核");
    // 同卷临时名 + rename 进位：先复制新物到 RESOURCES_DIR 下临时名，再依次 rename
    // 旧物 → .old-<ts>、新物 → 正式名，任何一步失败都不会留下残缺的正式名文件
    const ts = Date.now();
    const newAsarTmp = `${ASAR_PATH}.new-${ts}`;
    const oldAsarTmp = `${ASAR_PATH}.old-${ts}`;
    const newUnpackedTmp = `${ASAR_UNPACKED_DIR}.new-${ts}`;
    const oldUnpackedTmp = `${ASAR_UNPACKED_DIR}.old-${ts}`;
    xfs.copyFileSync(newAsar, newAsarTmp);
    let unpackedStaged = false;
    try {
      if (xfs.existsSync(packedUnpacked)) {
        xfs.cpSync(packedUnpacked, newUnpackedTmp, { recursive: true });
        unpackedStaged = true;
      }
      renameWithLockHint(ASAR_PATH, oldAsarTmp);
      let asarSwapped = false;
      let unpackedSwapped = false;
      try {
        if (xfs.existsSync(ASAR_UNPACKED_DIR)) renameWithLockHint(ASAR_UNPACKED_DIR, oldUnpackedTmp);
        if (unpackedStaged) {
          renameWithLockHint(newUnpackedTmp, ASAR_UNPACKED_DIR);
          unpackedSwapped = true;
        }
        renameWithLockHint(newAsarTmp, ASAR_PATH);
        asarSwapped = true;
      } catch (e) {
        // 换装中途失败：尽力按原样还原（rename 顺序倒着来）
        try {
          if (!asarSwapped && xfs.existsSync(oldAsarTmp) && !xfs.existsSync(ASAR_PATH)) xfs.renameSync(oldAsarTmp, ASAR_PATH);
          if (unpackedSwapped) xfs.renameSync(ASAR_UNPACKED_DIR, newUnpackedTmp);
          if (xfs.existsSync(oldUnpackedTmp) && !xfs.existsSync(ASAR_UNPACKED_DIR)) xfs.renameSync(oldUnpackedTmp, ASAR_UNPACKED_DIR);
        } catch {}
        throw e;
      }
      xfs.rmSync(oldAsarTmp, { force: true });
      rmRecursive(oldUnpackedTmp);
    } catch (e) {
      // 清理残留的临时物（成功路径已在上面删完 .old，.new 只可能存在于失败路径）
      try {
        xfs.rmSync(newAsarTmp, { force: true });
        rmRecursive(newUnpackedTmp);
      } catch {}
      throw e;
    }
    swapped = true;

    clearCompileCache();
    writeState({ lastAction: "update", previous: current, current: target, backupDir, carried });
    progress("cleanup", 96, "清理临时文件");
    emit({ type: "done", action: "update", from: current, to: target });
  } finally {
    try {
      rmRecursive(staging);
    } catch {}
    // 只保留最近 MAX_BACKUPS 份备份
    if (swapped) {
      const backups = listBackups();
      for (const old of backups.slice(MAX_BACKUPS)) {
        try {
          rmRecursive(path.join(BACKUP_ROOT, old));
        } catch {}
      }
    }
  }
}

// ── 回退 ──

async function cmdRollback() {
  progress("prepare", 5, "查找可用备份");
  const backups = listBackups();
  if (backups.length === 0) throw new Error("没有可用的内核备份，无法回退");
  const backupDir = path.join(BACKUP_ROOT, backups[0]);
  const backupAsar = path.join(backupDir, "gateway.asar");
  if (!xfs.existsSync(backupAsar)) throw new Error(`备份损坏（缺少 gateway.asar）: ${backupDir}`);

  const a = await asar();
  const backupVersion = JSON.parse(
    a.extractFile(backupAsar, path.join("node_modules", KERNEL_PACKAGE, "package.json")).toString()
  ).version;
  let current = "unknown";
  try {
    current = await readCurrentVersion();
  } catch {}

  progress("swap", 40, `回退内核 ${current} → ${backupVersion}`);
  // 同卷临时名 + rename 进位（与 cmdUpdate swap 同策略）：备份物先复制到临时名，
  // 再 rename 旧物 → .rbk-<ts>、备份物 → 正式名，中途失败尽力还原
  const ts = Date.now();
  const bakAsarTmp = `${ASAR_PATH}.new-${ts}`;
  const curAsarTmp = `${ASAR_PATH}.rbk-${ts}`;
  const bakUnpackedTmp = `${ASAR_UNPACKED_DIR}.new-${ts}`;
  const curUnpackedTmp = `${ASAR_UNPACKED_DIR}.rbk-${ts}`;
  xfs.copyFileSync(backupAsar, bakAsarTmp);
  let unpackedStaged = false;
  try {
    const backupUnpacked = path.join(backupDir, "gateway.asar.unpacked");
    if (xfs.existsSync(backupUnpacked)) {
      xfs.cpSync(backupUnpacked, bakUnpackedTmp, { recursive: true });
      unpackedStaged = true;
    }
    if (xfs.existsSync(ASAR_PATH)) renameWithLockHint(ASAR_PATH, curAsarTmp);
    let asarSwapped = false;
    let unpackedSwapped = false;
    try {
      if (xfs.existsSync(ASAR_UNPACKED_DIR)) renameWithLockHint(ASAR_UNPACKED_DIR, curUnpackedTmp);
      if (unpackedStaged) {
        renameWithLockHint(bakUnpackedTmp, ASAR_UNPACKED_DIR);
        unpackedSwapped = true;
      }
      renameWithLockHint(bakAsarTmp, ASAR_PATH);
      asarSwapped = true;
    } catch (e) {
      // 回退换装中途失败：尽力还原旧物
      try {
        if (!asarSwapped && xfs.existsSync(curAsarTmp) && !xfs.existsSync(ASAR_PATH)) xfs.renameSync(curAsarTmp, ASAR_PATH);
        if (unpackedSwapped) xfs.renameSync(ASAR_UNPACKED_DIR, bakUnpackedTmp);
        if (xfs.existsSync(curUnpackedTmp) && !xfs.existsSync(ASAR_UNPACKED_DIR)) xfs.renameSync(curUnpackedTmp, ASAR_UNPACKED_DIR);
      } catch {}
      throw e;
    }
    xfs.rmSync(curAsarTmp, { force: true });
    rmRecursive(curUnpackedTmp);
  } catch (e) {
    // 清理残留临时物
    try {
      xfs.rmSync(bakAsarTmp, { force: true });
      rmRecursive(bakUnpackedTmp);
    } catch {}
    throw e;
  }

  clearCompileCache();
  writeState({ lastAction: "rollback", previous: current, current: backupVersion });
  progress("cleanup", 90, "清理");
  emit({ type: "done", action: "rollback", from: current, to: backupVersion });
}

// ── 查询 ──

async function cmdCheck() {
  const current = await readCurrentVersion();
  let latest = null;
  try {
    latest = await fetchLatestVersion();
  } catch (e) {
    emit({ type: "state", current, latest: null, updateAvailable: false, checkError: String(e.message || e) });
    return;
  }
  const backups = listBackups();
  emit({
    type: "state",
    current,
    latest,
    updateAvailable: current !== latest,
    rollbackAvailable: backups.length > 0,
    rollbackVersion: backups[0] ? backupVersionOf(backups[0]) : null,
  });
}

// ── 入口 ──

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "update") args.shift(); // CLI wrapper 透传

  if (!xfs.existsSync(ASAR_PATH)) {
    fail(`找不到 gateway.asar: ${ASAR_PATH}`);
  }

  if (args.includes("--check")) {
    await cmdCheck();
    return;
  }

  acquireLock();
  try {
    if (args.includes("--rollback")) {
      await cmdRollback();
      return;
    }
    const tagIdx = args.indexOf("--tag");
    const tag = tagIdx >= 0 ? args[tagIdx + 1] : null;
    await cmdUpdate(tag);
  } finally {
    releaseLock();
  }
}

main().catch((e) => fail("内核升级失败", e));
