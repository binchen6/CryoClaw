// 内核 dist 补丁共享模块 — 打包期（package-resources.js）与运行时内核升级
// （resources/updater/kernel-update.js）共用，保证补丁逻辑单一来源。
// 零依赖（仅 fs/path），可在仓库 node 与安装产物 CryoClaw-CLI.exe (ELECTRON_RUN_AS_NODE) 下运行。
//
// 本模块函数抛出 Error 代替 package-resources.js 的 die()，日志由调用方负责。

const fs = require("fs");
const path = require("path");

// ─── windowsHide 注入 ───

// Windows 上给 openclaw 所有 spawn 调用统一补 windowsHide，避免黑框闪烁。
// 采用全局扫描策略，不再逐文件 whack-a-mole，确保上游新增 spawn 调用自动被覆盖。
// 返回 { scanned, patched }；非 win32 平台返回 null。
function patchWindowsOpenclawArtifacts(gatewayDir, platform = "win32") {
  if (platform !== "win32") return null;

  // 收集所有需要扫描的 JS 目录
  const scanDirs = [];

  // openclaw 核心 dist
  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(`openclaw dist 目录不存在，无法应用 Windows 补丁: ${distDir}`);
  }
  scanDirs.push(distDir);

  let totalFiles = 0;
  let totalPatched = 0;

  for (const dir of scanDirs) {
    const result = patchWindowsHideGlobal(dir);
    totalFiles += result.scanned;
    totalPatched += result.patched;
  }

  return { scanned: totalFiles, patched: totalPatched };
}

// 全局扫描目录下所有 .js 文件，给缺失 windowsHide 的 spawn 调用注入补丁。
// 幂等：已有 windowsHide 的 spawn 不会重复注入。
function patchWindowsHideGlobal(dir) {
  const jsFiles = collectJsFilesRecursive(dir);
  let scanned = 0;
  let patched = 0;

  for (const filePath of jsFiles) {
    scanned += 1;
    const before = fs.readFileSync(filePath, "utf-8");
    const after = injectWindowsHideAll(before);
    if (after !== before) {
      fs.writeFileSync(filePath, after, "utf-8");
      patched += 1;
    }
  }

  return { scanned, patched };
}

// 递归收集目录下所有 .js 文件
function collectJsFilesRecursive(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

// 给源码中所有 spawn(..., { ... }) 调用注入 windowsHide: true。
// 策略：匹配 spawn options 对象的起始 `{` 后第一个属性，回看确认是 spawn 上下文，
// 前探确认同一 options 块内无 windowsHide 后注入。
function injectWindowsHideAll(source) {
  // 匹配 spawn options 对象的起始模式：
  //   ], { stdio  — 数组参数后的 options（killProcessTree, exec 等）
  //   ), { stdio  — 函数调用结果后的 options（slice(1) 等）
  //   var, { stdio — 变量参数后的 options（spawn(cmd, args, { stdio...）
  //   [], { cwd   — 空数组后的 options（terminal 类调用）
  return source.replace(
    /([)\]\w"']\s*,\s*\{)(\s*)(stdio|detached|cwd\b|env\s*[,:{])/g,
    (match, prefix, ws, keyword, offset) => {
      // 前探 600 字符：同一 options 块内已有 windowsHide 则跳过
      const lookahead = source.slice(offset, offset + 600);
      if (lookahead.includes("windowsHide")) return match;

      // 回看 500 字符：确认在 spawn( 调用上下文中，避免误伤非 spawn 的对象字面量
      const lookback = source.slice(Math.max(0, offset - 500), offset);
      if (!/spawn\s*\(/.test(lookback)) return match;

      return prefix + ws + "windowsHide: true," + ws + keyword;
    }
  );
}

// ─── ASAR 路径校验补丁（仅 asar 模式） ───
//
// openclaw 的 boundary-file-read 模块使用 O_NOFOLLOW + realpathSync + lstatSync
// 组合校验插件清单路径的安全性。在 Electron ASAR 模式下，这些 syscall 对 asar 虚拟
// 路径行为异常，导致所有 bundled 插件被判定为 "unsafe plugin manifest path"。
//
// 补丁策略：在边界校验入口函数开头注入一段 asar 路径快速通道——
// 如果文件路径穿越 .asar 归档，直接用 fs.openSync 打开并返回，跳过 realpathSync /
// O_NOFOLLOW / hardlink 检查。Electron 的 ASAR patch 已保证归档内文件的完整性和只读性，
// 无需额外校验。返回的 stat 必须用路径版 fs.statSync 而非 fs.fstatSync(fd)——
// asar 中 lstat/stat 返回伪造 ino、fstat 返回真实 ino，二者恒不相等；下游存在
// sameFileIdentity(opened.stat, fs.statSync(path)) 校验（如 public-surface-loader），
// 只有路径版 stat 才能与其自洽。
//
// 目标函数随内核版本演进（按函数标记匹配，不依赖含 hash 的文件名）：
//   openclaw 2026.4.x：boundary-file-read-*.js 的 openBoundaryFileSync / openVerifiedFileSync
//   openclaw ≥2026.6.x：逻辑迁移到 @openclaw/fs-safe 的 root-file-*.js，
//     入口变为 openRootFileSync / openRootFile（async），返回形状
//     { ok:true, path, fd, stat, rootRealPath } 保持一致。
//   另需补丁 @openclaw/fs-safe 的 regular-file-*.js（verifyStableReadTarget）与
//     pinned-open-*.js（openPinnedFileSync）：asar 中 lstat 返回伪造 ino、fstat 返回
//     真实 ino，sameFileIdentity 校验恒失败，导致 asar 内 package.json 读取静默为 null。
//   file-identity-*.js（sameFileIdentity）：asar 中每次 stat 的 ino 是递增计数器、
//     dev 恒为 1，路径 stat 两两比对（如 public-surface-loader 的二次校验）也会误判。
//
// 返回补丁的文件数；0 表示上游结构不匹配（调用方应视为失败）。

function patchAsarBoundaryCheck(gatewayDir) {
  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) return 0;

  // 扫描 dist 根下所有 .js chunk，按函数标记注入（hash 文件名随版本变化）
  const candidateFiles = fs.readdirSync(distDir).filter((f) => f.endsWith(".js"));
  if (candidateFiles.length === 0) {
    return 0;
  }

  let patched = 0;
  for (const fileName of candidateFiles) {
    const filePath = path.join(distDir, fileName);
    const source = fs.readFileSync(filePath, "utf-8");

    // 已打过补丁（幂等）。不能只认 `/* asar-bypass */`：verified/async 变体出现在
    // 不含基础 marker 的独立 chunk 时，重跑会对同一函数再注入一个 bypass 块。
    if (
      source.includes("/* asar-bypass */") ||
      source.includes("/* asar-bypass-verified */") ||
      source.includes("/* asar-bypass-async */")
    ) {
      continue;
    }

    let result = source;

    // 补丁 1: openBoundaryFileSync — 插件清单加载的入口函数
    // 在 resolveBoundaryPathSync 之前拦截，避免 ASAR 虚拟路径触发 realpath/lstat 校验失败
    const boundaryMarker = "function openBoundaryFileSync(params) {";
    if (result.includes(boundaryMarker)) {
      const boundaryBypass = [
        "function openBoundaryFileSync(params) {",
        "\t/* asar-bypass */ if (params.absolutePath && params.absolutePath.includes('.asar')) {",
        "\t\tconst ioFs = params.ioFs ?? fs;",
        "\t\ttry {",
        "\t\t\tconst fd = ioFs.openSync(params.absolutePath, ioFs.constants.O_RDONLY);",
        "\t\t\tconst stat = ioFs.statSync(params.absolutePath);",
        "\t\t\treturn { ok: true, path: params.absolutePath, fd, stat, rootRealPath: params.rootPath };",
        "\t\t} catch (e) {",
        "\t\t\treturn { ok: false, reason: 'validation' };",
        "\t\t}",
        "\t}",
      ].join("\n");
      result = result.replace(boundaryMarker, boundaryBypass);
    }

    // 补丁 2: openVerifiedFileSync — 兜底，防止其他调用路径也触发校验
    const verifiedMarker = "function openVerifiedFileSync(params) {";
    if (result.includes(verifiedMarker)) {
      const verifiedBypass = [
        "function openVerifiedFileSync(params) {",
        "\t/* asar-bypass-verified */ if (params.filePath && params.filePath.includes('.asar')) {",
        "\t\tconst ioFs = params.ioFs ?? fs;",
        "\t\ttry {",
        "\t\t\tconst fd = ioFs.openSync(params.filePath, ioFs.constants.O_RDONLY);",
        "\t\t\tconst stat = ioFs.statSync(params.filePath);",
        "\t\t\treturn { ok: true, path: params.filePath, fd, stat };",
        "\t\t} catch (e) {",
        "\t\t\treturn { ok: false, reason: 'validation' };",
        "\t\t}",
        "\t}",
      ].join("\n");
      result = result.replace(verifiedMarker, verifiedBypass);
    }

    // 补丁 3: openRootFileSync — openclaw ≥2026.6.x 的 @openclaw/fs-safe 入口
    // （root-file-*.js）。在 resolveRootFilePathGeneric 之前拦截 ASAR 路径。
    const rootFileMarker = "function openRootFileSync(params) {";
    if (result.includes(rootFileMarker)) {
      const rootFileBypass = [
        "function openRootFileSync(params) {",
        "\t/* asar-bypass */ if (params.absolutePath && params.absolutePath.includes('.asar')) {",
        "\t\tconst ioFs = params.ioFs ?? fs;",
        "\t\ttry {",
        "\t\t\tconst fd = ioFs.openSync(params.absolutePath, ioFs.constants.O_RDONLY);",
        "\t\t\tconst stat = ioFs.statSync(params.absolutePath);",
        "\t\t\treturn { ok: true, path: params.absolutePath, fd, stat, rootRealPath: params.rootRealPath };",
        "\t\t} catch (e) {",
        "\t\t\treturn { ok: false, reason: 'validation', error: e };",
        "\t\t}",
        "\t}",
      ].join("\n");
      result = result.replace(rootFileMarker, rootFileBypass);
    }

    // 补丁 4: openRootFile（async 版本）— 同上，防止异步调用路径触发校验
    const rootFileAsyncMarker = "async function openRootFile(params) {";
    if (result.includes(rootFileAsyncMarker)) {
      const rootFileAsyncBypass = [
        "async function openRootFile(params) {",
        "\t/* asar-bypass-async */ if (params.absolutePath && params.absolutePath.includes('.asar')) {",
        "\t\tconst ioFs = params.ioFs ?? fs;",
        "\t\ttry {",
        "\t\t\tconst fd = ioFs.openSync(params.absolutePath, ioFs.constants.O_RDONLY);",
        "\t\t\tconst stat = ioFs.statSync(params.absolutePath);",
        "\t\t\treturn { ok: true, path: params.absolutePath, fd, stat, rootRealPath: params.rootRealPath };",
        "\t\t} catch (e) {",
        "\t\t\treturn { ok: false, reason: 'validation', error: e };",
        "\t\t}",
        "\t}",
      ].join("\n");
      result = result.replace(rootFileAsyncMarker, rootFileAsyncBypass);
    }

    // 补丁 5: verifyStableReadTarget — @openclaw/fs-safe 的 regular-file-*.js。
    // readRegularFileSync/readRegularFile 用它做 sameFileIdentity 校验（lstat vs fstat 的
    // dev/ino 比对）。asar 中 lstat 返回伪造 ino、fstat 返回真实 ino，校验恒失败，导致
    // asar 内所有 package.json 经 tryReadJsonSync 静默读为 null，插件 openclaw.extensions
    // 被忽略。asar 路径跳过身份校验，保留常规文件/符号链接检查。
    const stableReadMarker = "function verifyStableReadTarget(params) {";
    if (result.includes(stableReadMarker)) {
      const stableReadBypass = [
        "function verifyStableReadTarget(params) {",
        "\t/* asar-bypass */ if (params.filePath && params.filePath.includes('.asar')) {",
        "\t\tif (!params.postOpenStat.isFile() || params.pathStat.isSymbolicLink() || !params.pathStat.isFile()) throw new Error(`File is not a regular file: ${params.filePath}`);",
        "\t\treturn;",
        "\t}",
      ].join("\n");
      result = result.replace(stableReadMarker, stableReadBypass);
    }

    // 补丁 6: openPinnedFileSync — @openclaw/fs-safe 的 pinned-open-*.js。
    // 内部同样做 sameFileIdentity 校验（pinned-open），root-file 补丁已覆盖边界读取，
    // 此处兜底直接调用 pinned-open 的路径（如 secret-file）。
    const pinnedOpenMarker = "function openPinnedFileSync(params) {";
    if (result.includes(pinnedOpenMarker)) {
      const pinnedOpenBypass = [
        "function openPinnedFileSync(params) {",
        "\t/* asar-bypass */ if (params.filePath && params.filePath.includes('.asar')) {",
        "\t\tconst ioFs = params.ioFs ?? fs;",
        "\t\ttry {",
        "\t\t\tconst fd = ioFs.openSync(params.filePath, ioFs.constants.O_RDONLY);",
        "\t\t\tconst stat = ioFs.statSync(params.filePath);",
        "\t\t\treturn { ok: true, path: params.filePath, fd, stat };",
        "\t\t} catch (e) {",
        "\t\t\treturn { ok: false, reason: 'io', error: e };",
        "\t\t}",
        "\t}",
      ].join("\n");
      result = result.replace(pinnedOpenMarker, pinnedOpenBypass);
    }

    // 补丁 7: sameFileIdentity — @openclaw/fs-safe 的 file-identity-*.js。
    // Electron asar 中每次 stat/lstat 调用的 ino 是递增计数器（每次调用都不同），
    // 但 dev 恒为 1（真实 NTFS 的 dev 是大数）。凡 dev 均为 1 的两个 stat 必同来自
    // asar 虚拟文件系统，视为同一文件——ino 在 asar 中无任何可比性。
    // 该函数被十余个 chunk 共用（public-surface-loader / pinned-open / regular-file /
    // write-queue 等），一处补丁覆盖全部路径 stat 两两比对场景。
    const fileIdentityMarker = "function sameFileIdentity(left, right, platform = process.platform) {";
    if (result.includes(fileIdentityMarker)) {
      const fileIdentityBypass = [
        "function sameFileIdentity(left, right, platform = process.platform) {",
        "\t/* asar-bypass */ if (Number(left.dev) === 1 && Number(right.dev) === 1) return true;",
      ].join("\n");
      result = result.replace(fileIdentityMarker, fileIdentityBypass);
    }

    // 补丁 8/9: peer-link 审计与创建 — openclaw ≥2026.7 的 plugin-peer-link-*.js。
    // 声明 peerDependencies.openclaw 的插件要求 node_modules/openclaw 链接指向内核包根。
    // asar 模式下内核包根是虚拟路径（gateway.asar\node_modules\openclaw），junction 可以
    // 创建但 realpath 无法穿透归档，审计恒失败，startup-migration 据此拒绝 gateway ready。
    // asar 中插件的 openclaw/* 导入由内核 sdk-alias 加载器重定向，无需真实 peer 链接：
    // 审计直接放行，创建返回 "unchanged"（skipped=0，安装流程不报 peer-link 错误）。
    const peerAuditMarker = "async function auditOpenClawPeerDependency(params) {";
    if (result.includes(peerAuditMarker)) {
      const peerAuditBypass = [
        "async function auditOpenClawPeerDependency(params) {",
        "\t/* asar-bypass */ if (params.hostRoot && params.hostRoot.includes('.asar')) return null;",
      ].join("\n");
      result = result.replace(peerAuditMarker, peerAuditBypass);
    }
    const peerLinkMarker = "async function linkOpenClawPeerDependency(params) {";
    if (result.includes(peerLinkMarker)) {
      const peerLinkBypass = [
        "async function linkOpenClawPeerDependency(params) {",
        "\t/* asar-bypass */ if (params.hostRoot && params.hostRoot.includes('.asar')) return \"unchanged\";",
      ].join("\n");
      result = result.replace(peerLinkMarker, peerLinkBypass);
    }

    // 补丁 10: installedPackageNeedsOpenClawPeerLinkRepair — package-update-utils-*.js。
    // npm 安装插件后用 fs.statSync(插件目录/node_modules/openclaw) 判断是否需要补建
    // peer 链接；asar 模式下补丁 9 使链接永不创建，此检查恒 ENOENT 导致安装回滚报错。
    // 内核运行于 asar 时（argv[1] 含 .asar）直接返回 false——peer 链接由 sdk-alias 取代。
    const peerRepairMarker = "function installedPackageNeedsOpenClawPeerLinkRepair(dir) {";
    if (result.includes(peerRepairMarker)) {
      const peerRepairBypass = [
        "function installedPackageNeedsOpenClawPeerLinkRepair(dir) {",
        "\t/* asar-bypass */ if (typeof process.argv[1] === 'string' && process.argv[1].includes('.asar')) return false;",
      ].join("\n");
      result = result.replace(peerRepairMarker, peerRepairBypass);
    }

    if (result !== source) {
      fs.writeFileSync(filePath, result, "utf-8");
      patched++;
    }
  }

  return patched;
}

// 检查 openclaw dist 根下是否已存在任一 asar-bypass marker。
// 调用方（package-resources.js）用它区分 patchAsarBoundaryCheck 返回 0 的两种含义：
// 已补丁（幂等跳过）vs marker 未命中（上游结构变化，必须中止）。
function hasAsarBoundaryPatchMarker(gatewayDir) {
  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) return false;
  const markers = ["/* asar-bypass */", "/* asar-bypass-verified */", "/* asar-bypass-async */"];
  for (const fileName of fs.readdirSync(distDir)) {
    if (!fileName.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(distDir, fileName), "utf-8");
    if (markers.some((m) => source.includes(m))) return true;
  }
  return false;
}

// ─── kimi 插件思考档位补丁 ───
//
// bundled kimi 插件（dist/extensions/kimi/dist/index.js）的 resolveThinkingProfile
// 钩子无视上下文，对 kimi/kimi-code/kimi-coding 一律返回二值档位 [off, on]，
// 导致 k3 系模型（配置里带 compat.supportedReasoningEfforts 与 thinkingLevelMap）
// 无法选择 low/medium/high/xhigh/max，sessions.patch/chat.send 校验直接报
// "Thinking level "high" is not supported ... Use one of: off, on."。
//
// 补丁策略：钩子改为读取内核传入的 context.compat.supportedReasoningEfforts
// （resolveThinkingPolicyContext 已从模型目录条目透传该字段）——有则按声明档位
// 返回完整列表（off 恒在首位，默认 high），无则保持原二值行为不变。
// 请求层的档位→线上 effort 映射仍由模型条目的 thinkingLevelMap 透传，不受影响。
//
// 幂等：已注入 /* cryoclaw-thinking-profile */ 标记则跳过；marker 不匹配返回 0
// （上游结构变化时静默跳过，不阻断打包/升级）。
//
// 两种包形态（vendored @openclaw/kimi-provider 的版本决定命中哪种）：
//   2026.7.x 包：dist/extensions/kimi/dist/index.js 内联
//     resolveThinkingProfile: () => ({ levels: [off, on], ... }) 钩子。
//   2026.8.x 包：index.js 变为 ESM wrapper，钩子移到
//     dist/extensions/kimi/dist/provider-policy-api.js 的
//     function resolveThinkingProfile({ modelId })，上游已原生支持 K3 全档位
//     但硬编码 model ID 白名单（k3/k3-256k/k3[1m]）——白名单外、靠
//     compat.supportedReasoningEfforts 声明能力的模型仍需本补丁。
//     内核调用钩子时会透传 compat（thinking-*.js 的 providerContext）。
function patchKimiThinkingProfile(gatewayDir) {
  const kimiDistDir = path.join(
    gatewayDir,
    "node_modules",
    "openclaw",
    "dist",
    "extensions",
    "kimi",
    "dist"
  );

  // 形态一（≥2026.8.x 包）：provider-policy-api.js 的命名函数
  const policyFile = path.join(kimiDistDir, "provider-policy-api.js");
  if (fs.existsSync(policyFile)) {
    const source = fs.readFileSync(policyFile, "utf-8");
    if (source.includes("/* cryoclaw-thinking-profile */")) return 0;
    const marker = "function resolveThinkingProfile({ modelId }) {";
    if (source.includes(marker)) {
      const replacement = [
        "function resolveThinkingProfile(context) {",
        "\t/* cryoclaw-thinking-profile */",
        '\tconst modelId = typeof context?.modelId === "string" ? context.modelId : "";',
        "\tconst efforts = Array.isArray(context?.compat?.supportedReasoningEfforts)",
        '\t\t? context.compat.supportedReasoningEfforts.filter((e) => typeof e === "string" && e.trim() && e !== "off")',
        "\t\t: [];",
        "\tif (efforts.length > 0) return {",
        '\t\tlevels: [{ id: "off", label: "off" }, ...efforts.map((id) => ({ id, label: id }))],',
        '\t\tdefaultLevel: efforts.includes("high") ? "high" : efforts[efforts.length - 1]',
        "\t};",
      ].join("\n");
      fs.writeFileSync(policyFile, source.replace(marker, replacement), "utf-8");
      return 1;
    }
    // 新包形态但 marker 未命中：不再尝试旧形态（index.js 只是 wrapper）
    return 0;
  }

  // 形态二（≤2026.7.x 包）：index.js 内联钩子
  const target = path.join(kimiDistDir, "index.js");
  if (!fs.existsSync(target)) return 0;

  const source = fs.readFileSync(target, "utf-8");
  if (source.includes("/* cryoclaw-thinking-profile */")) return 0;

  const marker =
    /resolveThinkingProfile:\s*\(\)\s*=>\s*\(\{\s*levels:\s*\[\{\s*id:\s*"off",\s*label:\s*"off"\s*\},\s*\{\s*id:\s*"low",\s*label:\s*"on"\s*\}\],\s*defaultLevel:\s*"off"\s*\}\)/;
  if (!marker.test(source)) return 0;

  const replacement = [
    'resolveThinkingProfile: (context) => {',
    '\t\t\t/* cryoclaw-thinking-profile */',
    '\t\t\tconst efforts = Array.isArray(context?.compat?.supportedReasoningEfforts)',
    '\t\t\t\t? context.compat.supportedReasoningEfforts.filter((e) => typeof e === "string" && e.trim() && e !== "off")',
    '\t\t\t\t: [];',
    '\t\t\tif (efforts.length > 0) {',
    '\t\t\t\treturn {',
    '\t\t\t\t\tlevels: [{ id: "off", label: "off" }, ...efforts.map((id) => ({ id, label: id }))],',
    '\t\t\t\t\tdefaultLevel: efforts.includes("high") ? "high" : efforts[efforts.length - 1]',
    '\t\t\t\t};',
    '\t\t\t}',
    '\t\t\treturn {',
    '\t\t\t\tlevels: [{ id: "off", label: "off" }, { id: "low", label: "on" }],',
    '\t\t\t\tdefaultLevel: "off"',
    '\t\t\t};',
    '\t\t\t}',
  ].join("\n");

  fs.writeFileSync(target, source.replace(marker, replacement), "utf-8");
  return 1;
}

module.exports = {
  patchWindowsOpenclawArtifacts,
  patchWindowsHideGlobal,
  injectWindowsHideAll,
  collectJsFilesRecursive,
  patchAsarBoundaryCheck,
  hasAsarBoundaryPatchMarker,
  patchKimiThinkingProfile,
};
