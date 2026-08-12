// 运行时内核升级的树裁剪共享模块 —— 由 kernel-update.mjs 在 npm 安装新内核后、
// 搬运 CryoClaw 注入物前调用，与打包期 package-resources.js 的裁剪保持一致，
// 避免运行时升级后的 gateway.asar 比出厂版本膨胀上百 MB。
//
// 裁剪范围严格限定为"与 CryoClaw 业务无关的纯死重"，不含任何 CryoClaw 专属白名单
// （openclaw skills/extensions/docs 的保留策略只存在于打包期，升级器不复制它们，
// 防止两份白名单漂移后运行时升级误删功能）：
//   - koffi 非本机平台 native binary
//   - @ffmpeg-installer / @ffprobe-installer 预编译二进制（各 35-80MB）
//   - pdf-parse 冗余 pdf.js 历史版本（约 13MB）
//   - 非本机平台 prebuilds（node-pty 等）
//   - 嵌套 node_modules 里的非本机平台原生包（@lydell/node-pty-<os>-<arch> 等）
//   - darwin-universal 原生包（仅 darwin 目标）
//   - node-llama-cpp（仅当旧内核树中本就没有——即出厂构建已裁掉时）
//   - 通用垃圾：.map / .d.ts / .test. / .spec. / 文档与测试目录
//
// 零依赖（仅 fs/path + 同级 rm-rec.js），工厂函数接收 fs 实现（kernel-update.mjs
// 传 original-fs，测试传普通 fs），可在系统 node 与 ELECTRON_RUN_AS_NODE 下运行。

"use strict";

const path = require("path");
const rmRecursiveFactory = require("./rm-rec");

const KOFFI_PLATFORM_MAP = {
  "darwin-x64": "darwin_x64",
  "darwin-arm64": "darwin_arm64",
  "win32-x64": "win32_x64",
  "win32-arm64": "win32_arm64",
};

// 与 package-resources.js 保持一致的原生平台包前缀
const NATIVE_NAME_PREFIX = [
  "sharp-",
  "sharp-libvips-",
  "node-pty-",
  "sqlite-vec-",
  "canvas-",
  "reflink-",
  "clipboard-",
];

// 通用垃圾目录名（与打包期 junkDirs 对齐；不含 openclaw 专属策略）
const JUNK_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "coverage",
  "docs",
  "examples",
  ".github",
  ".vscode",
  "benchmark",
  "benchmarks",
]);

const JUNK_DOC_BASES = new Set([
  "readme",
  "changelog",
  "history",
  "authors",
  "contributors",
  "license",
  "licence",
  "contributing",
]);
const JUNK_DOC_EXTENSIONS = new Set(["", ".md", ".txt", ".markdown", ".rst"]);

module.exports = function createKernelPrune(fs) {
  const rmRecursive = rmRecursiveFactory(fs);

  function getDirSize(dir) {
    let total = 0;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // 忽略单文件 stat 异常
        }
      }
    }
    return total;
  }

  // 收集 node_modules 第一层包（含 @scope 下子包）
  function collectTopLevelPackages(nmDir) {
    let entries;
    try {
      entries = fs.readdirSync(nmDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const packages = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(nmDir, entry.name);
      if (entry.name.startsWith("@")) {
        for (const child of fs.readdirSync(abs, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          packages.push({ name: child.name, dir: path.join(abs, child.name) });
        }
      } else {
        packages.push({ name: entry.name, dir: abs });
      }
    }
    return packages;
  }

  function parseNativePackageTarget(name) {
    if (!NATIVE_NAME_PREFIX.some((prefix) => name.startsWith(prefix))) return null;
    const match = name.match(/-(darwin|linux|win32)-([a-z0-9_-]+)/i);
    if (!match) return null;
    return { platform: match[1], arch: match[2].split("-")[0] };
  }

  // ── 各裁剪步骤（全部幂等、缺失即跳过，任何单步失败不中断整体升级） ──

  function makeSteps(nmDir, platform, arch, keepLlama) {
    const openclawDocsDir = path.join(nmDir, "openclaw", "docs");

    function removeDirTracked(dir, stats) {
      if (!fs.existsSync(dir)) return 0;
      const bytes = getDirSize(dir);
      rmRecursive(dir);
      stats.removedDirs += 1;
      stats.bytes += bytes;
      return bytes;
    }

    return [
      // koffi：仅保留本机平台 native binary
      function pruneKoffi(stats) {
        const koffiBuildsDir = path.join(nmDir, "koffi", "build", "koffi");
        if (!fs.existsSync(koffiBuildsDir)) return;
        const keepDir = KOFFI_PLATFORM_MAP[`${platform}-${arch}`];
        if (!keepDir) return;
        for (const entry of fs.readdirSync(koffiBuildsDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name !== keepDir) {
            removeDirTracked(path.join(koffiBuildsDir, entry.name), stats);
          }
        }
      },

      // ffmpeg/ffprobe 预编译二进制（与打包期一致：视频缩略图降级但不崩溃）
      function pruneFFmpeg(stats) {
        for (const scope of ["@ffmpeg-installer", "@ffprobe-installer"]) {
          removeDirTracked(path.join(nmDir, scope), stats);
        }
      },

      // pdf-parse 冗余 pdf.js 版本，保留语义最新版
      function prunePdfParse(stats) {
        const pdfJsDir = path.join(nmDir, "pdf-parse", "lib", "pdf.js");
        if (!fs.existsSync(pdfJsDir)) return;
        let entries;
        try {
          entries = fs.readdirSync(pdfJsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name.startsWith("v"));
        } catch {
          return;
        }
        if (entries.length <= 1) return;
        entries.sort((a, b) => {
          const va = a.name.slice(1).split(".").map(Number);
          const vb = b.name.slice(1).split(".").map(Number);
          for (let i = 0; i < Math.max(va.length, vb.length); i++) {
            if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
          }
          return 0;
        });
        for (let i = 1; i < entries.length; i++) {
          removeDirTracked(path.join(pdfJsDir, entries[i].name), stats);
        }
      },

      // 非本机平台 prebuilds
      function prunePrebuilds(stats) {
        const targetName = `${platform}-${arch}`;
        for (const pkg of collectTopLevelPackages(nmDir)) {
          const prebuildsDir = path.join(pkg.dir, "prebuilds");
          if (!fs.existsSync(prebuildsDir)) continue;
          for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === targetName) continue;
            removeDirTracked(path.join(prebuildsDir, entry.name), stats);
          }
        }
      },

      // 嵌套 node_modules 里的非本机平台原生包（与 package-resources 的
      // pruneNonTargetNativePlatformPackages 对齐）。collectTopLevelPackages 只看
      // 第一层，openclaw/node_modules/@lydell/node-pty-<os>-<arch> 这类嵌套平台包
      // 会被 npm install 全平台装进来（win32-arm64 单个约 11MB），需递归逐层清理。
      // 同时清理树内 .pdb 调试符号（R15，与打包期口径一致）。
      function pruneNonTargetNativePackages(stats) {
        // 广度优先收集所有 node_modules 目录（含嵌套）+ .pdb 文件
        const nodeModulesDirs = [nmDir];
        const stack = [nmDir];
        while (stack.length > 0) {
          const dir = stack.pop();
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              stack.push(full);
              if (entry.name === "node_modules") nodeModulesDirs.push(full);
              continue;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdb")) {
              try {
                const bytes = fs.statSync(full).size;
                fs.unlinkSync(full);
                stats.removedDirs += 1;
                stats.bytes += bytes;
              } catch { /* 占用等场景静默跳过 */ }
            }
          }
        }

        for (const nodeModulesDir of nodeModulesDirs) {
          for (const pkg of collectTopLevelPackages(nodeModulesDir)) {
            const target = parseNativePackageTarget(pkg.name);
            if (!target) continue;
            if (target.platform === platform && target.arch === arch) continue;
            removeDirTracked(pkg.dir, stats);
          }
        }
      },

      // darwin 目标移除 universal 原生包
      function pruneDarwinUniversal(stats) {
        if (platform !== "darwin") return;
        for (const item of collectTopLevelPackages(nmDir)) {
          const target = parseNativePackageTarget(item.name);
          if (!target) continue;
          if (target.platform === "darwin" && target.arch === "universal") {
            removeDirTracked(item.dir, stats);
          }
        }
      },

      // llama：仅当旧内核树中已被裁掉（keepLlama=false）时才移除新装的
      function pruneLlama(stats) {
        if (keepLlama) return;
        removeDirTracked(path.join(nmDir, "node-llama-cpp"), stats);
        removeDirTracked(path.join(nmDir, "@node-llama-cpp"), stats);
      },

      // 通用垃圾文件/目录递归清理。
      // openclaw/docs 整目录豁免（内含运行时模板 reference/templates，升级器不
      // 复制打包期的模板保留裁剪逻辑，直接保留全部，代价仅几 MB）。
      function pruneJunk(stats) {
        function isTypeDeclarationFile(nameLower) {
          return (
            nameLower.endsWith(".d.ts") ||
            nameLower.endsWith(".d.mts") ||
            nameLower.endsWith(".d.cts")
          );
        }
        function isTestArtifactFile(nameLower) {
          return nameLower.includes(".test.") || nameLower.includes(".spec.");
        }
        function isJunkDocFile(nameLower) {
          const parsed = path.parse(nameLower);
          return JUNK_DOC_BASES.has(parsed.name) && JUNK_DOC_EXTENSIONS.has(parsed.ext);
        }
        function isIgnoredJunkDir(dirName) {
          return dirName === ".ignored" || dirName.startsWith(".ignored_");
        }

        function walk(dir) {
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (fullPath === openclawDocsDir) continue; // 整目录豁免
              if (JUNK_DIRS.has(entry.name) || isIgnoredJunkDir(entry.name)) {
                removeDirTracked(fullPath, stats);
                continue;
              }
              walk(fullPath);
              continue;
            }
            const nameLower = entry.name.toLowerCase();
            if (
              isTypeDeclarationFile(nameLower) ||
              nameLower.endsWith(".map") ||
              isTestArtifactFile(nameLower) ||
              isJunkDocFile(nameLower)
            ) {
              try {
                stats.bytes += fs.statSync(fullPath).size;
                fs.unlinkSync(fullPath);
                stats.removedFiles += 1;
              } catch {
                // 忽略单文件删除异常
              }
            }
          }
        }

        walk(nmDir);
      },
    ];
  }

  /**
   * 裁剪 gateway 散文件树的 node_modules。
   * @param {string} gatewayDir gateway 散文件目录（内含 node_modules）
   * @param {object} [opts]
   * @param {string} [opts.platform] 目标平台，默认 process.platform
   * @param {string} [opts.arch] 目标架构，默认 process.arch
   * @param {boolean} [opts.keepLlama] 旧内核树中是否保留了 llama 依赖
   * @returns {{removedDirs:number, removedFiles:number, bytes:number, errors:string[]}}
   */
  function pruneGatewayTree(gatewayDir, opts = {}) {
    const platform = opts.platform || process.platform;
    const arch = opts.arch || process.arch;
    const keepLlama = !!opts.keepLlama;
    const nmDir = path.join(gatewayDir, "node_modules");
    const stats = { removedDirs: 0, removedFiles: 0, bytes: 0, errors: [] };
    if (!fs.existsSync(nmDir)) return stats;

    for (const step of makeSteps(nmDir, platform, arch, keepLlama)) {
      try {
        step(stats);
      } catch (err) {
        // 裁剪是体积优化而非功能必需——单步失败只记录，不阻断升级
        stats.errors.push(`${step.name}: ${err && err.message ? err.message : String(err)}`);
      }
    }
    return stats;
  }

  return { pruneGatewayTree };
};
