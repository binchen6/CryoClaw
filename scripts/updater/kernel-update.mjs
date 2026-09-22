#!/usr/bin/env node
/**
 * kernel-update.mjs — CryoClaw 内核（openclaw）运行时升级/回退
 *
 * 差分式 asar 换装：npm 安装新版 openclaw → 从旧 asar 搬入 CryoClaw 注入物
 * （skills、dist/extensions 下新包没有的插件目录）→ 重打共享补丁 → 冒烟 →
 * 重打 gateway.asar → 备份旧 asar → 换装 → 写状态文件。
 * 换装（rename 序列）前后落/清一份 journal，rename 被中断时下次启动据此把
 * gateway.asar 与 gateway.asar.unpacked 成套进位（避免「新 asar + 旧 unpacked」错配）。
 * 并发由 <backup>/update.lock 串行化（{pid,startedAt}，超时或持有者已退出即清理）。
 *
 * 运行环境：CryoClaw-CLI.exe / CryoClaw.exe + ELECTRON_RUN_AS_NODE=1（Node ≥22）。
 * 安装位置：<install>/resources/resources/updater/kernel-update.mjs，
 * 同级需有 kernel-dist-patch.js、kernel-channel.js、kernel-prune.js、rm-rec.js、
 * kernel-config-snapshot.js 与 node_modules/（含 @electron/asar）。
 *
 * 用法：
 *   kernel-update.mjs                 升级到策展稳定版（kernel-channel.json，见 kernel-channel.js 注释）
 *   kernel-update.mjs --tag <ver>     升级到指定版本（也可用于降级/装非策展版本）
 *   kernel-update.mjs --check         只查询当前/策展稳定版与回退可用性
 *   kernel-update.mjs --rollback      回退到最近一次备份
 *   （CLI wrapper 透传时首个参数可能是 "update"，会被忽略）
 *
 * 进度协议：stdout 每行一个 JSON 对象
 *   {"type":"progress","step":string,"pct":0-100,"msg":string}
 *   {"type":"state","current":string,"latest":string,"updateAvailable":boolean,"stableSource"?:string}
 *   （latest 字段语义 = 策展稳定版；updateAvailable 仅当 current 落后于它）
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
const { pruneGatewayTree } = createRequire(import.meta.url)("./kernel-prune.js")(xfs);

// 内核稳定版策展渠道（kernel-channel.js）：openclaw 官方 npm dist-tag latest 会指向
// 更新目标改为策展 stable：远程 kernel-channel.json → 内置兜底（构建期注入钉版本）。
const kch = createRequire(import.meta.url)("./kernel-channel.js");

// 内核备份附存 openclaw.json 配置快照（kernel-config-snapshot.js）
const kcs = createRequire(import.meta.url)("./kernel-config-snapshot.js");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = (process.env.CRYOCLAW_NPM_REGISTRY || "https://registry.npmmirror.com").replace(/\/+$/, "");
const KERNEL_PACKAGE = "openclaw";
const UNPACK_GLOB = "{**/*.node,**/*.exe,**/*.dll,**/*.dylib,**/*.so,**/spawn-helper}";
// extensions 整目录 unpack：2026.9.2+ fs-safe 公开构件身份校验要求真实文件身份
// （asar 虚拟路径的 lstat 返回伪造 dev/ino，见 R56）。目录级 unpack 必须走
// unpackDir（asar 库的 unpack 选项对复合 glob 内的目录段不可靠）。
const UNPACK_DIR_GLOB = "{node_modules/openclaw/dist/extensions,node_modules/@openclaw/fs-safe/dist/extensions}";
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

// Windows 直执的 npm-cli.js 路径（Electron AS_NODE 模式承载）
function resolveNpmCliJs() {
  return path.join(RESOURCES_DIR, "runtime", "node_modules", "npm", "bin", "npm-cli.js");
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
  // Windows：直执 npm-cli.js（ELECTRON_RUN_AS_NODE=1，argv 直传不经 shell）。
  // 此前的 cmd.exe /c npm.cmd 方案：Node 对含空格路径加引号后，cmd 的引号保留
  // 规则要求引号间无括号等特殊字符——安装到 C:\Program Files (x86)\ 这类路径
  // （安装器允许自选目录）会被按 C:\Program 截断，运行时升级必挂。
  // macOS/Linux：runtime/npm 是 shell wrapper，直执即可。
  const fullArgs = [...args, "--registry", REGISTRY];
  let cmd;
  let cmdArgs;
  if (process.platform === "win32") {
    cmd = resolveNodeExe();
    cmdArgs = [resolveNpmCliJs(), ...fullArgs];
  } else {
    cmd = resolveNpmBin();
    cmdArgs = fullArgs;
  }
  // openclaw ≥2026.8 的 preinstall 会用裸 `node` 校验版本（>=22.22.3 <23 ||
  // >=24.15.0 <25 || >=25.9.0），按 PATH 解析——用户机器上可能没有系统 Node，
  // 或版本不在范围内（都会直接拒装）。把捆绑 runtime 目录前置到 PATH，确保
  // 生命周期脚本里的 `node` 命中我们钉的 22.x 运行时。
  const env = { ...process.env };
  if (process.platform === "win32") {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
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

function fetchJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
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

// ── 稳定版策展渠道 ──
// 远程策展清单（CryoClaw 仓库 kernel-channel.json）→ 构建期注入的内置兜底。
// 双源按序尝试：jsDelivr 第一（国内可达性优于 raw，与 src/webbridge-pins.ts 的
// DEFAULT_PINS_URLS 同序），raw 兜底（raw 有分钟级 CDN 缓存，见 gotcha #102）。
// 每个源固定 CHANNEL_FETCH_TIMEOUT_MS：raw 放第一顺位时，国内不可达的用户每次
// 查询都要白等这个超时。两者都失败用内置兜底（= 本 app 打包时钉的内核版本，
// 随 app 发行更新），绝不回落 npm latest。
const CHANNEL_URLS = [
  "https://fastly.jsdelivr.net/gh/binchen6/CryoClaw@main/kernel-channel.json",
  "https://raw.githubusercontent.com/binchen6/CryoClaw/main/kernel-channel.json",
];
const CHANNEL_FETCH_TIMEOUT_MS = 8_000;

// 构建期占位符：package-resources.js 复制本脚本时替换为 package.json cryoclaw.openclaw 钉版本。
// dev 环境（未替换）回退读仓库 package.json。
const FALLBACK_STABLE_PLACEHOLDER = "__CRYOCLAW_FALLBACK_STABLE__";
function fallbackStableVersion() {
  if (kch.isValidKernelVersion(FALLBACK_STABLE_PLACEHOLDER)) return FALLBACK_STABLE_PLACEHOLDER;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "..", "..", "package.json"), "utf-8"));
    const v = pkg?.cryoclaw?.openclaw;
    if (kch.isValidKernelVersion(v)) return v;
  } catch {}
  return null;
}

// 返回 { version, minRuntimeNode?, source }；全部来源失败时抛错（调用方按"检查失败"处理，不提示更新）。
async function fetchStableVersion() {
  for (const url of CHANNEL_URLS) {
    try {
      const manifest = kch.parseChannelManifest(await fetchJson(url, CHANNEL_FETCH_TIMEOUT_MS));
      return { version: manifest.stable, minRuntimeNode: manifest.minRuntimeNode, source: url };
    } catch {
      // 换下一个来源
    }
  }
  const fb = fallbackStableVersion();
  if (fb) return { version: fb, source: "builtin-fallback" };
  throw new Error("无法确定内核稳定版（策展清单不可达且无内置兜底）");
}

// 运行时门槛守卫：openclaw 2026.9.x 起 engines 收敛到 Node 24，旧捆绑运行时
// （Node 22）的 App 装它会死在 npm preinstall——此处按清单 minRuntimeNode 提前
// 快速失败并给出「先升级应用」的明确文案。本脚本由捆绑运行时 node 直接 spawn，
// process.version 即捆绑运行时版本。版本不可判定时放行（preinstall 是最终兜底）。
function assertRuntimeSatisfies(minRuntimeNode, target) {
  if (!minRuntimeNode) return;
  const satisfied = kch.nodeVersionAtLeast(process.version, minRuntimeNode);
  if (satisfied === false) {
    fail(
      `内核 ${target} 要求捆绑运行时 Node ≥ ${minRuntimeNode}，当前 ${process.version} 不满足；请先升级 CryoClaw 应用后再更新内核`,
    );
  }
}

// updateAvailable 判定：仅当 current 落后于策展 stable（三段数字比较，prerelease
// 后缀不参与）。current 更高（用户手动 --tag 装了更新版本）时不提示"更新"——
// 那不是更新，是降级。
function computeUpdateAvailable(current, stable) {
  const cmp = kch.compareKernelVersions(current, stable);
  return cmp !== null && cmp < 0;
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

// 锁文件内容 {pid, startedAt}（旧格式 = 纯 PID 文本，仍兼容）。仅凭 PID 判活会在
// Windows PID 复用下永久误判「锁忙」：持有者早已崩溃、其 PID 被无关进程复用，
// process.kill(pid, 0) 恒成功 → 每次升级都被拒，只能手动删锁文件。
// 超时兜底：startedAt 早于 LOCK_STALE_MS 即判死锁并清理；取值与 src/kernel-updater.ts
// 的 UPDATOR_OVERALL_TIMEOUT_MS（updater 子进程整体看门狗，同样 15 分钟）一致——
// 超过它，持有者一定已被看门狗杀掉，锁不可能是活的。
const LOCK_STALE_MS = 15 * 60_000;

function isPidAlive(pid) {
  try {
    process.kill(pid, 0); // 不抛错即存活
    return true;
  } catch (e) {
    return !e || e.code !== "ESRCH"; // EPERM 等也视为存活
  }
}

// 锁判定（纯函数，便于单测）：raw = 锁文件内容（null = 读不到）。
// 返回 { held, pid, reason }；held=false 时调用方清理并按需重新落锁。
// reason: empty/unreadable（无有效信息）/ expired（startedAt 超时）/ dead（PID 已退出）/ alive。
export function evaluateLock(raw, nowMs = Date.now(), alive = isPidAlive, staleMs = LOCK_STALE_MS) {
  if (raw == null || raw.trim() === "") return { held: false, pid: null, reason: "empty" };
  const text = raw.trim();
  let pid;
  let startedAt = null;
  if (text.startsWith("{")) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return { held: false, pid: null, reason: "unreadable" };
    }
    if (!obj || typeof obj !== "object") return { held: false, pid: null, reason: "unreadable" };
    pid = Number(obj.pid);
    startedAt = Number(obj.startedAt);
  } else {
    pid = Number(text); // 旧格式：纯 PID，无 startedAt → 只按 PID 判定（向后兼容）
  }
  if (!Number.isFinite(pid) || pid <= 0) return { held: false, pid: null, reason: "unreadable" };
  // 超时优先于判活：PID 存活也可能是复用（这正是本判定的目的）
  if (Number.isFinite(startedAt) && nowMs - startedAt > staleMs) {
    return { held: false, pid, reason: "expired" };
  }
  return alive(pid) ? { held: true, pid, reason: "alive" } : { held: false, pid, reason: "dead" };
}

function acquireLock() {
  xfs.mkdirSync(BACKUP_ROOT, { recursive: true });
  if (xfs.existsSync(LOCK_FILE)) {
    let raw = null;
    try {
      raw = xfs.readFileSync(LOCK_FILE, "utf-8");
    } catch {}
    const verdict = evaluateLock(raw);
    if (verdict.held) fail("已有内核升级任务在进行中");
    try {
      xfs.rmSync(LOCK_FILE, { force: true }); // stale lock，清理
    } catch {}
    if (verdict.reason === "expired") {
      progress(
        "lock",
        1,
        `清理过期的内核升级锁（PID ${verdict.pid}，已超过 ${Math.round(LOCK_STALE_MS / 60_000)} 分钟）`
      );
    }
  }
  // "wx" 独占创建：existsSync→writeFileSync 之间存在 TOCTOU 窗口，两个并发
  // 更新器可能同时通过检查并交错换装；EEXIST 即对手方抢先落锁
  try {
    const fd = xfs.openSync(LOCK_FILE, "wx");
    xfs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
    xfs.closeSync(fd);
  } catch (e) {
    if (e && e.code === "EEXIST") fail("已有内核升级任务在进行中");
    throw e;
  }
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
  // 临时文件 + rename 原子写：崩溃半写的 state.json 会丢 previous/backupDir
  // 历史（下次读虽自愈为 {}，但事后排查与回滚提示会失真）
  const payload = JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2);
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  xfs.writeFileSync(tmp, payload, "utf-8");
  try {
    xfs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    xfs.rmSync(tmp, { force: true });
    throw e;
  }
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
  const stable = tag ? null : await fetchStableVersion();
  const target = tag || stable.version;
  if (!validateKernelVersion(target)) {
    fail(`目标内核版本号格式非法: ${JSON.stringify(target)}`);
  }
  const updateAvailable = tag ? current !== target : computeUpdateAvailable(current, target);
  emit({
    type: "state",
    current,
    latest: target,
    updateAvailable,
    ...(stable ? { stableSource: stable.source } : {}),
  });

  // 无显式 --tag 且当前版本不落后于策展 stable：无需换装（含 current 更高的情形——
  // 用户手动装过更新版本时，无 tag 升级绝不能暗降级）。
  if (!tag && !updateAvailable) {
    progress("done", 100, `当前内核 ${current} 已不落后于策展稳定版 ${target}`);
    emit({ type: "done", action: "update", from: current, to: current });
    return;
  }

  // 确认要换装了才做运行时门槛判定：无需更新的早退路径不受门槛影响；
  // 显式 --tag 无清单可依，不做此判定（npm preinstall 引擎校验兜底）。
  assertRuntimeSatisfies(stable?.minRuntimeNode, target);

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
    kdp.patchAsarBoundaryCheck(stagingGateway);
    // 形态感知覆盖断言（R56：v9 函数迁到 @openclaw/fs-safe 包后补丁计数会
    // 误导——仅 peer-link 命中也 >0。按内核形态校验关键文件确已带补丁）
    kdp.assertAsarBoundaryCoverage(stagingGateway);
    // fs-safe pinned-open asar→unpacked 映射（2026.9.2+ 身份校验需要真实文件身份；
    // 旧内核无此文件形态时未命中属预期，不告警）
    const fsSafePatched = kdp.patchFsSafeAsarUnpacked(stagingGateway);
    progress("patch", 46, `fs-safe asar→unpacked 补丁: ${fsSafePatched > 0 ? "已注入" : "未命中（跳过）"}`);
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
    await a.createPackageWithOptions(stagingGateway, newAsar, { unpack: UNPACK_GLOB, unpackDir: UNPACK_DIR_GLOB });
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
    // 同目录附存 openclaw.json 快照：回退不自动恢复配置（避免覆盖用户新配置），
    // 但回退完成时会提示快照位置，便于手动核对。失败仅告警，不阻断升级。
    try {
      if (kcs.snapshotOpenclawConfig(backupDir)) {
        progress("backup", 81, "已附存 openclaw.json 配置快照");
      }
    } catch (e) {
      progress("backup", 81, `openclaw.json 配置快照附存失败（不阻断升级）: ${e.message || e}`);
    }

    progress("swap", 88, "换装新内核");
    // 同卷临时名 + rename 进位：先复制新物到 RESOURCES_DIR 下临时名，再依次 rename
    // 旧物 → .old-<ts>、新物 → 正式名，任何一步失败都不会留下残缺的正式名文件。
    // rename 序列本身不是原子的：换装前先落 journal（原子写）记录目标版本/时间戳/进度，
    // 崩溃后由 reconcileSwapDebris 按它把 asar 与 unpacked 成套进位（见 planSwapRecovery）。
    const ts = Date.now();
    const newAsarTmp = `${ASAR_PATH}.new-${ts}`;
    const oldAsarTmp = `${ASAR_PATH}.old-${ts}`;
    const newUnpackedTmp = `${ASAR_UNPACKED_DIR}.new-${ts}`;
    const oldUnpackedTmp = `${ASAR_UNPACKED_DIR}.old-${ts}`;
    xfs.copyFileSync(newAsar, newAsarTmp);
    let unpackedStaged = false;
    // targetVersion 取自上面已校验的新 asar 内 openclaw/package.json（== target）；
    // journal 只作诊断记录——自愈时无法同步读取正式 asar 内的版本（asar 需要异步
    // 解包库），成对判定因此走 ts/step/成套标志（见 planSwapRecovery 注释）。
    const journal = {
      targetVersion: packedVersion,
      fromVersion: current,
      ts,
      step: 0,
      stagedUnpacked: false,
      hadOldUnpacked: xfs.existsSync(ASAR_UNPACKED_DIR),
      timestamp: new Date().toISOString(),
    };
    try {
      if (xfs.existsSync(packedUnpacked)) {
        xfs.cpSync(packedUnpacked, newUnpackedTmp, { recursive: true });
        unpackedStaged = true;
      }
      journal.stagedUnpacked = unpackedStaged;
      // 严格写：journal 落不下就中止换装（此时正式名还没被动过，中止比盲换安全）
      writeSwapJournal(ASAR_PATH, journal, true);
      let asarSwapped = false;
      let unpackedSwapped = false;
      try {
        // rename 序列（每完成一步更新 journal.step）；整段都在还原逻辑覆盖范围内，
        // 含 step 写失败——否则「旧 asar 已挪走 + 正式名缺失」会停在残缺状态
        renameWithLockHint(ASAR_PATH, oldAsarTmp);
        journal.step = 1;
        writeSwapJournal(ASAR_PATH, journal, true);
        if (xfs.existsSync(ASAR_UNPACKED_DIR)) renameWithLockHint(ASAR_UNPACKED_DIR, oldUnpackedTmp);
        journal.step = 2;
        writeSwapJournal(ASAR_PATH, journal, true);
        if (unpackedStaged) {
          renameWithLockHint(newUnpackedTmp, ASAR_UNPACKED_DIR);
          unpackedSwapped = true;
        }
        journal.step = 3;
        writeSwapJournal(ASAR_PATH, journal, true);
        renameWithLockHint(newAsarTmp, ASAR_PATH);
        asarSwapped = true;
      } catch (e) {
        // 换装中途失败：尽力按原样还原（rename 顺序倒着来）
        let restored = true;
        try {
          if (!asarSwapped && xfs.existsSync(oldAsarTmp) && !xfs.existsSync(ASAR_PATH)) xfs.renameSync(oldAsarTmp, ASAR_PATH);
          if (unpackedSwapped) xfs.renameSync(ASAR_UNPACKED_DIR, newUnpackedTmp);
          if (xfs.existsSync(oldUnpackedTmp) && !xfs.existsSync(ASAR_UNPACKED_DIR)) xfs.renameSync(oldUnpackedTmp, ASAR_UNPACKED_DIR);
        } catch {
          restored = false;
        }
        // 还原干净才清 journal：正式名没回到成套状态时留下 journal，由下次自愈
        // 按 ts/step 成对修复——否则可能留下「新 asar + 旧 unpacked」错配无人收场
        if (restored) clearSwapJournal(ASAR_PATH);
        throw e;
      }
      journal.step = 4;
      writeSwapJournal(ASAR_PATH, journal); // 换装已完成：写失败仅让 journal 落后一步（成对判定已覆盖）
      clearSwapJournal(ASAR_PATH);
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
  // 备份里若带 openclaw.json 快照，提示位置；刻意不自动恢复，避免覆盖用户新配置
  const configSnapshot = path.join(backupDir, "openclaw.json");
  if (xfs.existsSync(configSnapshot)) {
    progress("cleanup", 92, `备份含配置快照（未自动恢复，需要时请手动核对）: ${configSnapshot}`);
  }
  emit({ type: "done", action: "rollback", from: current, to: backupVersion });
}

// ── 查询 ──

async function cmdCheck() {
  const current = await readCurrentVersion();
  let stable = null;
  try {
    stable = await fetchStableVersion();
  } catch (e) {
    emit({ type: "state", current, latest: null, updateAvailable: false, checkError: String(e.message || e) });
    return;
  }
  const backups = listBackups();
  emit({
    type: "state",
    current,
    latest: stable.version,
    updateAvailable: computeUpdateAvailable(current, stable.version),
    stableSource: stable.source,
    rollbackAvailable: backups.length > 0,
    rollbackVersion: backups[0] ? backupVersionOf(backups[0]) : null,
  });
}

// ── 入口 ──

// ── 换装残留自愈 ──
// 崩溃/断电可能落在 rename 序列中间：gateway.asar 被挪去 .old-<ts> 而 .new-<ts>
// 尚未进位（此时 asar 缺失、.new 完整——copyFileSync 完成后才会开始 rename）；
// 或换装成功但清理未跑完（asar 健康 + .old-/.new- 残留，每份 100-200MB）；
// 或回退（cmdRollback）中途崩溃留下 .rbk-<ts>（旧核挪走后未清理/未还原）。
// 有 journal（换装中断）时按 journal 成对恢复，优先整套新版、其次整套旧版；
// 无 journal 的旧残留走下方原有逻辑。
// 必须在持有锁时调用（并发更新器换装中途的临时物是合法存在的，不能误删）。
// asarPath/unpackedDir 可注入（node:test 用临时目录；缺省 = 运行时安装位）。
function listTsResidue(prefix) {
  const parent = path.dirname(prefix);
  const stem = path.basename(prefix);
  let names;
  try {
    names = xfs.readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(stem))
    .sort()
    .map((n) => path.join(parent, n));
}

// ── 换装 journal（rename 序列中断的成对自愈依据）──
// rename 序列不是原子的：崩溃落在「①旧 asar 挪走、②旧 unpacked 挪走」之间时，
// 正式名上只剩旧 unpacked，而 .new-<ts> 里躺着整套新版——只按「正式名是否存在」
// 判断，会把 .new- 里的新 asar 单独进位，拼出「新 asar + 旧 unpacked」混版
// （asar 内的 JS 与 unpacked 里的原生模块/扩展版本不一致，gateway 起不来）。
// swap 前原子落一份 journal（目标版本、ts、step、成套标志），rename 每完成一步更新
// step，全部完成后删除；下次启动自愈按它把 asar 与 unpacked 成套进位。
function swapJournalPath(asarPath) {
  return `${asarPath}.swap-journal.json`;
}

// strict=false 仅用于「换装已完成」的最后一次写（失败只让 journal 落后一步，
// 成对判定已覆盖）；其余写入失败必须中止换装——没有 journal 就失去了成对自愈依据。
// 导出便于单测（与 reconcileSwapDebris 同约定）：换装 journal 的写侧从未被单测
// 覆盖时，写/读路径一旦漂移（文件名或字段名不一致）整个自愈会静默失效。
export function writeSwapJournal(asarPath, journal, strict = false) {
  const file = swapJournalPath(asarPath);
  const tmp = `${file}.tmp`;
  try {
    xfs.writeFileSync(tmp, JSON.stringify(journal, null, 2), "utf-8");
    xfs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try {
      xfs.rmSync(tmp, { force: true });
    } catch {}
    if (strict) throw e;
    return false;
  }
}

function clearSwapJournal(asarPath) {
  try {
    xfs.rmSync(swapJournalPath(asarPath), { force: true });
  } catch {}
}

// 内容不合法（被截断/非本格式/字段越界）时返回 null：退回无 journal 的旧逻辑，
// 不去猜——猜错比慢一步更糟。
export function readSwapJournal(asarPath) {
  let j;
  try {
    j = JSON.parse(xfs.readFileSync(swapJournalPath(asarPath), "utf-8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const ts = Number(j.ts);
  const step = Number(j.step);
  if (!Number.isInteger(ts) || ts <= 0 || !Number.isInteger(step) || step < 0 || step > 4) return null;
  return {
    targetVersion: typeof j.targetVersion === "string" ? j.targetVersion : null,
    ts,
    step,
    stagedUnpacked: j.stagedUnpacked === true,
    hadOldUnpacked: j.hadOldUnpacked === true,
  };
}

/**
 * 换装中断后的成对恢复判定（纯函数：不做任何 fs 访问，输入是 journal + 在位事实表）。
 * 角色：asar / unpacked = 正式名；newAsar / newUnpacked = 本次换装的 `.new-<ts>`
 * （新内核）；oldAsar / oldUnpacked = 本次换装的 `.old-<ts>`（旧内核）。
 * 返回 { action, moves }：
 *   action = "settled"（已成对，无需动作）| "rollforward"（整套新版进位）|
 *            "rollback"（整套旧版还原）| "unpaired"（两边都不成套，交给上层报错）
 *   moves = [{ from, to }]：有序的符号化 rename 动作（先腾位、后进位）。
 *
 * 判定依据：`.new-` 残留消失只可能来自「被 rename 进位」（换装失败路径会连同 journal
 * 一起清掉，走不到这里），所以「正式名在位 + 对应 `.new-` 残留消失」即该件已是新版；
 * journal.step 作为下界守卫（rename 有先后：unpacked 进位必在 step≥2、asar 进位必在
 * step≥3），step 只会滞后于磁盘最多一步（每步 rename 后都写 journal，写失败即中止换装），
 * 滞后一步时上述下界仍成立，故不会把「已挪回的旧件」误判成新版。
 * journal.targetVersion 只作诊断：自愈处无法同步读取正式 asar 内的版本（asar 需要异步
 * 解包库），因此成对判定不依赖版本号，而依赖本次换装的 ts/step/成套标志。
 */
export function planSwapRecovery(state) {
  const step = state.step ?? 0;
  const stagedUnpacked = state.stagedUnpacked === true;
  const hadOldUnpacked = state.hadOldUnpacked === true;
  const formalAsar = state.formalAsar === true;
  const formalUnpacked = state.formalUnpacked === true;
  const hasNewAsar = state.newAsar === true;
  const hasNewUnpacked = state.newUnpacked === true;
  const hasOldAsar = state.oldAsar === true;
  const hasOldUnpacked = state.oldUnpacked === true;

  const newAsarInPlace = formalAsar && !hasNewAsar && step >= 3;
  const newUnpackedInPlace = stagedUnpacked && formalUnpacked && !hasNewUnpacked && step >= 2;
  const formalAsarIsOld = formalAsar && !newAsarInPlace;
  const formalUnpackedIsOld = formalUnpacked && !newUnpackedInPlace;

  // 新版已整套在位：换装其实已完成（崩溃点落在「进位完成 → 清 journal」之间）
  if (newAsarInPlace && (!stagedUnpacked || newUnpackedInPlace)) {
    return { action: "settled", moves: [] };
  }
  // 新版能凑齐一整套 → 进位（先腾开旧件占用的正式名，再按 unpacked → asar 的顺序进位）
  const newAsarOk = newAsarInPlace || hasNewAsar;
  const newUnpackedOk = !stagedUnpacked || newUnpackedInPlace || hasNewUnpacked;
  if (newAsarOk && newUnpackedOk) {
    const moves = [];
    if (formalAsar && !newAsarInPlace) moves.push({ from: "asar", to: "oldAsar" });
    if (stagedUnpacked && formalUnpacked && !newUnpackedInPlace) moves.push({ from: "unpacked", to: "oldUnpacked" });
    if (stagedUnpacked && !newUnpackedInPlace) moves.push({ from: "newUnpacked", to: "unpacked" });
    if (!newAsarInPlace) moves.push({ from: "newAsar", to: "asar" });
    return { action: "rollforward", moves };
  }
  // 新版凑不齐 → 退整套旧版（只在旧版真的成套时才动）
  const oldAsarOk = formalAsarIsOld || hasOldAsar;
  const oldUnpackedOk = !hadOldUnpacked || formalUnpackedIsOld || hasOldUnpacked;
  if (oldAsarOk && oldUnpackedOk) {
    const moves = [];
    if (hadOldUnpacked && !formalUnpackedIsOld && hasOldUnpacked) {
      if (formalUnpacked) moves.push({ from: "unpacked", to: "newUnpacked" });
      moves.push({ from: "oldUnpacked", to: "unpacked" });
    }
    if (!formalAsarIsOld && hasOldAsar) {
      if (formalAsar) moves.push({ from: "asar", to: "newAsar" });
      moves.push({ from: "oldAsar", to: "asar" });
    }
    return moves.length === 0 ? { action: "settled", moves: [] } : { action: "rollback", moves };
  }
  // 两边都不成套：不动任何正式名（上层按「找不到 gateway.asar」响亮报错）
  return { action: "unpaired", moves: [] };
}

// journal 分支的执行器：把符号化动作用本次换装的 ts 落到具体路径上。
// 任何一步前置条件不满足（源不存在 / 目标已被占）即整体放弃——半途动过正式名的
// 现场会由下次自愈按同一 journal 重算（判定纯由磁盘状态推出，可重入）。
function recoverSwapFromJournal(journal, asarPath, unpackedDir, log) {
  const ts = journal.ts;
  const p = {
    asar: asarPath,
    unpacked: unpackedDir,
    newAsar: `${asarPath}.new-${ts}`,
    oldAsar: `${asarPath}.old-${ts}`,
    newUnpacked: `${unpackedDir}.new-${ts}`,
    oldUnpacked: `${unpackedDir}.old-${ts}`,
  };
  const plan = planSwapRecovery({
    step: journal.step,
    stagedUnpacked: journal.stagedUnpacked,
    hadOldUnpacked: journal.hadOldUnpacked,
    formalAsar: xfs.existsSync(p.asar),
    formalUnpacked: xfs.existsSync(p.unpacked),
    newAsar: xfs.existsSync(p.newAsar),
    newUnpacked: xfs.existsSync(p.newUnpacked),
    oldAsar: xfs.existsSync(p.oldAsar),
    oldUnpacked: xfs.existsSync(p.oldUnpacked),
  });
  log(
    `检测到中断的换装 journal（目标 ${journal.targetVersion || "未知"}，step=${journal.step}）：成对恢复判定 ${plan.action}`
  );
  if (plan.action !== "rollforward" && plan.action !== "rollback") return plan.action;
  for (const mv of plan.moves) {
    const from = p[mv.from];
    const to = p[mv.to];
    if (!xfs.existsSync(from) || xfs.existsSync(to)) {
      log(`换装成对恢复中断：${path.basename(from)} → ${path.basename(to)} 前置条件不满足，放弃本次恢复`);
      return "aborted";
    }
    xfs.renameSync(from, to);
    log(`换装成对恢复：${path.basename(from)} → ${path.basename(to)}`);
  }
  return plan.action;
}

export function reconcileSwapDebris(log, asarPath = ASAR_PATH, unpackedDir = ASAR_UNPACKED_DIR) {
  // ⓪ 上一次换装留下的 journal（rename 中途崩溃）→ 按它成对进位（优先整套新版）
  const journal = readSwapJournal(asarPath);
  if (journal) {
    const outcome = recoverSwapFromJournal(journal, asarPath, unpackedDir, log);
    if (outcome === "aborted" || outcome === "unpaired") {
      // 现场不成套：不删 journal、不清理残留，留给人工排查（上层会按缺少 asar 报错）
      log("换装中断现场未能成对恢复，保留 journal 与残留待人工处理");
      return;
    }
    clearSwapJournal(asarPath);
  }
  // ① asar 缺失但 .new-* 已完整落盘 → roll forward（取最新一份）
  if (!xfs.existsSync(asarPath)) {
    const staged = listTsResidue(`${asarPath}.new-`);
    if (staged.length > 0) {
      const candidate = staged[staged.length - 1];
      // 完整性下限启发式：asar 正品 >100MB；rename 窗口里的 .new 一定是 copy 完成的
      if (xfs.statSync(candidate).size > 100 * 1024 * 1024) {
        xfs.renameSync(candidate, asarPath);
        log(`已将崩溃残留的 ${path.basename(candidate)} 进位为 gateway.asar`);
      }
    }
    // asar 缺失且 .old-* 存在（roll forward 不可能时）→ 还原旧版，保住可启动
    if (!xfs.existsSync(asarPath)) {
      const olds = listTsResidue(`${asarPath}.old-`);
      if (olds.length > 0) {
        xfs.renameSync(olds[olds.length - 1], asarPath);
        log(`已将崩溃残留的 ${path.basename(olds[olds.length - 1])} 还原为 gateway.asar（旧版）`);
      }
    }
    // asar 仍缺失且有 .rbk-*（cmdRollback 把旧核挪去 .rbk-<ts> 后崩溃）：成对才
    // 还原——unpacked 正式物在位时换装进行到哪一步已不可判定，单边进位可能拼出
    // 「旧 asar + 新 unpacked」混版；不成对则不动，走下方清理（由上层 fail 响亮报错）。
    if (!xfs.existsSync(asarPath)) {
      const rbkAsar = listTsResidue(`${asarPath}.rbk-`);
      if (rbkAsar.length > 0 && !xfs.existsSync(unpackedDir)) {
        const rbkUnp = listTsResidue(`${unpackedDir}.rbk-`);
        xfs.renameSync(rbkAsar[rbkAsar.length - 1], asarPath);
        log(`已将崩溃残留的 ${path.basename(rbkAsar[rbkAsar.length - 1])} 还原为 gateway.asar（回退副本）`);
        // unpacked .rbk 同代进位；该安装本就没有 unpacked（无 .rbk 残留）时单边还原即完整
        if (rbkUnp.length > 0) {
          xfs.renameSync(rbkUnp[rbkUnp.length - 1], unpackedDir);
          log(`已恢复 gateway.asar.unpacked（来自 ${path.basename(rbkUnp[rbkUnp.length - 1])}）`);
        }
      }
    }
    // unpacked 同理：缺失时优先 .new-，兜底 .old-
    if (!xfs.existsSync(unpackedDir)) {
      for (const prefix of [`${unpackedDir}.new-`, `${unpackedDir}.old-`]) {
        const cand = listTsResidue(prefix);
        if (cand.length > 0) {
          xfs.renameSync(cand[cand.length - 1], unpackedDir);
          log(`已恢复 gateway.asar.unpacked（来自 ${path.basename(cand[cand.length - 1])}）`);
          break;
        }
      }
    }
  }
  // ② 正式物健康时清掉全部换装临时残留（成功路径的正常收尾本会删它们）
  for (const prefix of [
    `${asarPath}.new-`,
    `${asarPath}.old-`,
    `${asarPath}.rbk-`,
    `${unpackedDir}.new-`,
    `${unpackedDir}.old-`,
    `${unpackedDir}.rbk-`,
  ]) {
    for (const p of listTsResidue(prefix)) {
      try {
        if (xfs.statSync(p).isDirectory()) rmRecursive(p);
        else xfs.rmSync(p, { force: true });
        log(`已清理换装残留 ${path.basename(p)}`);
      } catch {}
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "update") args.shift(); // CLI wrapper 透传

  if (args.includes("--check")) {
    // 无锁态的尽力自愈（有并发更新在跑时跳过——其临时物是合法的）
    if (!xfs.existsSync(LOCK_FILE)) {
      try {
        reconcileSwapDebris((m) => console.log(`[kernel-update] ${m}`));
      } catch (e) {
        console.log(`[kernel-update] 残留自愈跳过: ${e.message || e}`);
      }
    }
    await cmdCheck();
    return;
  }

  acquireLock();
  try {
    reconcileSwapDebris((m) => console.log(`[kernel-update] ${m}`));
    if (!xfs.existsSync(ASAR_PATH)) {
      fail(`找不到 gateway.asar: ${ASAR_PATH}`);
    }
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

// ── 入口（被 import 时不执行；node:test 直接 import 本模块测 reconcileSwapDebris）──

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
const isMain =
  invokedPath &&
  (process.platform === "win32"
    ? invokedPath.toLowerCase() === selfPath.toLowerCase()
    : invokedPath === selfPath);

if (isMain) {
  main().catch((e) => fail("内核升级失败", e));
}
