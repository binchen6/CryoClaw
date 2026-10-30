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

// 递归收集目录下所有 .js/.mjs 文件（openclaw ≥2026.9.3 起 dist 根 chunk 大量翻转为 .mjs）
function collectJsFilesRecursive(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFilesRecursive(full));
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
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
//   openclaw ≥2026.9.2：上述函数全部迁出 openclaw dist chunk，落到独立 npm 包
//     @openclaw/fs-safe/dist/*.js（root-file.js / pinned-open.js / regular-file.js /
//     file-identity.js），openclaw chunk 经 "@openclaw/fs-safe/advanced" import。
//     因此扫描范围扩展到 fs-safe 包目录；v9 的 readRegularFileSync/readRegularFile
//     改为内联 inspectFileIdentitySync 三次观测（verifyStableReadTarget 已不存在），
//     需按函数头注入 asar 快速通道。
//
// 返回补丁的文件数；0 表示上游结构不匹配（调用方应结合 assertAsarBoundaryCoverage 判断）。

function patchAsarBoundaryCheck(gatewayDir) {
  writeKernelCompatibilityMetadata(gatewayDir);
  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) return 0;

  // 扫描 dist 根下所有 .js/.mjs chunk，按函数标记注入（hash 文件名随版本变化；
  // openclaw ≥2026.9.3 起根 chunk 从 .js 翻转为 .mjs，peer-link 等补丁目标住 .mjs）。
  // openclaw ≥2026.9.2 起边界校验函数住在 @openclaw/fs-safe 包里，需一并扫描
  // （只扫该包 dist 根一层——fs-safe 的源码形态是散文件，不是 chunk）。
  const candidateFiles = [];
  for (const fileName of fs.readdirSync(distDir)) {
    if (fileName.endsWith(".js") || fileName.endsWith(".mjs")) {
      candidateFiles.push({ filePath: path.join(distDir, fileName), root: "openclaw" });
    }
  }
  const fsSafeDist = path.join(gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist");
  if (fs.existsSync(fsSafeDist)) {
    for (const fileName of fs.readdirSync(fsSafeDist)) {
      if (fileName.endsWith(".js") || fileName.endsWith(".mjs")) {
        candidateFiles.push({ filePath: path.join(fsSafeDist, fileName), root: "fs-safe" });
      }
    }
  }
  if (candidateFiles.length === 0) {
    return 0;
  }

  let patched = 0;
  for (const { filePath, root } of candidateFiles) {
    let source = fs.readFileSync(filePath, "utf-8");
    // Replace old shims even in cached trees: callers require { buffer, stat }.
    if (root === "fs-safe" && !source.includes("/* cryoclaw-regular-read-contract */")) {
      source = source.replace(/((?:async )?function readRegularFile(?:Sync)?\(params\) \{)\r?\n\t\/\* asar-bypass(?:-async)? \*\/ if \(typeof params.filePath[\s\S]*?\r?\n\t\}/g, "$1");
    }

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
    // rootRealPath 必须兜底 params.rootPath：它是原逻辑里 resolveRootPathSync 算出的
    // *输出*，调用方（如 public-surface 加载链 preparePublicSurfaceModule）并不传；
    // 直接透传 params.rootRealPath 会得到 undefined，下游 bindPluginCacheRoot 的
    // path.resolve(undefined) 让 CLI 直接起不来（v2026.904.1 生产事故）。
    const rootFileMarker = "function openRootFileSync(params) {";
    if (result.includes(rootFileMarker)) {
      const rootFileBypass = [
        "function openRootFileSync(params) {",
        "\t/* asar-bypass */ if (params.absolutePath && params.absolutePath.includes('.asar')) {",
        "\t\tconst ioFs = params.ioFs ?? fs;",
        "\t\ttry {",
        "\t\t\tconst fd = ioFs.openSync(params.absolutePath, ioFs.constants.O_RDONLY);",
        "\t\t\tconst stat = ioFs.statSync(params.absolutePath);",
        "\t\t\treturn { ok: true, path: params.absolutePath, fd, stat, rootRealPath: params.rootRealPath ?? params.rootPath };",
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
        "\t\t\treturn { ok: true, path: params.absolutePath, fd, stat, rootRealPath: params.rootRealPath ?? params.rootPath };",
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
    // 但 dev 恒为 1（真实 NTFS 的 dev 是大数）。任一侧 dev===1 即为 asar 伪 stat，
    // ino 无任何可比性，直接判同一文件——覆盖伪/伪（两次路径 stat）与伪/真
    // （快速通道返回的伪 stat vs fstat 真身份）两种组合。
    // 该函数被十余个 chunk 共用（public-surface-loader / pinned-open / regular-file /
    // write-queue 等），一处补丁覆盖全部路径 stat 两两比对场景。
    const fileIdentityMarker = "function sameFileIdentity(left, right, platform = process.platform) {";
    if (result.includes(fileIdentityMarker)) {
      const fileIdentityBypass = [
        "function sameFileIdentity(left, right, platform = process.platform) {",
        "\t/* asar-bypass */ if (Number(left.dev) === 1 || Number(right.dev) === 1) return true;",
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
    if (result.includes(peerAuditMarker) && !result.includes("/* cryoclaw-peer-asar-link */")) {
      const peerAuditBypass = [
        "async function auditOpenClawPeerDependency(params) {",
        "\t/* asar-bypass */ if (params.hostRoot && params.hostRoot.includes('.asar')) return null;",
      ].join("\n");
      result = result.replace(peerAuditMarker, peerAuditBypass);
    }
    const peerLinkMarker = "async function linkOpenClawPeerDependency(params) {";
    if (result.includes(peerLinkMarker) && !result.includes("/* cryoclaw-peer-asar-link */")) {
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

    // 补丁 11/12: readRegularFileSync / readRegularFile — @openclaw/fs-safe 的
    // regular-file.js（openclaw ≥2026.9.2 形态）。v9 起内联 inspectFileIdentitySync
    // 三次观测（open 前 lstat、open 后 fstat、读前 lstat），asar 虚拟路径上
    // 伪/真身份恒不一致 → path-mismatch → asar 内 package.json 经 tryReadJsonSync
    // 静默读为 null，插件 openclaw.extensions 被忽略。asar 路径直接 stat+read，
    // 保留 maxBytes 语义。仅限 fs-safe 包（依赖该文件的 fsSync/fs/错误助手变量名）。
    if (root === "fs-safe") {
      const readRegularSyncMarker = "function readRegularFileSync(params) {";
      if (result.includes(readRegularSyncMarker)) {
        const readRegularSyncBypass = [
          "function readRegularFileSync(params) {",
          "\t/* asar-bypass */ /* cryoclaw-regular-read-contract */ if (typeof params.filePath === 'string' && /\\.asar[\\\\/]/i.test(params.filePath)) {",
          "\t\tconst physical = params.filePath.replace(/\\.asar([\\\\/])/i, '.asar.unpacked$1');",
          "\t\tif (fsSync.existsSync(physical)) return readRegularFileSync({ ...params, filePath: physical });",
          "\t\tconst maxBytes = normalizeMaxBytes(params.maxBytes);",
          "\t\tconst stat = fsSync.lstatSync(params.filePath);",
          "\t\tif (!stat.isFile() || stat.isSymbolicLink()) throw new Error('path must be a regular file');",
          "\t\tif (maxBytes !== undefined && stat.size > maxBytes) throw regularFileTooLargeError(params.filePath, maxBytes);",
          "\t\treturn { buffer: fsSync.readFileSync(params.filePath), stat };",
          "\t}",
        ].join("\n");
        result = result.replace(readRegularSyncMarker, readRegularSyncBypass);
      }
      const readRegularAsyncMarker = "async function readRegularFile(params) {";
      if (result.includes(readRegularAsyncMarker)) {
        const readRegularAsyncBypass = [
          "async function readRegularFile(params) {",
          "\t/* asar-bypass-async */ /* cryoclaw-regular-read-contract */ if (typeof params.filePath === 'string' && /\\.asar[\\\\/]/i.test(params.filePath)) {",
          "\t\tconst physical = params.filePath.replace(/\\.asar([\\\\/])/i, '.asar.unpacked$1');",
          "\t\tif (fsSync.existsSync(physical)) return await readRegularFile({ ...params, filePath: physical });",
          "\t\tconst maxBytes = normalizeMaxBytes(params.maxBytes);",
          "\t\tconst stat = await fs.lstat(params.filePath);",
          "\t\tif (!stat.isFile() || stat.isSymbolicLink()) throw new Error('path must be a regular file');",
          "\t\tif (maxBytes !== undefined && stat.size > maxBytes) throw regularFileTooLargeError(params.filePath, maxBytes);",
          "\t\treturn { buffer: await fs.readFile(params.filePath), stat };",
          "\t}",
        ].join("\n");
        result = result.replace(readRegularAsyncMarker, readRegularAsyncBypass);
      }
    }

    if (result !== source) {
      fs.writeFileSync(filePath, result, "utf-8");
      patched++;
    }
  }

  return patched;
}

function writeKernelCompatibilityMetadata(gatewayDir) {
  const root=path.join(gatewayDir,"node_modules","openclaw"),dist=path.join(root,"dist");
  if(!fs.existsSync(dist)||!fs.existsSync(path.join(root,"package.json")))return 0;
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  const files=fs.readdirSync(dist).filter(name=>/^openclaw-agent-db-schema-read-.*\.(?:m?js)$/.test(name));
  if(["2026.10.7","2026.10.9"].includes(pkg.version)&&files.length!==1)throw Error("Pinned kernel must have exactly one agent schema admission module");
  if(!files.length)return 0;
  const versions=new Set();
  for(const file of files){
    const source=fs.readFileSync(path.join(dist,file),"utf8");
    const match=source.match(/if \(userVersion > (\d+)\) throw createNewerSqliteSchemaVersionError\("OpenClaw agent database"/);
    if(!match)throw Error("Agent schema admission changed; review migration requirement");
    versions.add(Number(match[1]));
  }
  if(versions.size!==1)throw Error("Conflicting agent schema admission requirements");
  const agentDbUserVersion=[...versions][0];
  if(pkg.openclaw?.schemaVersions?.agent!==undefined&&pkg.openclaw.schemaVersions.agent!==agentDbUserVersion)throw Error("Agent schema manifest and admission gate disagree");
  fs.writeFileSync(path.join(root,"cryoclaw-kernel-compat.json"),JSON.stringify({version:pkg.version,agentDbUserVersion})+"\n");return 1;
}

// 检查 openclaw dist 根与 @openclaw/fs-safe dist 根下是否已存在任一 asar-bypass marker。
// 调用方（package-resources.js）用它区分 patchAsarBoundaryCheck 返回 0 的两种含义：
// 已补丁（幂等跳过）vs marker 未命中（上游结构变化，必须中止）。
function hasAsarBoundaryPatchMarker(gatewayDir) {
  const scanRoots = [
    path.join(gatewayDir, "node_modules", "openclaw", "dist"),
    path.join(gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist"),
  ];
  const markers = ["/* asar-bypass */", "/* asar-bypass-verified */", "/* asar-bypass-async */"];
  for (const dir of scanRoots) {
    if (!fs.existsSync(dir)) continue;
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith(".js") && !fileName.endsWith(".mjs")) continue;
      const source = fs.readFileSync(path.join(dir, fileName), "utf-8");
      if (markers.some((m) => source.includes(m))) return true;
    }
  }
  return false;
}

// v9 形态感知的补丁覆盖断言（R19：验证终点必须是产物/树内内容断言）。
// R56 事故：v9 内核把边界校验函数迁到 @openclaw/fs-safe 包，旧扫描只看 openclaw
// dist chunk → 补丁计数 >0（仅 peer-link 命中）但关键快速通道全部漏打，渠道插件
// 全崩。这里按形态强制校验关键文件确已带补丁：
//   v9（fs-safe root-file.js 存在）：root-file.js 必须含 asar-bypass。
//   v8（无 fs-safe 包）：任一 openclaw dist chunk 含 asar-bypass（原逻辑）。
// R72 追加：openclaw ≥2026.9.3 起 peer-link 函数住 plugin-peer-link-*.mjs，
// 曾出现 root-file 断言 PASS 而 peer-link 补丁整体漏打（asar 模式下 vendored 插件
// peer 审计失败 → 启动拒绝 ready）——该形态存在时强制校验已带补丁。
// 未覆盖时抛 Error，调用方中止打包/升级。
function assertAsarBoundaryCoverage(gatewayDir) {
  const fsSafeRootFile = path.join(
    gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist", "root-file.js"
  );
  if (fs.existsSync(fsSafeRootFile)) {
    const source = fs.readFileSync(fsSafeRootFile, "utf-8");
    if (!source.includes("/* asar-bypass */")) {
      throw new Error(
        "@openclaw/fs-safe/dist/root-file.js 缺少 asar 快速通道补丁（上游结构变化？），中止"
      );
    }
    assertPeerLinkPatchCoverage(gatewayDir);
    const regularFile = path.join(path.dirname(fsSafeRootFile), "regular-file.js");
    if (fs.existsSync(regularFile)) {
      const readSource = fs.readFileSync(regularFile, "utf8");
      if (!readSource.includes("/* cryoclaw-regular-read-contract */") ||
        !readSource.includes("return { buffer: fsSync.readFileSync(params.filePath), stat };") ||
        !readSource.includes("return { buffer: await fs.readFile(params.filePath), stat };")) {
        throw new Error("fs-safe regular-file ASAR read contract was not patched; refusing to package");
      }
    }
    return;
  }
  if (hasAsarBoundaryPatchMarker(gatewayDir)) return;
  throw new Error("ASAR 边界校验补丁未命中任何模块（openclaw 上游结构变化？）");
}

// peer-link 补丁覆盖断言（R72）：dist 根存在 plugin-peer-link-*.js/.mjs 且内含
// auditOpenClawPeerDependency / linkOpenClawPeerDependency 函数定义时，该文件必须
// 已带 asar-bypass marker。函数定义不在这些文件里（形态变化）则静默通过。
function assertPeerLinkPatchCoverage(gatewayDir) {
  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) return;
  for (const fileName of fs.readdirSync(distDir)) {
    if (!fileName.startsWith("plugin-peer-link-")) continue;
    if (!fileName.endsWith(".js") && !fileName.endsWith(".mjs")) continue;
    const source = fs.readFileSync(path.join(distDir, fileName), "utf-8");
    const hasPeerLinkFn =
      source.includes("async function auditOpenClawPeerDependency(params) {") ||
      source.includes("async function linkOpenClawPeerDependency(params) {");
    if (hasPeerLinkFn && !source.includes("/* asar-bypass */") && !source.includes("/* cryoclaw-peer-asar-link */")) {
      throw new Error(
        `openclaw dist/${fileName} 含 peer-link 函数但缺少 asar 补丁（扫描面变化？），中止`
      );
    }
  }
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

// ─── fs-safe pinned-open asar 身份观测映射补丁（openclaw ≥2026.9.2）───
//
// 背景：2026.9.2 起内核用 vendored @openclaw/fs-safe 校验插件公开构件
// （openRootFileSync → openPinnedFileSync）：open 前后各做一次 lstat(bigint)
// 加 open 后一次 fstat(bigint)，要求 dev/ino 完全一致（win32 下 0 视为
// unknown，重试两次后仍不一致即抛 path-mismatch）。
//
// Electron 的 asar fs 集成对「unpacked 文件的 asar 虚拟路径」返回伪造身份
// （实测 dev=1, ino=1，见 R56 探针），而 openSync/fstatSync 走真实文件返回
// 真实身份——三次观测必然不一致。
//
// 补丁策略：pinned-open.js 中两次 lstatSync(realPath, {bigint:true}) 身份观测的
// 参数映射到 .asar.unpacked 真实路径（存在时），使观测全部落在真实文件上、
// 与 fstat 一致；openSync 与返回值 opened.path 仍用 asar 虚拟路径——下游
// ESM 模块解析（openclaw/plugin-sdk/*）依赖 asar 内 node_modules 上下文，
// 返回真实路径会让解析脱离归档（R56 后续事故：Cannot find module
// 'openclaw/plugin-sdk/runtime-doctor'）。配合打包侧 dist/extensions 整目录
// unpackDir（package-resources.js packGatewayAsar）。
//
// 幂等：含 /* cryoclaw-asar-identity */ marker 则跳过；源码形态变化返回 0。
// 兼容清理：R56 早期版本曾整体重映射 realPath（破坏 opened.path 语义），
// 先还原旧形态再打新补丁。
function patchFsSafeAsarUnpacked(gatewayDir) {
  const pinnedOpen = path.join(gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist", "pinned-open.js");
  if (!fs.existsSync(pinnedOpen)) return 0;
  let source = fs.readFileSync(pinnedOpen, "utf-8");
  if (source.includes("/* cryoclaw-asar-identity */")) return 1;

  // 还原 R56 早期版本的错误补丁形态（realPath 整体重映射 + 旧 helper）
  const origDecl = "const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);";
  // fs-safe 0.21.x（openclaw ≥2026.9.7）改形：params 解构为局部变量 + 双路 realpath
  // （ioFs === fs 时走包内 realpathSync 包装，其余走 ioFs.realpathSync）。
  const origDeclV21 =
    "const realPath = resolvedPath ??\n" +
    "            (ioFs === fs ? realpathSync(filePath) : ioFs.realpathSync(filePath));";
  const legacyDecl = [
    "let realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);",
    "\t\t/* cryoclaw-asar-unpacked */ realPath = mapAsarUnpackedPath(ioFs, realPath);",
  ].join("\n");
  source = source.split(legacyDecl).join(origDecl);
  source = source.replace(
    /\n\/\* cryoclaw-asar-unpacked \*\/\nfunction mapAsarUnpackedPath[\s\S]*?\n\}\n/g,
    "\n"
  );

  // 两次 lstatSync(realPath, { bigint: true }) 是身份观测点（preOpen + 读前复核）；
  // rejectPathSymlink 的 lstatSync(params.filePath) 不做身份比对，不动。
  const statMarker = "ioFs.lstatSync(realPath, { bigint: true })";
  if (!source.includes(statMarker)) return 0;
  if (!source.includes(origDecl) && !source.includes(origDeclV21)) return 0;
  const patchedStat =
    "ioFs.lstatSync(/* cryoclaw-asar-identity */ asarIdentityPath(ioFs, realPath), { bigint: true })";

  // helper 追加到文件尾（模块顶层函数声明，openPinnedFileSync 内调用可正常解析）
  const helper = [
    "",
    "/* cryoclaw-asar-identity */",
    "function asarIdentityPath(ioFs, p) {",
    "\tif (!p || p.indexOf('.asar') === -1) return p;",
    "\tconst idx = p.indexOf('.asar');",
    "\tconst candidate = p.slice(0, idx) + '.asar.unpacked' + p.slice(idx + 5);",
    "\ttry { ioFs.statSync(candidate); return candidate; } catch { return p; }",
    "}",
    "",
  ].join("\n");

  fs.writeFileSync(pinnedOpen, source.split(statMarker).join(patchedStat) + helper, "utf-8");
  return 1;
}

// Electron does not implement opendir for virtual ASAR directories. Keep entry
// paths virtual for module resolution, but walk already-unpacked directories on
// disk, preserving the existing symlink and resource-budget checks.
function patchFsSafeAsarWalk(gatewayDir) {
  patchImmutableSkillsWatch(gatewayDir);
  const file = path.join(gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist", "walk.js");
  if (!fs.existsSync(file)) return 0;
  let source = fs.readFileSync(file, "utf8");
  const marker = "/* cryoclaw-asar-walk */";
  if (source.includes(marker)) return 1;
  const needle = "const operationPath = pathForWindowsFilesystem(dir);";
  if (!source.includes(needle)) throw new Error("Unsupported fs-safe directory walker; ASAR walk patch was not applied");
  source = source.split(needle).join("const operationPath = cryoclawAsarWalkPath(pathForWindowsFilesystem(dir));");
  source += `\n${marker}\nfunction cryoclawAsarWalkPath(value) {\n` +
    `    if (!/\\.asar[\\\\/]/i.test(value)) return value;\n` +
    `    const unpacked = value.replace(/\\.asar([\\\\/])/i, '.asar.unpacked$1');\n` +
    `    try { if (fsSync.lstatSync(unpacked).isDirectory()) return unpacked; } catch {}\n` +
    `    return value;\n}\n`;
  fs.writeFileSync(file, source);
  return 1;
}

// Bundled skills are replaced with the runtime and cannot change in a running
// app. Observing virtual ASAR directories repeatedly fails strict bigint stat
// checks in Electron and needlessly re-scans every installed skill.
function patchImmutableSkillsWatch(gatewayDir) {
  const dir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(dir)) return 0;
  let patched = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^refresh-.*\.(?:m?js)$/.test(name)) continue;
    const file = path.join(dir, name);
    const source = fs.readFileSync(file, "utf8");
    if (source.includes("/* cryoclaw-immutable-skills */")) { patched++; continue; }
    const needle = "const watchTargets = resolvedTargets.targets;";
    if (!source.includes(needle)) continue;
    const replacement = "const watchTargets = resolvedTargets.targets.filter((target) => {\n" +
      "\t\t\t/* cryoclaw-immutable-skills */ const root = process.env.CRYOCLAW_OPENAI_GATEWAY_ROOT;\n" +
      "\t\t\tif (!root || !/\\.asar[\\\\/]/i.test(root)) return true;\n" +
      "\t\t\tconst bundled = path.resolve(root, 'dist', 'extensions');\n" +
      "\t\t\tconst relative = path.relative(bundled, path.resolve(target.path));\n" +
      "\t\t\treturn relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);\n\t\t});";
    fs.writeFileSync(file, source.replace(needle, replacement));
    patched++;
  }
  return patched;
}

// Artifact hashing compares the opened descriptor's physical identity. Map this
// read only; exported module paths must keep their virtual resolution context.
function patchPluginArtifactAsarIdentity(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules","openclaw","dist");
  if(!fs.existsSync(dist))return 0;
  const needle="function hashRuntimeArtifactFile(params) {";
  const marker="/* cryoclaw-artifact-identity */";
  let patched=0;
  for(const file of collectJsFilesRecursive(dist)) {
    const source=fs.readFileSync(file,"utf8");
    if(!source.includes(needle))continue;
    if(source.includes(marker)){patched++;continue;}
    const injection=`${needle}\n\t${marker}\n`+
      `\tif (/\\.asar[\\\\/]/i.test(params.rootDir)) {\n`+
      `\t\tconst physical = params.rootDir.replace(/\\.asar([\\\\/])/i, '.asar.unpacked$1');\n`+
      `\t\ttry { if (fs.lstatSync(physical).isDirectory()) params = { ...params, rootDir: physical, rootRealPath: fs.realpathSync(physical) }; } catch {}\n\t}\n`;
    fs.writeFileSync(file,source.replace(needle,injection));patched++;
  }
  return patched;
}

// NTFS junctions cannot traverse an ASAR file. Resolve only a direct junction
// to a verified virtual OpenClaw root; callers still compare the selected host.
function patchPluginNativeAsarHost(gatewayDir) {
  patchDesktopKernel(gatewayDir);
  patchPluginPeerAsarLink(gatewayDir);
  patchPluginAsarBoundaryScan(gatewayDir);
  const directory = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(directory)) return 0;
  let patched = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^plugin-generation-(?:artifact|source-lookup)-.*\.(?:m?js)$/.test(name)) continue;
    const file = path.join(directory, name);
    let source = fs.readFileSync(file, "utf8");
    if (source.includes("/* cryoclaw-native-asar-host */")) { patched++; continue; }
    // 双形态兼容：patchWindowsPluginCanonicalPaths 先跑时会把所有 fs.realpathSync(
    // 重写为 cryoclawPluginRealpath(（新形态）；该补丁未命中（无 withPluginSourceFile）
    // 时保持原始 fs.realpathSync（旧形态）。helper 的普通路径 realpath 委托对应形态，
    // junction→asar 穿透兜底两种形态都需要。
    const markerNew = "if (fs.existsSync(candidate)) return cryoclawPluginRealpath(candidate);";
    const markerOld = "if (fs.existsSync(candidate)) return fs.realpathSync(candidate);";
    const hasResolver = source.includes("function resolveNativeHost(filename) {");
    const realpathFn = source.includes(markerNew) || source.includes("cryoclawPluginRealpath(link)") ? "cryoclawPluginRealpath" : "fs.realpathSync";
    if (!hasResolver && !source.includes(`${realpathFn}(link)`)) continue;
    if (hasResolver && !source.includes(markerNew) && !source.includes(markerOld)) throw new Error("Native plugin host resolver changed; review ASAR compatibility");
    if (hasResolver) source = source.replace(realpathFn === "cryoclawPluginRealpath" ? markerNew : markerOld, "const resolved = cryoclawResolveNativeHostPath(candidate);\n\t\tif (resolved) return resolved;");
    source = source.replaceAll(`${realpathFn}(link)`, "cryoclawResolveNativeHostPath(link)");
    source += `
/* cryoclaw-native-asar-host */
function cryoclawResolveNativeHostPath(candidate) {
  try { return ${realpathFn}(candidate); } catch {}
  try {
    if (!fs.lstatSync(candidate).isSymbolicLink()) return;
    const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
    if (!/\\.asar[\\\\/]node_modules[\\\\/]openclaw$/i.test(target)) return;
    if (!fs.statSync(target).isDirectory()) return;
    return ${realpathFn}(target);
  } catch { return; }
}



`;
    fs.writeFileSync(file, source, "utf8");patched++;
  }
  return patched;
}

// Create the link even for ASAR hosts. New kernels audit it synchronously after npm updates.
// Only the exact selected host may be accepted when Windows cannot realpath through ASAR.
function patchPluginPeerAsarLink(gatewayDir) {
  const directory = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(directory)) return 0;
  let patched = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^plugin-peer-link-.*\.(?:m?js)$/.test(name)) continue;
    const file = path.join(directory, name);
    let source = fs.readFileSync(file, "utf8");
    if (source.includes("/* cryoclaw-peer-asar-link */")) { patched++; continue; }
    if (!source.includes("function linkOpenClawPeerDependency(params) {") || !source.includes("safeRealpathSync(linkPath)")) throw new Error("Plugin peer link contract changed; review ASAR compatibility");
    source = source.replace(/\s*\/\* asar-bypass \*\/ if \(params.hostRoot && params.hostRoot.includes\('\.asar'\)\) return (?:null|"unchanged");/g, "");
    source = source.replaceAll("safeRealpathSync(linkPath)", "(safeRealpathSync(linkPath) ?? cryoclawPeerAsarTarget(linkPath, params.hostRoot))");
    source = 'import { readlinkSync as cryoclawReadlink, statSync as cryoclawStat } from "node:fs";\n' + source;
    source += `
/* cryoclaw-peer-asar-link */
function cryoclawPeerAsarTarget(linkPath, hostRoot) {
  try {
    if (!/\\.asar[\\\\/]node_modules[\\\\/]openclaw$/i.test(hostRoot)) return null;
    const target = path.resolve(path.dirname(linkPath), cryoclawReadlink(linkPath));
    if (target !== path.resolve(hostRoot) || !cryoclawStat(hostRoot).isDirectory()) return null;
    return safeRealpathSync(hostRoot) ?? hostRoot;
  } catch { return null; }
}
`;
    fs.writeFileSync(file, source, "utf8"); patched++;
  }
  return patched;
}
function patchPluginAsarBoundaryScan(gatewayDir) {
  const directory=path.join(gatewayDir,"node_modules","openclaw","dist");
  if(!fs.existsSync(directory))return 0;
  let patched=0;
  for(const name of fs.readdirSync(directory)){
    if(!/^install-security-scan\.runtime-.*\.(?:m?js)$/.test(name))continue;
    const file=path.join(directory,name);let source=fs.readFileSync(file,"utf8");
    if(source.includes("/* cryoclaw-asar-boundary-link */")){patched++;continue;}
    const marker="resolvedTargetPath = await fs.realpath(params.symlinkPath);";
    if(!source.includes(marker))throw Error("Plugin dependency boundary scanner changed; review ASAR compatibility");
    source=source.replace(marker,`/* cryoclaw-asar-boundary-link */
    resolvedTargetPath = await fs.realpath(params.symlinkPath).catch(async error => {
      const host = params.trustedHostOpenClawRootRealPath;
      if (!host || !/\\.asar[\\\\/]node_modules[\\\\/]openclaw$/i.test(host) || !isTrustedOpenClawPeerSymlink({relativePath:params.symlinkRelativePath,allowManagedNpmRootPackagePeerSymlinks:params.allowManagedNpmRootPackagePeerSymlinks})) throw error;
      const target = path.resolve(path.dirname(params.symlinkPath), await fs.readlink(params.symlinkPath));
      if (target !== path.resolve(host) || !(await fs.stat(host)).isDirectory()) throw error;
      return path.resolve(host);
    });`);
    fs.writeFileSync(file,source,"utf8");patched++;
  }
  return patched;
}

// Preserve only this desktop-owned, bounded receipt in public history. Other
// tools retain the upstream details redaction policy, including Code Mode values.
function patchDeliverablesHistoryProjection(gatewayDir) {
  const dir=path.join(gatewayDir,"node_modules","openclaw","dist");if(!fs.existsSync(dir))return 0;
  let count=0;
  for(const name of fs.readdirSync(dir)){
    if(!/^chat-display-projection\.(?:core|canvas)-.*\.mjs$/.test(name))continue;
    const file=path.join(dir,name);let source=fs.readFileSync(file,"utf8");
    if(source.includes("/* cryoclaw-delivery-projection */")){count++;continue;}
    if(name.includes(".core-")){
      const needle="projectToolResultDetails(entry.details, maxChars)";if(!source.includes(needle))continue;
      source="/* cryoclaw-delivery-projection */\n"+source.replaceAll(needle,'projectToolResultDetails(entry.details, maxChars, entry.toolName ?? entry.tool_name ?? entry.name)');
    }else{
      const fn="function projectToolResultDetails(details, maxChars) {",start=source.indexOf(fn);if(start<0)continue;
      const at=source.indexOf("const projected = {};",start);if(at<0)throw Error("History details projection changed; review deliverables compatibility");
      source=source.slice(0,at)+source.slice(at).replace("const projected = {};",'const projected = {};\n\t/* cryoclaw-delivery-projection */\n\tif (cryoclawToolName === "cryoclaw_deliver_files") { const receipt=cryoclawProjectDeliveryReceipt(record.cryoclawDeliverables,maxChars); if(receipt)projected.cryoclawDeliverables=receipt; }');
      source=source.replace(fn,"function projectToolResultDetails(details, maxChars, cryoclawToolName) {");
      source+=`
function cryoclawProjectDeliveryReceipt(value,maxChars) {
  if(!value || value.version!==1 || !Array.isArray(value.files) || value.files.length<1 || value.files.length>12)return;
  const files=[];
  for(const file of value.files){
    if(!file || typeof file.path!=="string" || file.path.length>4096 || file.path.includes("\\0") || !/^(?:[A-Za-z]:[\\\\/]|\\/(?!\\/))/.test(file.path))return;
    files.push({path:file.path,...typeof file.title==="string"?{title:file.title.slice(0,120)}:{},
      ...Number.isFinite(file.size)&&file.size>=0?{size:file.size}:{},...Number.isFinite(file.mtimeMs)&&file.mtimeMs>=0?{mtimeMs:file.mtimeMs}:{}});
  }
  const receipt={version:1,files},text=JSON.stringify(receipt);
  if(text.length>maxChars || Buffer.byteLength(text,"utf8")>16384)return;
  return receipt;
}
`;
    }
    fs.writeFileSync(file,source);count++;
  }
  const manifest=path.join(dir,"..","package.json");
  if(fs.existsSync(manifest) && /^2026\.10\.(?:[5-7]|9)$/.test(JSON.parse(fs.readFileSync(manifest,"utf8")).version) && count<2)
    throw Error("Delivery history projection did not cover both core and canvas modules");
  return count;
}

// Preserve fs-safe admission; only avoid Node's repeated JS ancestor lstat walk on Windows.
function patchWindowsPluginCanonicalPaths(gatewayDir) {
  const directory=path.join(gatewayDir,"node_modules","openclaw","dist");if(!fs.existsSync(directory))return 0;let patched=0;
  for(const name of fs.readdirSync(directory)){
    if(!/^plugin-generation-(?:artifact|source-lookup)-.*\.mjs$/.test(name))continue;
    const file=path.join(directory,name);let source=fs.readFileSync(file,"utf8");
    if(source.includes("/* cryoclaw-plugin-canonical-path */")){patched++;continue;}
    const marker="function withPluginSourceFile(source, boundary, read) {";
    if(source.includes(marker)){
      const at=source.indexOf(marker),end=source.indexOf("rootPath: boundary,",at);
      if(end<0)throw Error("Plugin source admission changed; review canonical-root optimization");
      source=source.slice(0,end)+source.slice(end).replace("rootPath: boundary,","rootPath: boundary, rootRealPath: cryoclawPluginCanonicalRoot(boundary),");
    }else if(!source.includes("fs.realpathSync("))continue;
    source=source.replaceAll("fs.realpathSync(","cryoclawPluginRealpath(");
    source+=`
/* cryoclaw-plugin-canonical-path */
function cryoclawPluginCanonicalRoot(value) {
  if(process.platform!=="win32" || typeof value!=="string" || /\\.asar[\\\\/]/i.test(value))return undefined;
  try{return fs.realpathSync.native(value);}catch{return undefined;}
}
function cryoclawPluginRealpath(value,...options) {
  if(process.platform!=="win32" || typeof value!=="string" || /\\.asar[\\\\/]/i.test(value))return fs.realpathSync(value,...options);
  try{return fs.realpathSync.native(value,...options);}catch{return fs.realpathSync(value,...options);}
}
`;
    fs.writeFileSync(file,source,"utf8");patched++;
  }
  return patched;
}

// A refresh can legitimately retire a model publication while a deferred agent
// is joining the gateway. Retry only that typed cancellation, under the existing
// admission authority; never turn a stale publication into a durable DB failure.
function patchAgentStartupPublication(gatewayDir) {
  const dir=path.join(gatewayDir,"node_modules","openclaw","dist");
  if(!fs.existsSync(dir))return 0;
  const files=fs.readdirSync(dir);
  const contracts=[];
  for(const name of files.filter(name=>/^prepared-model-runtime\.errors-.*\.mjs$/.test(name))){
    const source=fs.readFileSync(path.join(dir,name),"utf8");
    if(!/(?:\bclass\s+PreparedModelRuntimePublicationSupersededError\s+extends\s+|\b(?:var|let|const)\s+PreparedModelRuntimePublicationSupersededError\s*=\s*class\s+extends\s+)/.test(source))continue;
    const aliases=[];
    for(const block of source.matchAll(/\bexport\s*\{([^}]+)\}/g))for(const entry of block[1].split(",")){
      const match=entry.trim().match(/^PreparedModelRuntimePublicationSupersededError(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if(match)aliases.push(match[1]||"PreparedModelRuntimePublicationSupersededError");
    }
    if(/\bexport\s+class\s+PreparedModelRuntimePublicationSupersededError\s+extends\s+/.test(source))aliases.push("PreparedModelRuntimePublicationSupersededError");
    if(aliases.length===1)contracts.push({name,alias:aliases[0]});
  }
  let count=0;
  for(const name of files){
    if(!/^agent-database-startup-.*\.mjs$/.test(name))continue;
    const file=path.join(dir,name);let source=fs.readFileSync(file,"utf8");
    if(!source.includes("await activation.publishAgent(input);")&&!source.includes("/* cryoclaw-startup-publication-retry */"))continue;
    if(contracts.length!==1)throw Error("Prepared model publication error contract changed");
    const errors=contracts[0];
    const importLine=`import { ${errors.alias} as CryoclawPublicationSuperseded } from "./${errors.name}";\n`;
    const oldCatch="catch (error) { if (!(error instanceof CryoclawPublicationSuperseded) || attempt >= 2) throw error; }";
    const newCatch="catch (error) { /* cryoclaw-startup-publication-retry-v2 */ const superseded = error instanceof CryoclawPublicationSuperseded || error instanceof Error && /^Agent [a-z0-9_-]+ (?:startup|secrets) preparation was superseded$/i.test(error.message); if (!superseded || attempt >= 2) throw error; await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); }";
    if(source.includes("/* cryoclaw-startup-publication-retry */")){
      const previous=source;
      const existingImport=/^import \{ [A-Za-z_$][\w$]* as CryoclawPublicationSuperseded \} from "\.\/prepared-model-runtime\.errors-[^"]+";\r?\n/m;
      if(!existingImport.test(source))throw Error("Prepared model publication error import contract changed");
      source=source.replace(existingImport,importLine);
      if(source.includes(oldCatch))source=source.replace(oldCatch,newCatch);
      if(source!==previous)fs.writeFileSync(file,source);
      count++;continue;
    }
    const needle="await activation.publishAgent(input);";
    if(!source.includes(needle))continue;
    const replacement=`/* cryoclaw-startup-publication-retry */\n`+
      `\t\t\t\t\t\t\tfor (let attempt = 0; ; attempt++) {\n`+
      `\t\t\t\t\t\t\t\tassertCurrent();\n`+
      `\t\t\t\t\t\t\t\ttry { await activation.publishAgent(input); break; }\n`+
      `\t\t\t\t\t\t\t\t${newCatch}\n`+
      `\t\t\t\t\t\t\t}`;
    fs.writeFileSync(file,importLine+source.replace(needle,replacement));count++;
  }
  return count;
}

// Reuse the exact completion authority already consulted inside the migration.
// The source marker wins (including explicit false); an unreadable/unknown marker
// keeps the existing migration path. Admission, leases and quarantine stay intact.
function patchWebhookCompletionPrecheck(gatewayDir) {
  const directory=path.join(gatewayDir,"node_modules","openclaw","dist");if(!fs.existsSync(directory))return 0;
  const names=fs.readdirSync(directory),targets=names.filter(name=>/^startup-config-preflight-.*\.mjs$/.test(name));
  if(!targets.length){
    const manifest=path.join(directory,"..","package.json");
    if(fs.existsSync(manifest)&&["2026.10.7","2026.10.9"].includes(JSON.parse(fs.readFileSync(manifest,"utf8")).version))throw Error("Webhook completion precheck coverage missing in pinned kernel");
    return 0;
  }
  const marker="/* cryoclaw-webhook-completion-precheck */";
  const helper=`
${marker}
export function cryoclawReadWebhookCompletion(sourceConfig, env) {
  try {
    if (!sourceConfig || typeof sourceConfig !== "object" || Array.isArray(sourceConfig)) return undefined;
    return sourceConfig.meta?.migrations?.webhookListeners ?? readConfigMachineState(webhookCompletionKey(env), { env });
  } catch { return undefined; }
}
`;
  const implementations=names.filter(name=>/^legacy-webhook-pins-.*\.mjs$/.test(name)).map(name=>({name,source:fs.readFileSync(path.join(directory,name),"utf8")})).filter(file=>file.source.includes("function applyHistoricalWebhookPins("));
  if(implementations.length!==1)throw Error("Webhook completion authority contract changed; review startup precheck");
  const implementation=implementations[0],authority="const marker = mutation.config.meta?.migrations?.webhookListeners ?? readConfigMachineState(webhookCompletionKey(env), { env });";
  const keyContract=/function webhookCompletionKey\(env\) \{\s*return `webhookListeners:\$\{resolveConfigPath\(env\)\}`;\s*\}/;
  if(!implementation.source.includes(authority)||!keyContract.test(implementation.source)||!implementation.source.includes("function recordUnwrittenWebhookCompletion(")||!implementation.source.includes("HISTORICAL_WEBHOOK_CHANNELS as t")||!implementation.source.includes("recordUnwrittenWebhookCompletion as r"))throw Error("Webhook completion authority contract changed; review startup precheck");
  if(implementation.source.includes(marker)&&!implementation.source.includes(helper))throw Error("Webhook completion helper contract changed; review startup precheck");
  const original="const webhookCompletion = read.snapshot.sourceConfig.meta?.migrations?.webhookListeners;";
  const replacement=`const webhookCompletion = ${marker} cryoclawReadWebhookCompletion(read.snapshot.sourceConfig, env);`;
  const importPattern=/const \{ HISTORICAL_WEBHOOK_CHANNELS, recordUnwrittenWebhookCompletion \} = await import\("\.\/(legacy-webhook-pins-[A-Za-z0-9_-]+\.mjs)"\);/;
  const newImport=`const { t: HISTORICAL_WEBHOOK_CHANNELS, r: recordUnwrittenWebhookCompletion, cryoclawReadWebhookCompletion } = await import("./${implementation.name}");`;
  const guard="if (webhookCompletion !== true && !HISTORICAL_WEBHOOK_CHANNELS.every((id) => Object.hasOwn(webhookCompletion ?? {}, id))) {";
  const writes=[];
  for(const name of targets){
    const file=path.join(directory,name),source=fs.readFileSync(file,"utf8");
    if(!source.includes(guard)||!source.match(/await import\("\.\/doctor-contract-registry-[A-Za-z0-9_-]+\.mjs"\)/))throw Error("Webhook migration preflight contract changed; review startup precheck");
    if(source.includes(marker)){
      if(!source.includes(replacement)||!source.includes(newImport)||!implementation.source.includes(helper))throw Error("Webhook completion patched contract changed; review startup precheck");
      continue;
    }
    const imported=source.match(importPattern);
    if(!imported||source.split(original).length!==2)throw Error("Webhook completion preflight contract changed; review startup precheck");
    // Follow only the known pass-through wrapper, or the authority itself.
    if(imported[1]!==implementation.name){
      const wrapper=path.join(directory,imported[1]);
      if(!fs.existsSync(wrapper)||!fs.readFileSync(wrapper,"utf8").includes(`from "./${implementation.name}"`))throw Error("Webhook completion wrapper contract changed; review startup precheck");
    }
    writes.push({file,source:source.replace(imported[0],newImport).replace(original,replacement)});
  }
  // Validate every target before changing either module. Publishing the helper
  // first also leaves the original caller valid if a later filesystem write fails.
  if(!implementation.source.includes(marker))fs.writeFileSync(path.join(directory,implementation.name),implementation.source+helper,"utf8");
  for(const write of writes)fs.writeFileSync(write.file,write.source,"utf8");
  return targets.length;
}

// Physical filesystem builds need no ASAR identity, peer, walker or scanner
// shims. Keep product behavior separate so packaging cannot re-enable them.
function patchConfiguredTrustedSearchArtifact(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules/openclaw/dist");if(!fs.existsSync(dist))return 0;
  const names=fs.readdirSync(dist),factory=names.find(n=>/^public-artifact-factories-.*\.mjs$/.test(n));let count=0;
  for(const name of names){
    if(!/^runtime-web-tools-.*\.mjs$/.test(name))continue;
    const file=path.join(dist,name);let source=fs.readFileSync(file,"utf8");
    if(source.includes("/* cryoclaw-explicit-trusted-search */")){count++;continue;}
    const marker="async function resolveBundledWebProviders(params) {";if(!source.includes(marker))continue;
    if(!factory||!fs.readFileSync(path.join(dist,factory),"utf8").includes("loadBundledPublicArtifactEntries as t"))throw Error("Public web artifact factory contract changed");
    source=`import { t as cryoclawSearchPublicEntries } from "./${factory}";\n`+source.replace(marker,marker+"\n\tconst explicit = cryoclawExplicitTrustedSearch(params);\n\tif (explicit) return explicit;");
    source+=`
/* cryoclaw-explicit-trusted-search */
function cryoclawExplicitTrustedSearch(params) {
  if(params.kind!=="search")return null;
  const config=params.sourceConfig,id=config.tools?.web?.search?.provider,plugins=config.plugins;
  if(typeof id!=="string"||plugins?.enabled===false||plugins?.entries?.[id]?.enabled!==true||plugins?.deny?.includes(id)||Array.isArray(plugins?.allow)&&plugins.allow.length>0&&!plugins.allow.includes(id))return null;
  const owner=params.context.manifestRegistry?.plugins.find(p=>p.id===id&&p.origin==="global"&&p.trustedOfficialInstall===true);if(!owner)return null;
  try {
    const entries=cryoclawSearchPublicEntries({owner,dirName:id,pluginId:id,env:params.context.env,artifactCandidates:["web-search-contract-api.js"],suffix:"WebSearchProvider",isArtifact:p=>p?.id===id&&["label","hint","placeholder","signupUrl","credentialPath"].every(k=>typeof p[k]==="string")&&Array.isArray(p.envVars)&&p.envVars.every(v=>typeof v==="string")&&["getCredentialValue","setCredentialValue","createTool"].every(k=>typeof p[k]==="function")});
    return entries?.length?entries:null;
  }catch{return null;}
}
`;
    fs.writeFileSync(file,source);count++;
  }
  return count;
}

// Use the native OS canonicalizer for physical Windows paths. All fs-safe
// directory/file identity, no-follow and final-admission checks remain intact.
function patchWindowsFsSafeCanonicalPaths(gatewayDir) {
  const file=path.join(gatewayDir,"node_modules/@openclaw/fs-safe/dist/realpath.js");if(!fs.existsSync(file))return 0;
  const source=fs.readFileSync(file,"utf8"),marker="/* cryoclaw-fs-safe-native-canonical */";if(source.includes(marker))return 1;
  const needle="return native ? fs.realpathSync.native(input) : fs.realpathSync(input);";if(!source.includes(needle))throw Error("fs-safe canonicalization contract changed");
  const replacement=`${marker}
    if (!native && process.platform === "win32" && typeof input === "string" && !/\\.asar[\\\\/]/i.test(input)) {
        try { return fs.realpathSync.native(input); } catch { return fs.realpathSync(input); }
    }
    ${needle}`;
  fs.writeFileSync(file,source.replace(needle,replacement));return 1;
}

function patchSelectiveProviderDiscoveryCapture(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules/openclaw/dist");if(!fs.existsSync(dist))return 0;let count=0;
  for(const name of fs.readdirSync(dist)){
    if(!/^plugin-setup-module-.*\.mjs$/.test(name))continue;
    const file=path.join(dist,name);let source=fs.readFileSync(file,"utf8");if(source.includes("/* cryoclaw-selective-provider-discovery */")){
      const helperStart=source.indexOf("function cryoclawSelectiveProviderDiscovery(record, source, rootDir) {");
      if(helperStart>=0&&!source.includes("const selectiveProviderDiscoveryEntries=")){
        source=source.slice(0,helperStart).replace(/\/\* cryoclaw-selective-provider-discovery \*\/\s*$/,"")+`/* cryoclaw-selective-provider-discovery */
const selectiveProviderDiscoveryEntries={codex:"dist/provider-discovery.js",deepseek:"dist/provider-discovery.js",moonshot:"dist/provider-discovery.js",ollama:"provider-discovery.js"};
function cryoclawSelectiveProviderDiscovery(record, source, rootDir) {
  const relative=selectiveProviderDiscoveryEntries[record.id];
  if(!relative||record.origin!=="global"||record.trustedOfficialInstall!==true||record.enabled===false||record.sourcePreferred===true||typeof record.providerDiscoverySource!=="string"||typeof source!=="string"||typeof rootDir!=="string")return false;
  const normalize=value=>{const resolved=path.resolve(value);return process.platform==="win32"?resolved.toLowerCase():resolved;};
  return normalize(record.providerDiscoverySource)===normalize(source)&&normalize(source)===normalize(path.join(rootDir,relative));
}
`;
        fs.writeFileSync(file,source);
      }
      count++;continue;
    }
    const start=source.indexOf("function getPluginSetupModuleLoader(record, source, rootDir) {");if(start<0)continue;
    const needle="origin: record.origin,\n\t\t\t\tsource,\n\t\t\t\trootDir";const at=source.indexOf(needle,start);if(at<0)throw Error("Provider setup capture contract changed");
    source=source.slice(0,at)+source.slice(at).replace(needle,needle+",\n\t\t\t\tstandalone: cryoclawSelectiveProviderDiscovery(record, source, rootDir)");
    source+=`
/* cryoclaw-selective-provider-discovery */
const selectiveProviderDiscoveryEntries={codex:"dist/provider-discovery.js",deepseek:"dist/provider-discovery.js",moonshot:"dist/provider-discovery.js",ollama:"provider-discovery.js"};
function cryoclawSelectiveProviderDiscovery(record, source, rootDir) {
  const relative=selectiveProviderDiscoveryEntries[record.id];
  if(!relative||record.origin!=="global"||record.trustedOfficialInstall!==true||record.enabled===false||record.sourcePreferred===true||typeof record.providerDiscoverySource!=="string"||typeof source!=="string"||typeof rootDir!=="string")return false;
  const normalize=value=>{const resolved=path.resolve(value);return process.platform==="win32"?resolved.toLowerCase():resolved;};
  return normalize(record.providerDiscoverySource)===normalize(source)&&normalize(source)===normalize(path.join(rootDir,relative));
}
`;
    fs.writeFileSync(file,source);count++;
  }
  return count;
}

function patchWindowsIdleBrokerExit(gatewayDir) {
  const file=path.join(gatewayDir,"node_modules","openclaw","dist","process","spawn-broker","worker.js");
  if(!fs.existsSync(file))return 0;
  const source=fs.readFileSync(file,"utf8"),marker="/* cryoclaw-windows-idle-broker-exit */";
  if(source.includes(marker))return 1;
  const needle="if (owned.size === 0 && starting.size === 0 && !resources?.size && hasLiveOwnedProcessGroupMembers() === false) {";
  if(!source.includes(needle))return 0;
  const replacement=`if (owned.size === 0 && starting.size === 0 && !resources?.size && (${marker} process.platform === "win32" || hasLiveOwnedProcessGroupMembers() === false)) {`;
  fs.writeFileSync(file,source.replace(needle,replacement),"utf8");return 1;
}

function patchPluginCopyBatchLifetime(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules","openclaw","dist");if(!fs.existsSync(dist))return 0;
  const names=fs.readdirSync(dist),marker="/* cryoclaw-plugin-copy-batch */",lookupName=names.find(name=>/^plugin-generation-source-lookup-.*\.mjs$/.test(name)&&fs.readFileSync(path.join(dist,name),"utf8").includes("function createPluginSourceCapture")),artifactName=names.find(name=>/^plugin-generation-artifact-.*\.mjs$/.test(name)&&fs.readFileSync(path.join(dist,name),"utf8").includes("function createPluginGenerationFileCapture"));
  if(!lookupName||!artifactName)return 0;
  const lookupFile=path.join(dist,lookupName),artifactFile=path.join(dist,artifactName);let lookup=fs.readFileSync(lookupFile,"utf8"),artifact=fs.readFileSync(artifactFile,"utf8"),count=0;
  if(!lookup.includes(marker)){
    const required=["copyRootFileSync, createFileSync","const captureFailures = /* @__PURE__ */ new Map();","beginDisposal = () => {\n\t\tdisposed = true;","additions,\n\t\tcapture: acquire"];
    for(const needle of required)if(!lookup.includes(needle))throw Error("Plugin source capture copy-batch contract changed");
    lookup=lookup.replace("copyRootFileSync, createFileSync","copyRootFileSync, createRootFileCopyBatchSync, createFileSync")
      .replace("const captureFailures = /* @__PURE__ */ new Map();",`const captureFailures = /* @__PURE__ */ new Map();\n\tconst copyBatch = ${marker} createRootFileCopyBatchSync();`)
      .replace("beginDisposal = () => {\n\t\tdisposed = true;","beginDisposal = () => {\n\t\tdisposed = true;\n\t\tcopyBatch.close();")
      .replace("additions,\n\t\tcapture: acquire","additions,\n\t\tcopyBatch,\n\t\tcapture: acquire");
    fs.writeFileSync(lookupFile,lookup);count++;
  }
  if(!artifact.includes(marker)){
    const needle=`return (source, target) => {\n\t\ttry {\n\t\t\tvar _usingCtx$1 = _usingCtx();\n\t\t\tconst batch = _usingCtx$1.u(createRootFileCopyBatchSync());\n\t\t\treturn copy(source, target, batch.copyFile.bind(batch));\n\t\t} catch (_) {\n\t\t\t_usingCtx$1.e = _;\n\t\t} finally {\n\t\t\t_usingCtx$1.d();\n\t\t}\n\t};`;
    if(!artifact.includes(needle))throw Error("Plugin generation copy-batch contract changed");
    artifact=artifact.replace(needle,`${marker}\n\treturn (source, target) => copy(source, target, sourceCapture.copyBatch.copyFile.bind(sourceCapture.copyBatch));`)
      .replace('import { createRootFileCopyBatchSync } from "@openclaw/fs-safe/advanced";\n',"");
    fs.writeFileSync(artifactFile,artifact);count++;
  }
  return Number(lookup.includes(marker))+Number(artifact.includes(marker));
}

function patchPluginSmallSourceRevalidation(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules","openclaw","dist");if(!fs.existsSync(dist))return 0;
  const marker="/* cryoclaw-plugin-small-source-revalidation */",names=fs.readdirSync(dist).filter(name=>/^plugin-generation-source-lookup-.*\.mjs$/.test(name)&&fs.readFileSync(path.join(dist,name),"utf8").includes("function copySmallPluginSourceFile"));
  if(names.length>1)throw Error("Plugin small source revalidation contract changed: ambiguous modules");if(!names.length)return 0;
  const file=path.join(dist,names[0]);let source=fs.readFileSync(file,"utf8");
  const needle=`\t\tconst assertSource = () => withPluginSourceFile(source, boundary, (currentFd) => {\n\t\t\tconst current = fs.fstatSync(currentFd, { bigint: true });\n\t\t\tconst before = pluginSourceStatIdentity(admitted);\n\t\t\tconst after = pluginSourceStatIdentity(current);\n\t\t\tif (before !== after && !pluginSourceIdentityChangedOnlyByCtime(before, after)) throw new FsSafeError(current.size > admitted.size ? "too-large" : "path-mismatch", "Plugin source changed while preparing its reload; retry after the edit finishes.");\n\t\t});`;
  const replacement=`\t\tconst sourceBoundary = cryoclawPluginCanonicalRoot(boundary) ?? cryoclawPluginRealpath(boundary);\n\t\tconst canonicalSource = cryoclawPluginRealpath(source);\n\t\tconst boundaryIdentity = fs.lstatSync(sourceBoundary, { bigint: true });\n\t\tconst directSource = ${marker} process.platform === "win32" && process.env.CRYOCLAW_PLUGIN_SMALL_SOURCE_REVALIDATION !== "0" && canonicalSource === source && sourceBoundary === cryoclawPluginRealpath(boundary) && isPathInside(sourceBoundary, source) && boundaryIdentity.isDirectory() && !boundaryIdentity.isSymbolicLink();\n\t\tconst before = pluginSourceStatIdentity(admitted);\n\t\tconst assertSource = () => {\n\t\t\tif (!directSource) return withPluginSourceFile(source, boundary, (currentFd) => {\n\t\t\t\tconst current = fs.fstatSync(currentFd, { bigint: true });\n\t\t\t\tconst after = pluginSourceStatIdentity(current);\n\t\t\t\tif (before !== after && !pluginSourceIdentityChangedOnlyByCtime(before, after)) throw new FsSafeError(current.size > admitted.size ? "too-large" : "path-mismatch", "Plugin source changed while preparing its reload; retry after the edit finishes.");\n\t\t\t});\n\t\t\tconst root = fs.lstatSync(sourceBoundary, { bigint: true });\n\t\t\tif (!root.isDirectory() || root.isSymbolicLink() || root.dev !== boundaryIdentity.dev || root.ino !== boundaryIdentity.ino || cryoclawPluginRealpath(source) !== canonicalSource) throw new FsSafeError("path-mismatch", "Plugin source changed while preparing its reload; retry after the edit finishes.");\n\t\t\tfor (const current of [fs.lstatSync(source, { bigint: true }), fs.fstatSync(fd, { bigint: true })]) {\n\t\t\t\tconst after = pluginSourceStatIdentity(current);\n\t\t\t\tif (before !== after && !pluginSourceIdentityChangedOnlyByCtime(before, after)) throw new FsSafeError(current.size > admitted.size ? "too-large" : "path-mismatch", "Plugin source changed while preparing its reload; retry after the edit finishes.");\n\t\t\t}\n\t\t};`;
  if(source.includes(marker)){
    if(!source.includes("CRYOCLAW_PLUGIN_SMALL_SOURCE_REVALIDATION"))source=source.replace("process.platform === \"win32\" && canonicalSource === source","process.platform === \"win32\" && process.env.CRYOCLAW_PLUGIN_SMALL_SOURCE_REVALIDATION !== \"0\" && canonicalSource === source");
    for(const required of ["const current = fs.fstatSync(currentFd, { bigint: true });","if (!directSource) return withPluginSourceFile","fs.fstatSync(fd, { bigint: true })"])if(!source.includes(required))throw Error("Plugin small source revalidation contract changed");
  }else{
    if(!source.includes(needle))throw Error("Plugin small source revalidation contract changed");
    source=source.replace(needle,replacement);
  }
  const syntax=require("node:child_process").spawnSync(process.execPath,["--input-type=module","--check"],{input:source,encoding:"utf8"});
  if(syntax.status!==0)throw Error("Small source revalidation patch generated invalid ESM: "+syntax.stderr.slice(-600));
  if(!source.includes(marker))throw Error("Plugin small source revalidation patch was not applied");
  if(fs.readFileSync(file,"utf8")!==source)fs.writeFileSync(file,source,"utf8");return 1;
}

function patchUsageSessionContextOverlap(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules","openclaw","dist");if(!fs.existsSync(dist))return 0;
  const marker="/* cryoclaw-usage-context-overlap */",names=fs.readdirSync(dist).filter(name=>/^usage-.*\.mjs$/.test(name)&&fs.readFileSync(path.join(dist,name),"utf8").includes("loadUsageSessionSummaries")&&fs.readFileSync(path.join(dist,name),"utf8").includes("loadUsageSessionContext"));
  if(names.length>1)throw Error("Usage context overlap contract changed: ambiguous modules");if(!names.length)return 0;
  const file=path.join(dist,names[0]);let source=fs.readFileSync(file,"utf8");
  const needle=`\t\t\t\t\tconst { summaries: usageByEntryIndex, cacheStatus } = await loadUsageSessionSummaries({\n\t\t\t\t\t\tentries: mergedEntries,\n\t\t\t\t\t\tconfig,\n\t\t\t\t\t\tstartMs,\n\t\t\t\t\t\tendMs,\n\t\t\t\t\t\tincludeUntimestamped,\n\t\t\t\t\t\tdayBucket\n\t\t\t\t\t});\n\t\t\t\t\tawait loadUsageSessionContext(mergedEntries.slice(0, limit), visibilityFilter);`;
  const replacement=`\t\t\t\t\tconst [{ summaries: usageByEntryIndex, cacheStatus }] = await Promise.all([\n\t\t\t\t\t\tloadUsageSessionSummaries({\n\t\t\t\t\t\t\tentries: mergedEntries,\n\t\t\t\t\t\t\tconfig,\n\t\t\t\t\t\t\tstartMs,\n\t\t\t\t\t\t\tendMs,\n\t\t\t\t\t\t\tincludeUntimestamped,\n\t\t\t\t\t\t\tdayBucket\n\t\t\t\t\t\t}),\n\t\t\t\t\t\tloadUsageSessionContext(mergedEntries.slice(0, limit), visibilityFilter)\n\t\t\t\t\t]); ${marker}`;
  if(source.includes(marker)){
    if(!source.includes("const [{ summaries: usageByEntryIndex, cacheStatus }] = await Promise.all(["))throw Error("Usage context overlap contract changed");
  }else{
    if(!source.includes(needle))throw Error("Usage context overlap contract changed");
    source=source.replace(needle,replacement);
  }
  const syntax=require("node:child_process").spawnSync(process.execPath,["--input-type=module","--check"],{input:source,encoding:"utf8"});
  if(syntax.status!==0)throw Error("Usage context overlap patch generated invalid ESM: "+syntax.stderr.slice(-600));
  if(!source.includes(marker))throw Error("Usage context overlap patch was not applied");
  if(fs.readFileSync(file,"utf8")!==source)fs.writeFileSync(file,source,"utf8");return 1;
}

function patchCommandCatalogCache(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules","openclaw","dist");if(!fs.existsSync(dist))return 0;
  const names=fs.readdirSync(dist),find=(prefix,contract)=>{const name=names.find(candidate=>candidate.startsWith(prefix)&&candidate.endsWith(".mjs")&&(!contract||fs.readFileSync(path.join(dist,candidate),"utf8").includes(contract)));if(!name)throw Error(`Command cache dependency changed: ${prefix}`);return name;};
  const runtimeModule=find("runtime-","getActivePluginRegistryVersion as d"),runtimeImport=`import { d as cryoclawPluginRegistryVersion } from "./${runtimeModule}";`;
  const marker="/* cryoclaw-command-catalog-cache */";let count=0;
  for(const name of names){
    if(!/^commands-list-result-.*\.mjs$/.test(name))continue;
    const file=path.join(dist,name);let source=fs.readFileSync(file,"utf8");
    if(source.includes(marker)){
      const previous=source;source=source.replace(/import \{ d as cryoclawPluginRegistryVersion \} from "\.\/runtime-[^"]+";/,runtimeImport);
      if(source!==previous)fs.writeFileSync(file,source);count++;continue;
    }
    const needle="async function buildCommandsListResult(params) {";if(!source.includes(needle))continue;
    const imports=[
      `import { a as cryoclawSkillsSourceVersion, i as cryoclawSkillsSnapshotVersion } from "./${find("refresh-state-")}";`,
      runtimeImport,
      `import { d as cryoclawAgentWorkspaceDir } from "./${find("agent-scope-config-")}";`,
      `import { c as cryoclawConfigFingerprint } from "./${find("workspace-skill-loader-")}";`,
    ].join("\n");
    const helper=`
${marker}
function createCryoclawCommandCache(deps) {
  const cache=new Map(),ttlMs=5000,maxEntries=16;
  const key=(params)=>JSON.stringify([
    deps.configFingerprint(params.cfg),params.agentId,params.provider?.trim().toLowerCase()||"",params.scope??"both",params.includeArgs!==false,params.sessionKey??null,params.sessionEntry?.skillLibrarySelections??null,
    deps.sourceVersion(deps.workspaceDir(params.cfg,params.agentId)),deps.snapshotVersion(deps.workspaceDir(params.cfg,params.agentId)),deps.registryVersion()
  ]);
  const prune=()=>{while(cache.size>maxEntries)cache.delete(cache.keys().next().value);};
  return {async run(params,build){
    const before=key(params),now=Date.now(),existing=cache.get(before);
    if(existing&&now-existing.at<=ttlMs)return existing.promise;
    if(existing)cache.delete(before);
    const promise=(async()=>{
      const result=await build();
      if(key(params)!==before){cache.delete(before);return null;}
      cache.set(before,{at:Date.now(),promise:Promise.resolve(result)});prune();return result;
    })();
    cache.set(before,{at:Number.POSITIVE_INFINITY,promise});prune();
    try{const result=await promise;if(result===null)return this.run(params,build);return result;}
    catch(error){if(cache.get(before)?.promise===promise)cache.delete(before);throw error;}
  }};
}
const cryoclawCommandCache=createCryoclawCommandCache({configFingerprint:cryoclawConfigFingerprint,workspaceDir:cryoclawAgentWorkspaceDir,sourceVersion:cryoclawSkillsSourceVersion,snapshotVersion:cryoclawSkillsSnapshotVersion,registryVersion:cryoclawPluginRegistryVersion});
async function buildCommandsListResult(params) { return cryoclawCommandCache.run(params,()=>buildCommandsListResultUncached(params)); }
`;
    source=imports+"\n"+source.replace(needle,"async function buildCommandsListResultUncached(params) {")+helper;
    fs.writeFileSync(file,source);count++;
  }
  const manifest=path.join(dist,"..","package.json");if(fs.existsSync(manifest)&&["2026.10.7","2026.10.9"].includes(JSON.parse(fs.readFileSync(manifest,"utf8")).version)&&count<1)throw Error("Command catalog cache did not cover the pinned kernel");
  return count;
}

function patchDesktopKernel(gatewayDir) {
  return {
    compatibility: writeKernelCompatibilityMetadata(gatewayDir),
    deliveryHistory: patchDeliverablesHistoryProjection(gatewayDir),
    startupPublication: patchAgentStartupPublication(gatewayDir),
    webhookCompletionPrecheck: patchWebhookCompletionPrecheck(gatewayDir),
    canonicalPaths: patchWindowsPluginCanonicalPaths(gatewayDir),
    fsSafeCanonical: patchWindowsFsSafeCanonicalPaths(gatewayDir),
    trustedSearch: patchConfiguredTrustedSearchArtifact(gatewayDir),
    providerDiscoveryCapture: patchSelectiveProviderDiscoveryCapture(gatewayDir),
    idleBrokerExit: patchWindowsIdleBrokerExit(gatewayDir),
  };
}

function patchLazyControlUiRetention(gatewayDir) {
  const dist=path.join(gatewayDir,"node_modules","openclaw","dist"),marker="/* cryoclaw-lazy-control-ui-retention */";let count=0;
  const lifecycleNeedle=[
    '\t\tif (state.kind === "bundled") await state.retainedAssets?.prepare({ signal }).catch((error) => {',
    '\t\t\tif (isStopped()) return;',
    '\t\t\tconst detail = error instanceof Error ? error.message : String(error);',
    '\t\t\tparams.log.warn(`gateway: Control UI asset retention failed: ${detail}`);',
    '\t\t});'
  ].join("\n");
  const resolveNeedle=`\t\tasync resolveAsset(assetPath) {
\t\t\tconst asset = findAsset(assetPath);
\t\t\tif (asset || !inventory) return asset;
\t\t\tawait inventory.catch(() => void 0);
\t\t\treturn findAsset(assetPath);
\t\t}`;
  const resolveReplacement=`\t\tasync resolveAsset(assetPath, signal) {
\t\t\tconst cached = findAsset(assetPath);
\t\t\tif (cached || inventory) {
\t\t\t\tif (cached) return cached;
\t\t\t\tawait inventory.catch(() => void 0);
\t\t\t\tconst verified = findAsset(assetPath);
\t\t\t\tif (verified) return verified;
\t\t\t}
\t\t\tsignal?.throwIfAborted();
\t\t\t// Retained generations are needed only when the current root misses an asset.
\t\t\tawait prepare({ signal }).catch(error => {
\t\t\t\tlog.warn("Control UI asset retention failed", { error: String(error) });
\t\t\t});
\t\t\tsignal?.throwIfAborted();
\t\t\treturn findAsset(assetPath);
\t\t}`;
  for(const name of fs.existsSync(dist)?fs.readdirSync(dist):[]){
    if(!/^server-control-ui-root-.*\.mjs$/.test(name))continue;
    const file=path.join(dist,name);let source=fs.readFileSync(file,"utf8");
    if(source.includes(marker)){count++;continue;}
    if(!source.includes(lifecycleNeedle)||!source.includes(resolveNeedle)||!source.includes("await root.retainedAssets?.resolveAsset(fileRel)")||!source.includes("function createControlUiAssetRetention(root)"))throw Error("Control UI retention lifecycle contract changed");
    source=source.replace(lifecycleNeedle,"");
    source=source.replace(resolveNeedle,resolveReplacement).replace("await root.retainedAssets?.resolveAsset(fileRel)","await root.retainedAssets?.resolveAsset(fileRel, owner.controller.signal)");
    source+=`\n${marker}\n`;
    const syntax=require("node:child_process").spawnSync(process.execPath,["--input-type=module","--check"],{input:source,encoding:"utf8"});
    if(syntax.status!==0)throw Error("Lazy Control UI retention patch generated invalid ESM: "+syntax.stderr.slice(-600));
    fs.writeFileSync(file,source,"utf8");count++;
  }
  const manifest=path.join(dist,"..","package.json");if(fs.existsSync(manifest)&&["2026.10.7","2026.10.9"].includes(JSON.parse(fs.readFileSync(manifest,"utf8")).version)&&count!==1)throw Error("Lazy Control UI retention patch must cover exactly one pinned module");
  return count;
}

function patchPhysicalDesktopKernel(gatewayDir) {
  return {
    ...patchDesktopKernel(gatewayDir),
    pluginCopyBatchLifetime: patchPluginCopyBatchLifetime(gatewayDir),
    pluginSmallSourceRevalidation: patchPluginSmallSourceRevalidation(gatewayDir),
    usageSessionContextOverlap: patchUsageSessionContextOverlap(gatewayDir),
    commandCatalogCache: patchCommandCatalogCache(gatewayDir),
    lazyControlUiRetention: patchLazyControlUiRetention(gatewayDir),
  };
}

module.exports = {
  patchSelectiveProviderDiscoveryCapture,
  patchConfiguredTrustedSearchArtifact,
  patchWindowsFsSafeCanonicalPaths,
  patchWindowsIdleBrokerExit,
  patchCommandCatalogCache,
  patchPluginCopyBatchLifetime,
  patchPluginSmallSourceRevalidation,
  patchUsageSessionContextOverlap,
  patchLazyControlUiRetention,
  patchDesktopKernel,
  patchPhysicalDesktopKernel,
  patchAgentStartupPublication,
  patchWebhookCompletionPrecheck,
  writeKernelCompatibilityMetadata,
  patchImmutableSkillsWatch,
  patchWindowsPluginCanonicalPaths,
  patchPluginAsarBoundaryScan,
  patchPluginPeerAsarLink,
  patchWindowsOpenclawArtifacts,
  patchWindowsHideGlobal,
  injectWindowsHideAll,
  collectJsFilesRecursive,
  patchAsarBoundaryCheck,
  hasAsarBoundaryPatchMarker,
  assertAsarBoundaryCoverage,
  patchKimiThinkingProfile,
  patchFsSafeAsarUnpacked,
  patchFsSafeAsarWalk,
  patchPluginArtifactAsarIdentity,
  patchPluginNativeAsarHost,
  patchDeliverablesHistoryProjection,
};
