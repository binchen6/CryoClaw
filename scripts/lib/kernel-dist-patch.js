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
//   openclaw ≥2026.9.2：上述函数全部迁出 openclaw dist chunk，落到独立 npm 包
//     @openclaw/fs-safe/dist/*.js（root-file.js / pinned-open.js / regular-file.js /
//     file-identity.js），openclaw chunk 经 "@openclaw/fs-safe/advanced" import。
//     因此扫描范围扩展到 fs-safe 包目录；v9 的 readRegularFileSync/readRegularFile
//     改为内联 inspectFileIdentitySync 三次观测（verifyStableReadTarget 已不存在），
//     需按函数头注入 asar 快速通道。
//
// 返回补丁的文件数；0 表示上游结构不匹配（调用方应结合 assertAsarBoundaryCoverage 判断）。

function patchAsarBoundaryCheck(gatewayDir) {
  const distDir = path.join(gatewayDir, "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) return 0;

  // 扫描 dist 根下所有 .js chunk，按函数标记注入（hash 文件名随版本变化）。
  // openclaw ≥2026.9.2 起边界校验函数住在 @openclaw/fs-safe 包里，需一并扫描
  // （只扫该包 dist 根一层——fs-safe 的源码形态是散文件，不是 chunk）。
  const candidateFiles = [];
  for (const fileName of fs.readdirSync(distDir)) {
    if (fileName.endsWith(".js")) {
      candidateFiles.push({ filePath: path.join(distDir, fileName), root: "openclaw" });
    }
  }
  const fsSafeDist = path.join(gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist");
  if (fs.existsSync(fsSafeDist)) {
    for (const fileName of fs.readdirSync(fsSafeDist)) {
      if (fileName.endsWith(".js")) {
        candidateFiles.push({ filePath: path.join(fsSafeDist, fileName), root: "fs-safe" });
      }
    }
  }
  if (candidateFiles.length === 0) {
    return 0;
  }

  let patched = 0;
  for (const { filePath, root } of candidateFiles) {
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
          "\t/* asar-bypass */ if (typeof params.filePath === 'string' && params.filePath.includes('.asar')) {",
          "\t\tconst stat = fsSync.statSync(params.filePath);",
          "\t\tif (params.maxBytes !== undefined && stat.size > params.maxBytes) throw regularFileTooLargeError(params.filePath, params.maxBytes);",
          "\t\treturn fsSync.readFileSync(params.filePath);",
          "\t}",
        ].join("\n");
        result = result.replace(readRegularSyncMarker, readRegularSyncBypass);
      }
      const readRegularAsyncMarker = "async function readRegularFile(params) {";
      if (result.includes(readRegularAsyncMarker)) {
        const readRegularAsyncBypass = [
          "async function readRegularFile(params) {",
          "\t/* asar-bypass-async */ if (typeof params.filePath === 'string' && params.filePath.includes('.asar')) {",
          "\t\tconst stat = await fs.stat(params.filePath);",
          "\t\tif (params.maxBytes !== undefined && stat.size > params.maxBytes) throw regularFileTooLargeError(params.filePath, params.maxBytes);",
          "\t\treturn await fs.readFile(params.filePath);",
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
      if (!fileName.endsWith(".js")) continue;
      const source = fs.readFileSync(path.join(dir, fileName), "utf-8");
      if (markers.some((m) => source.includes(m))) return true;
    }
  }
  return false;
}

// 内核形态感知的补丁覆盖断言（R19：验证终点必须是产物/树内内容断言）。
// R56 事故：v9 内核把边界校验函数迁到 @openclaw/fs-safe 包，旧扫描只看 openclaw
// dist chunk → 补丁计数 >0（仅 peer-link 命中）但关键快速通道全部漏打，渠道插件
// 全崩。这里按形态强制校验关键文件确已带补丁：
//   v9（fs-safe root-file.js 存在）：root-file.js 必须含 asar-bypass。
//   v8（无 fs-safe 包）：任一 openclaw dist chunk 含 asar-bypass（原逻辑）。
// 未覆盖时抛 Error，调用方中止打包/升级。
function assertAsarBoundaryCoverage(gatewayDir) {
  const fsSafeRootFile = path.join(
    gatewayDir, "node_modules", "@openclaw", "fs-safe", "dist", "root-file.js"
  );
  if (fs.existsSync(fsSafeRootFile)) {
    const source = fs.readFileSync(fsSafeRootFile, "utf-8");
    if (source.includes("/* asar-bypass */")) return;
    throw new Error(
      "@openclaw/fs-safe/dist/root-file.js 缺少 asar 快速通道补丁（上游结构变化？），中止"
    );
  }
  if (hasAsarBoundaryPatchMarker(gatewayDir)) return;
  throw new Error("ASAR 边界校验补丁未命中任何模块（openclaw 上游结构变化？）");
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
  const legacyDecl = [
    "let realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);",
    "\t\t/* cryoclaw-asar-unpacked */ realPath = mapAsarUnpackedPath(ioFs, realPath);",
  ].join("\n");
  source = source.replace(legacyDecl, origDecl);
  source = source.replace(
    /\n\/\* cryoclaw-asar-unpacked \*\/\nfunction mapAsarUnpackedPath[\s\S]*?\n\}\n/,
    "\n"
  );

  // 两次 lstatSync(realPath, { bigint: true }) 是身份观测点（preOpen + 读前复核）；
  // rejectPathSymlink 的 lstatSync(params.filePath) 不做身份比对，不动。
  const statMarker = "ioFs.lstatSync(realPath, { bigint: true })";
  if (!source.includes(origDecl) || !source.includes(statMarker)) return 0;
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

module.exports = {
  patchWindowsOpenclawArtifacts,
  patchWindowsHideGlobal,
  injectWindowsHideAll,
  collectJsFilesRecursive,
  patchAsarBoundaryCheck,
  hasAsarBoundaryPatchMarker,
  assertAsarBoundaryCoverage,
  patchKimiThinkingProfile,
  patchFsSafeAsarUnpacked,
};
