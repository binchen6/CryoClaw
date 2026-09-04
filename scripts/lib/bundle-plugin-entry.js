"use strict";

// ─── Plugin entry standardizer ────────────────────────────────────────────
//
// openclaw 插件的入口可能是 .ts / .mjs / .js / .cjs。openclaw gateway 内部有多
// 份独立的 jiti loader cache（`const jitiLoaders = new Map()` 在 dist/ 的多份
// chunk 里各声明一次）。.ts 入口走 jiti transpile 路径，每份 cache 独立 eval
// 一次——同一个 plugin 模块被实例化成 N 份 "不同" 的 module instance，模块级
// 变量（比如 `let weixinRuntime`）互相不可见。.mjs/.js/.cjs 入口走 Node 原生
// `createRequire`，一份 Node module cache 全局共享，单例天然成立。
//
// 本模块负责构建期强制把每个 CryoClaw 打包的插件入口标准化成 `.mjs`——
// 已是 native 形态的直接 skip；.ts 入口就用 esbuild bundle 到
// `dist/cryoclaw-bundle.mjs` 并重写所有 "指向入口" 的字段（manifest.main /
// package.json main / package.json openclaw.extensions[0]），让 openclaw
// 的 entry resolver 无论走哪条路径都拿到 .mjs。

const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_FILE = "openclaw.plugin.json";
const PACKAGE_FILE = "package.json";
const BUNDLE_REL = path.join("dist", "cryoclaw-bundle.mjs");

// esbuild platform:node + format:esm 输出里，被 bundle 的 CJS 依赖残留的动态 require
// 会变成 __require shim 直接 throw（"Dynamic require of \"crypto\" is not supported"）。
// esbuild 的 __require shim 在调用时先查 `typeof require !== "undefined"`——banner 里
// 用 createRequire 在模块作用域定义一个真 require，shim 就会优先命中它。
// 顺带注入 __filename/__dirname shim（ESM 产物里这两个 CommonJS 全局不存在）。
// 标识符带 cryoclaw 前缀，避免与 esbuild 生成代码撞名；BUNDLE_BANNER_MARKER 同时
// 用作 isBundleFresh 的新鲜度标记（老构建产物无 banner 一律重 bundle）。
const BUNDLE_BANNER_MARKER = "__cryoclawCreateRequire";
const BUNDLE_BANNER = [
  'import { createRequire as __cryoclawCreateRequire } from "node:module";',
  'import { fileURLToPath as __cryoclawFileURLToPath } from "node:url";',
  'import { dirname as __cryoclawDirname } from "node:path";',
  "const require = __cryoclawCreateRequire(import.meta.url);",
  "const __filename = __cryoclawFileURLToPath(import.meta.url);",
  "const __dirname = __cryoclawDirname(__filename);",
  "",
].join("\n");
const NATIVE_EXT = new Set([".mjs", ".cjs", ".js"]);
// openclaw gateway 2026.4.5 dist/manifest-BLZdOZfM.js:238 的 DEFAULT_PLUGIN_ENTRY_CANDIDATES，
// 顺序至关重要——`index.ts` 排第一，所以 plugin 目录下只要有 index.ts 就会被优先选中。
const FALLBACK_ENTRIES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

function readJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonPretty(absPath, value) {
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

// 严格复刻 openclaw 2026.4.5 的 resolve 逻辑：
//   1. package.json 里 MANIFEST_KEY 字段（即 "openclaw"）下的 `extensions[0]`
//      （见 dist/manifest-BLZdOZfM.js:248 resolvePackageExtensionEntries + :244 getPackageManifestMetadata）
//   2. 上一步 missing/empty 时 fallback 到 DEFAULT_PLUGIN_ENTRY_CANDIDATES
//      （见 dist/manifest-BLZdOZfM.js:238 + dist/ids-Dm8ff2qI.js:818/930）
//
// openclaw 不读 `openclaw.plugin.json#main`，也不读 package.json 的 `main`/`module`——
// 即便它们存在，实际 runtime 只认 `openclaw.extensions` 与 fallback 的 index.* 扫描。
function resolveOpenClawPluginEntry(pluginDir) {
  const pkg = readJson(path.join(pluginDir, PACKAGE_FILE)) || {};
  const rawExt = pkg.openclaw && Array.isArray(pkg.openclaw.extensions)
    ? pkg.openclaw.extensions.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean)
    : [];

  if (rawExt.length > 0) {
    const first = rawExt[0];
    const abs = path.resolve(pluginDir, first);
    if (fs.existsSync(abs)) {
      return { relPath: first.replace(/^\.\//, ""), absPath: abs };
    }
    // openclaw.extensions 指向了一个不存在的文件——继续走 fallback，与 openclaw 行为一致
  }

  for (const fallback of FALLBACK_ENTRIES) {
    const abs = path.join(pluginDir, fallback);
    if (fs.existsSync(abs)) {
      return { relPath: fallback, absPath: abs };
    }
  }

  return null;
}

// 把 package.json 里 openclaw.extensions[0] 指向 bundle 产物。
// vendored npm 形态的官方插件还带 openclaw.runtimeExtensions（与 extensions 等长），
// 内核运行时优先按 runtimeExtensions[i] 加载（见 openclaw dist
// package-entry-resolution-*.js resolvePackageRuntimeEntrySource）——只改
// extensions[0] 会被 runtimeExtensions[0] 盖回旧入口，存在时必须同步改写。
// 其余 manifest.main / pkg.main / pkg.module 是死字段或无关字段，不动，
// 避免引入与其他工具（npm publish、Node require）的未知交互。
function patchPluginEntryFields(pluginDir, newRelPath) {
  const pkgPath = path.join(pluginDir, PACKAGE_FILE);
  const pkg = readJson(pkgPath);
  if (!pkg) return;

  const normalized = `./${newRelPath.replace(/\\/g, "/").replace(/^\.\//, "")}`;

  const openclaw = pkg.openclaw || {};
  const existing = Array.isArray(openclaw.extensions) ? openclaw.extensions : [];
  // 如果 plugin 没写 openclaw.extensions，我们也要补一个——weixin 当前有写，
  // 未来可能有 plugin 没写（走 fallback index.ts）的情况，bundle 后需要
  // 显式指明入口，不然 fallback 会又选回原生 index.ts。
  const next = existing.length > 0
    ? [normalized, ...existing.slice(1)]
    : [normalized];
  const existingRuntime = Array.isArray(openclaw.runtimeExtensions) ? openclaw.runtimeExtensions : [];
  const nextRuntime = existingRuntime.length > 0
    ? [normalized, ...existingRuntime.slice(1)]
    : existingRuntime;
  if (
    next[0] === existing[0] && next.length === existing.length
    && nextRuntime[0] === existingRuntime[0] && nextRuntime.length === existingRuntime.length
  ) {
    return; // 已是目标值，不重复写
  }
  pkg.openclaw = { ...openclaw, extensions: next };
  if (existingRuntime.length > 0) {
    pkg.openclaw.runtimeExtensions = nextRuntime;
  }
  writeJsonPretty(pkgPath, pkg);
}

// 返回 true 表示 bundle 产物已是最新，可跳过。除 mtime 外还要求产物头部带
// banner 标记（BUNDLE_BANNER_MARKER）——老构建产出的无 banner bundle 一律
// 判过期重 bundle，保证新格式淘汰旧产物。
function isBundleFresh(bundlePath, entryPath) {
  if (!fs.existsSync(bundlePath)) return false;
  try {
    const bundleMtime = fs.statSync(bundlePath).mtimeMs;
    const entryMtime = fs.statSync(entryPath).mtimeMs;
    if (bundleMtime < entryMtime) return false;
    const fd = fs.openSync(bundlePath, "r");
    try {
      const head = Buffer.alloc(2048);
      const bytes = fs.readSync(fd, head, 0, head.length, 0);
      return head.subarray(0, bytes).toString("utf-8").includes(BUNDLE_BANNER_MARKER);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// 对单个插件目录确保入口是 **single-file** native 形态。
//
// 为什么不能用上游的原生 `.mjs` 入口？
//   openclaw 的 plugin loader 只给**入口文件**挂 jiti aliasMap（把 `openclaw` →
//   gateway 内部的绝对路径）。入口之后的 chunk 由 Node 原生 `import()` 加载，
//   不经过 aliasMap，所以 chunk 里的 `import "openclaw/plugin-sdk/..."` 会在
//   `~/.openclaw/extensions/<id>/` 附近查 `node_modules/openclaw` 而找不到。
//   上游 `dist/index.mjs` 多半是 multi-chunk bundle（dingtalk 有 27 个 chunk），
//   暴露了这个 resolve 盲区。
//
// 修法：无条件重新 esbuild bundle 成 single-file，保证 `openclaw` 只出现在入口，
// 入口又总是由 jiti loader 加载，aliasMap 100% 生效。
//
//   - 入口不存在        → action = 'missing'（调用方决定是否 fatal）
//   - 所有其他情况      → esbuild bundle → dist/cryoclaw-bundle.mjs，重写
//                         package.json#openclaw.extensions[0] 指向它
//
// opts.allowNativeSkip = true 时保留旧行为（入口已是 .mjs/.js/.cjs 就跳过）——
// 仅用于 openclaw 内置 plugin（如 kimi-search），它们住在 gateway 自己的
// node_modules 里，jiti aliasMap 直接覆盖它们的 runtime require。
//
// opts.entryOverride：显式指定 bundle 入口（相对 pluginDir）。vendored npm 形态
// 的官方插件（如 qqbot）extensions[0] 指向发布包内不存在的源码 ./index.ts，
// 真实运行入口是 openclaw.runtimeExtensions[0]，resolve 不出来，由调用方传入。
// opts.extraExternal：追加的 external 包名（wasm/worker 类依赖留在插件自己的
// node_modules 里，运行时经 banner 的 createRequire / 原生 dynamic import 解析）。
async function ensurePluginNativeEntry(pluginDirInput, opts = {}) {
  // esbuild 的 absWorkingDir 必须绝对路径，调用方可能传相对路径（dev 脚本、测试）
  const pluginDir = path.resolve(pluginDirInput);
  const label = opts.label || path.basename(pluginDir);
  const bundleAbs = path.join(pluginDir, BUNDLE_REL);
  let entry = opts.entryOverride
    ? (() => {
        const rel = opts.entryOverride.replace(/^\.\//, "");
        const abs = path.resolve(pluginDir, rel);
        return fs.existsSync(abs) ? { relPath: rel, absPath: abs } : null;
      })()
    : resolveOpenClawPluginEntry(pluginDir);

  // 增量缓存复用的插件目录里，extensions[0] 可能已是上次 patch 后的 bundle 路径，
  // 即解析到的入口就是 bundle 自身（原始入口字段已被覆盖、无法恢复）。此时若
  // bundle 已过期（entry==bundle 时 isBundleFresh 的 mtime 恒相等，判过期即缺
  // banner 标记的老产物），直接把它原地重 bundle：老产物是完整的 single-file，
  // 重 bundle 内容等价，只是补上 banner（输入无 banner，const require 不会重复
  // 声明）。entry==outfile 需要 allowOverwrite。
  const entryIsStaleBundle = entry
    && path.resolve(entry.absPath) === bundleAbs
    && !isBundleFresh(bundleAbs, bundleAbs);

  if (!entry) {
    return { action: "missing", pluginDir, entry: null };
  }

  const ext = path.extname(entry.relPath).toLowerCase();
  if (opts.allowNativeSkip && NATIVE_EXT.has(ext)) {
    return { action: "skip", pluginDir, entry: entry.relPath };
  }

  // 无条件 esbuild 重 bundle 成 single-file
  if (isBundleFresh(bundleAbs, entry.absPath)) {
    // Bundle 新鲜，但可能上次改了入口字段后 package.json 被 install 重置过。
    // 保险起见再 patch 一次，是幂等的。
    patchPluginEntryFields(pluginDir, BUNDLE_REL);
    return { action: "bundled-reused", pluginDir, entry: entry.relPath, outFile: BUNDLE_REL };
  }

  // 懒加载 esbuild——不是所有构建路径都会用到（Windows arm64 交叉构建有可能被
  // 外层 try/catch 跳过，不要把启动成本强加给每次 `npm run package:resources`）。
  // eslint-disable-next-line global-require
  const esbuild = require("esbuild");

  fs.mkdirSync(path.dirname(bundleAbs), { recursive: true });

  // - `openclaw` 是 peer dep，运行时由 gateway 的 node_modules 提供，不要 bundle
  //   进 plugin（否则会把 gateway 内部 state 复制一份，跟 host 完全脱钩）
  // - `*.node` 是 native addon，esbuild 不能静态分析，保留动态 require
  const external = ["openclaw", "openclaw/*", "*.node", ...(opts.extraExternal || [])];

  try {
    await esbuild.build({
      entryPoints: [entry.absPath],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external,
      outfile: bundleAbs,
      allowOverwrite: entryIsStaleBundle,
      absWorkingDir: pluginDir,
      banner: { js: BUNDLE_BANNER },
      // 插件作者的 tsconfig 可能指向 bundler/esnext-preserve 等奇怪的 target，
      // 强制我们这边的编译语义，避免被上游配置左右。
      tsconfigRaw: JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          jsx: "preserve",
        },
      }),
      logLevel: "warning",
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(`[${label}] esbuild bundle failed for ${entry.relPath}: ${msg}`);
  }

  patchPluginEntryFields(pluginDir, BUNDLE_REL);

  return { action: "bundled", pluginDir, entry: entry.relPath, outFile: BUNDLE_REL };
}

// 把插件 dist/ 下含静态 bare import（默认 "ws"）的 chunk 原地重 bundle。
//
// 为什么需要：qqbot 这类 multi-chunk 插件的懒加载链（loadBundledEntryExportSync
// 的运行时 specifier + `import("./chunk.js")`）绕过入口 bundle，始终从磁盘加载
// 原始 chunk。其中 gateway chunk 静态 `import WebSocket from "ws"` 解析到
// ws@8 exports.import → wrapper.mjs → 深引用 CJS lib 文件，在内核插件加载链
// （jiti 2.7.0）下互操作失败（"./lib/permessage-deflate.js does not provide an
// export named 'default'"）。原地重 bundle 后 ws 被静态内联，运行时不再解析 "ws"。
//
// 相对导入（./xxx.js）必须保持 external：跨 chunk 的模块级单例（runtime store、
// AsyncLocalStorage、logger 等）要继续共享磁盘上的同一份模块，内联会导致状态分裂。
// 扫描式选择天然幂等——重 bundle 过的 chunk 不再含 `from "ws"`，二次运行自动跳过。
async function rebundlePluginDistChunks(pluginDirInput, opts = {}) {
  const pluginDir = path.resolve(pluginDirInput);
  const label = opts.label || path.basename(pluginDir);
  const packages = opts.packages || ["ws"];
  const distDir = path.join(pluginDir, opts.distDir || "dist");
  if (!fs.existsSync(distDir)) return { action: "missing", pluginDir, rebundled: [] };

  const hits = fs.readdirSync(distDir)
    .filter((f) => /\.m?js$/u.test(f) && f !== path.basename(BUNDLE_REL))
    .filter((f) => {
      const src = fs.readFileSync(path.join(distDir, f), "utf-8");
      return packages.some((p) =>
        src.includes(`from "${p}"`) || src.includes(`from '${p}'`) || src.includes(`import("${p}")`));
    });
  if (hits.length === 0) return { action: "none", pluginDir, rebundled: [] };

  // eslint-disable-next-line global-require
  const esbuild = require("esbuild");
  const external = [
    "openclaw",
    "openclaw/*",
    "*.node",
    ...(opts.extraExternal || []),
  ];
  // 相对导入保持 external（见函数头注释）。不能用 external: ["./*"]——esbuild
  // 的相对通配会误伤 bare import（实测 "ws" 被改写成 "../node_modules/ws/index.js"
  // 并判为 external）。onResolve 里还必须限定 importer 就是 dist/ 下被重 bundle 的
  // chunk 自身——node_modules 里依赖（如 ws lib/*.js）的相对导入必须正常内联，
  // 否则产物会引用不存在的 dist/lib/*.js。
  // entryPoints 给的是绝对路径，不会命中 /^\./ filter。
  const externalizeRelativeImports = {
    name: "cryoclaw-externalize-relative-imports",
    setup(build) {
      build.onResolve({ filter: /^\./ }, (args) => {
        if (args.importer && path.dirname(args.importer) === distDir) {
          return { path: args.path, external: true };
        }
        return null;
      });
    },
  };
  const rebundled = [];
  for (const file of hits) {
    const abs = path.join(distDir, file);
    try {
      await esbuild.build({
        entryPoints: [abs],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        external,
        plugins: [externalizeRelativeImports],
        outfile: abs, // 原地覆盖：内核懒加载链按原文件名从磁盘加载
        allowOverwrite: true,
        absWorkingDir: pluginDir,
        banner: { js: BUNDLE_BANNER },
        logLevel: "warning",
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(`[${label}] esbuild in-place rebundle failed for dist/${file}: ${msg}`);
    }
    rebundled.push(path.join(opts.distDir || "dist", file));
  }
  return { action: "rebundled", pluginDir, rebundled };
}

module.exports = {
  resolveOpenClawPluginEntry,
  ensurePluginNativeEntry,
  rebundlePluginDistChunks,
  isBundleFresh,
  patchPluginEntryFields,
  BUNDLE_REL,
  BUNDLE_BANNER_MARKER,
  NATIVE_EXT,
};
