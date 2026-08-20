#!/usr/bin/env node
"use strict";
/**
 * dist-win.js — 一键构建 + 打包 Windows 安装包（跨 shell：PowerShell / cmd / bash）。
 *
 * 用法：
 *   node scripts/dist-win.js               # 默认 x64
 *   node scripts/dist-win.js --arch arm64  # ARM64
 *
 * 串联：npm run build → package:resources → electron-builder，
 * 并注入 .env.build / .env 与镜像/网络环境变量（与 run-with-env.js 同源逻辑）。
 * 任一步失败立即终止（非零退出码），避免半成品安装包。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const archIdx = args.indexOf("--arch");
const arch = archIdx >= 0 ? (args[archIdx + 1] || "x64") : "x64";
if (arch !== "x64" && arch !== "arm64") {
  console.error(`[dist-win] 不支持的架构: ${arch}（仅 x64 / arm64）`);
  process.exit(2);
}
const target = `win32-${arch}`;

// 读取 .env（支持值含空格/括号，与 run-with-env.js 一致）
function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = rawLine.indexOf("=");
    if (idx <= 0) continue;
    const key = rawLine.slice(0, idx).trim();
    let value = rawLine.slice(idx + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function run(cmd, cmdArgs, envOverrides = {}) {
  // 优先级（低 → 高）：.env.build < .env < shell exported < envOverrides（与 run-with-env.js 一致）
  const env = {
    ...loadEnvFile(path.join(root, ".env.build")),
    ...loadEnvFile(path.join(root, ".env")),
    ...process.env,
    ...envOverrides,
  };
  // Windows 下 npm/npx 是 .cmd 包装，必须经 shell 执行
  const shell = process.platform === "win32";
  const r = spawnSync(cmd, cmdArgs, { cwd: root, env, stdio: "inherit", shell });
  if (r.status !== 0) {
    console.error(`[dist-win] 命令失败: ${cmd} ${cmdArgs.join(" ")}（exit=${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

const commonEnv = {
  CRYOCLAW_TARGET: target,
  NODE_OPTIONS: "--use-system-ca",
  ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

console.log(`[dist-win] 开始: target=${target}`);
console.log("[dist-win] Step 1/3: npm run build");
run("npm", ["run", "build"], commonEnv);

console.log("[dist-win] Step 2/3: package:resources");
run("npm", ["run", "package:resources", "--", "--platform", "win32", "--arch", arch], commonEnv);

console.log("[dist-win] Step 3/3: electron-builder");
run("npx", [
  "electron-builder",
  "--win",
  `--${arch}`,
  `--config.directories.output=out/${target}`,
  "--publish",
  "never",
], commonEnv);

// ── 产物校验（只告警不 fail）──

// 解析 PE 头 Certificate Table（Optional Header DataDirectory[4]，IMAGE_DIRECTORY_ENTRY_SECURITY）：
// offset 与 size 均非 0 即存在 Authenticode 数字签名。不引入新依赖。
function isExeSigned(filePath) {
  const buf = fs.readFileSync(filePath);
  // DOS header: "MZ" + e_lfanew（0x3c 处指向 PE 头的偏移）
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return false;
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length) return false;
  // PE signature "PE\0\0"，之后 20 字节 COFF File Header，再是 Optional Header
  if (buf.readUInt32LE(peOffset) !== 0x00004550) return false;
  const optOffset = peOffset + 24;
  if (optOffset + 2 > buf.length) return false;
  const magic = buf.readUInt16LE(optOffset);
  // PE32 (0x10b): DataDirectory 起始于 Optional Header +96；PE32+ (0x20b): +112
  const ddOffset = magic === 0x10b ? optOffset + 96 : magic === 0x20b ? optOffset + 112 : 0;
  if (!ddOffset || ddOffset + 5 * 8 > buf.length) return false;
  const certOffset = buf.readUInt32LE(ddOffset + 4 * 8);
  const certSize = buf.readUInt32LE(ddOffset + 4 * 8 + 4);
  return certOffset !== 0 && certSize !== 0;
}

const outDir = path.join(root, "out", target);
const setups = fs.existsSync(outDir)
  ? fs.readdirSync(outDir).filter((f) => /^CryoClaw-Setup-.*\.exe$/i.test(f))
  : [];
if (setups.length === 0) {
  console.warn(`\n[dist-win] ⚠ 未找到安装包产物 out/${target}/CryoClaw-Setup-*.exe`);
}
for (const name of setups) {
  const exePath = path.join(outDir, name);
  let signed = false;
  try {
    signed = isExeSigned(exePath);
  } catch (err) {
    console.warn(`\n[dist-win] ⚠ 签名检测失败(${name}): ${err?.message ?? err}`);
  }
  if (!signed) {
    // 不 fail：未配置 CSC_LINK 证书时产物未签名是合法场景，仅醒目提示
    console.warn(`
┌──────────────────────────────────────────────────────────────────┐
│ ⚠  ${name} 未包含数字签名
│   未配置 CSC_LINK 代码签名证书。用户首次安装会看到
│   Windows SmartScreen「未知发布者」警告。正式发布前请配置
│   CSC_LINK / CSC_KEY_PASSWORD（见 .env.build.example）。
└──────────────────────────────────────────────────────────────────┘`);
  } else {
    console.log(`[dist-win] 签名校验通过: ${name}`);
  }
  // 差分更新（electron-updater）依赖同批的 blockmap 与 latest.yml
  if (!fs.existsSync(`${exePath}.blockmap`)) {
    console.warn(`[dist-win] ⚠ 缺少 ${name}.blockmap，差分增量更新将退化为全量下载`);
  }
}
if (!fs.existsSync(path.join(outDir, "latest.yml"))) {
  console.warn(`[dist-win] ⚠ 缺少 out/${target}/latest.yml，electron-updater 将无法检查更新`);
}

console.log(`[dist-win] 完成: out/${target}/CryoClaw-Setup-*`);
