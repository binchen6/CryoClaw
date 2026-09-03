const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

// 加载 package-resources 脚本并跳过 main()，只测试局部函数。
function loadPackageResourcesSandbox(options = {}) {
  const scriptPath = path.join(__dirname, "package-resources.js");
  // 归一化行尾为 LF：Windows checkout 下源码是 CRLF，main() 移除正则依赖 LF，
  // 否则 main() 会在 vm 里真实执行完整打包（npm install + 下载），测试变慢且依赖网络。
  const rawSource = fs.readFileSync(scriptPath, "utf-8").replace(/\r\n/g, "\n");
  let source = rawSource.replace(/\nmain\(\)\.catch\(\(err\) => \{\n[\s\S]*?\n\}\);\s*$/, "\n");
  if (options.rootDir) {
    source = source.replace(
      'const ROOT = path.resolve(__dirname, "..");',
      `const ROOT = ${JSON.stringify(options.rootDir)};`
    );
    if (!source.includes(`const ROOT = ${JSON.stringify(options.rootDir)};`)) {
      throw new Error(
        "ROOT injection failed: literal 'const ROOT = path.resolve(__dirname, \"..\");' not found in package-resources.js. " +
          "Update the sandbox loader to match the new declaration."
      );
    }
  }
  const sandboxProcess = options.process || Object.assign(Object.create(process), {
    argv: process.argv.slice(),
    env: { ...process.env },
  });
  const sandbox = {
    require,
    __dirname,
    console,
    process: sandboxProcess,
    exports: {},
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(source, sandbox, { filename: scriptPath });
  } catch (err) {
    // vm realm 的错误对象跨 realm，node:test 予进程 IPC 序列化会报
    // "Unable to deserialize cloned data" 并吞掉真实原因——转成本 realm 错误再抛
    throw new Error(`package-resources sandbox failed: ${err && err.stack ? err.stack : err}`);
  }
  return sandbox;
}

// 写入测试文件时自动补目录，避免样板代码污染用例意图。
function writeFixture(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function officeCliStampValue(prefix, hash, filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return `${prefix}|${hash}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}`;
}

test("Windows 全局 windowsHide 补丁应覆盖所有 spawn 调用", () => {
  const sandbox = loadPackageResourcesSandbox();
  assert.equal(typeof sandbox.patchWindowsOpenclawArtifacts, "function");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-package-resources-"));
  const distDir = path.join(tmpRoot, "node_modules", "openclaw", "dist");
  fs.mkdirSync(distDir, { recursive: true });

  // exec 模式（工具执行）
  const execFile = path.join(distDir, "exec-abc.js");
  fs.writeFileSync(execFile, [
    'const child = spawn(useCmdWrapper ? process$1.env.ComSpec ?? "cmd.exe" : resolvedCommand, useCmdWrapper ? [',
    '\t"/d"',
    '\t] : finalArgv.slice(1), {',
    "\t\tstdio,",
    "\t\tcwd,",
    "\t\tenv: resolvedEnv,",
    "\t});",
    "",
  ].join("\n"));

  // gateway-cli respawn 模式
  const gatewayCliFile = path.join(distDir, "gateway-cli-abc.js");
  fs.writeFileSync(gatewayCliFile, [
    "const child = spawn(process.execPath, args, {",
    "\t\tenv: process.env,",
    "\t\tdetached: true,",
    '\t\tstdio: "inherit"',
    "\t});",
    "",
  ].join("\n"));

  // killProcessTree$1 模式（shell-utils.ts，每次工具执行结束后调用）
  const sessionFile = path.join(distDir, "model-selection-abc.js");
  fs.writeFileSync(sessionFile, [
    "function killProcessTree$1(pid) {",
    '  if (process.platform === "win32") {',
    "    try {",
    '      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {',
    '        stdio: "ignore",',
    "        detached: true",
    "      });",
    "    } catch {}",
    "  }",
    "}",
    "",
  ].join("\n"));

  // workspace runCommandWithTimeout 模式
  const workspaceFile = path.join(distDir, "workspace-abc.js");
  fs.writeFileSync(workspaceFile, [
    'const child = spawn(useCmdWrapper ? cmd : resolvedCommand, useCmdWrapper ? ["/d", "/s", "/c", line] : finalArgv.slice(1), {',
    "\tstdio,",
    "\tcwd,",
    "\tenv: resolvedEnv,",
    "});",
    "",
  ].join("\n"));

  sandbox.patchWindowsOpenclawArtifacts(tmpRoot);

  assert.match(fs.readFileSync(execFile, "utf-8"), /windowsHide:\s*true/);
  assert.match(fs.readFileSync(gatewayCliFile, "utf-8"), /windowsHide:\s*true/);
  assert.match(fs.readFileSync(sessionFile, "utf-8"), /windowsHide:\s*true/);
  assert.match(fs.readFileSync(workspaceFile, "utf-8"), /windowsHide:\s*true/);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("Windows 全局 windowsHide 补丁应幂等（已有补丁不重复注入）", () => {
  const sandbox = loadPackageResourcesSandbox();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-package-resources-"));
  const distDir = path.join(tmpRoot, "node_modules", "openclaw", "dist");
  fs.mkdirSync(distDir, { recursive: true });

  // 已包含 windowsHide 的 exec 文件
  const content = [
    'const child = spawn(useCmdWrapper ? cmd : resolvedCommand, useCmdWrapper ? ["/d"] : finalArgv.slice(1), {',
    "\twindowsHide: true,",
    "\tstdio,",
    "\tcwd,",
    "});",
    "",
  ].join("\n");
  const execFile = path.join(distDir, "exec-abc.js");
  fs.writeFileSync(execFile, content);

  sandbox.patchWindowsOpenclawArtifacts(tmpRoot);

  // 文件应保持不变（只有 1 个 windowsHide，没有重复注入）
  const after = fs.readFileSync(execFile, "utf-8");
  assert.equal((after.match(/windowsHide/g) || []).length, 1);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("buildVolcanoConfig 应写入独立的超时与重试配置", () => {
  const sandbox = loadPackageResourcesSandbox({
    process: Object.assign(Object.create(process), {
      argv: process.argv.slice(),
      env: {
        ...process.env,
        VOLCANO_APP_ID: "1",
        VOLCANO_APP_KEY: "volcano-key",
        VOLCANO_ENDPOINT: "https://collector.example/v2/event/json",
        VOLCANO_FALLBACK_ENDPOINT: "https://collector-backup.example/v2/event/json",
        VOLCANO_REQUEST_TIMEOUT_MS: "12000",
        VOLCANO_RETRY_DELAYS_MS: "0,1000,3000",
      },
    }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.buildVolcanoConfig())), {
    enabled: true,
    appId: 1,
    appKey: "volcano-key",
    endpoint: "https://collector.example/v2/event/json",
    fallbackEndpoint: "https://collector-backup.example/v2/event/json",
    requestTimeoutMs: 12000,
    retryDelaysMs: [0, 1000, 3000],
  });
});

test("downloadOfficeCli 不应因 stamp 匹配而跳过缺失的输出文件", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-officecli-missing-"));
  const version = "1.2.3";
  const assetName = "officecli-mac-arm64";
  const cachedContent = "expected officecli\n";
  const hash = require("node:crypto").createHash("sha256").update(cachedContent).digest("hex");

  writeFixture(path.join(tmpRoot, "package.json"), JSON.stringify({ cryoclaw: { officecli: version } }));
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, assetName), cachedContent);
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, "SHA256SUMS"), `${hash}  ${assetName}\n`);

  const targetBase = path.join(tmpRoot, "resources", "targets", "darwin-arm64");
  writeFixture(path.join(targetBase, "officecli", ".officecli-stamp"), `${version}-darwin-arm64`);

  const sandbox = loadPackageResourcesSandbox({ rootDir: tmpRoot });
  await sandbox.downloadOfficeCli("darwin", "arm64", targetBase);

  assert.equal(fs.readFileSync(path.join(targetBase, "officecli", "officecli"), "utf-8"), cachedContent);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("downloadOfficeCli 不应因 stamp 匹配而保留 hash 不匹配的输出文件", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-officecli-stale-"));
  const version = "1.2.3";
  const assetName = "officecli-mac-arm64";
  const cachedContent = "expected officecli\n";
  const hash = require("node:crypto").createHash("sha256").update(cachedContent).digest("hex");

  writeFixture(path.join(tmpRoot, "package.json"), JSON.stringify({ cryoclaw: { officecli: version } }));
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, assetName), cachedContent);
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, "SHA256SUMS"), `${hash}  ${assetName}\n`);

  const targetBase = path.join(tmpRoot, "resources", "targets", "darwin-arm64");
  writeFixture(path.join(targetBase, "officecli", ".officecli-stamp"), `${version}-darwin-arm64`);
  writeFixture(path.join(targetBase, "officecli", "officecli"), "stale officecli\n");

  const sandbox = loadPackageResourcesSandbox({ rootDir: tmpRoot });
  await sandbox.downloadOfficeCli("darwin", "arm64", targetBase);

  assert.equal(fs.readFileSync(path.join(targetBase, "officecli", "officecli"), "utf-8"), cachedContent);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("downloadOfficeCli 命中新格式 stamp 时不应访问网络", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-officecli-fastpath-"));
  const version = "1.2.3";
  const cachedContent = "expected officecli\n";
  const hash = require("node:crypto").createHash("sha256").update(cachedContent).digest("hex");

  writeFixture(path.join(tmpRoot, "package.json"), JSON.stringify({ cryoclaw: { officecli: version } }));
  // 故意不写入 cached SHA256SUMS，确认快路径不会触发联网下载。

  const targetBase = path.join(tmpRoot, "resources", "targets", "darwin-arm64");
  const outputBin = path.join(targetBase, "officecli", "officecli");
  writeFixture(outputBin, cachedContent);
  writeFixture(
    path.join(targetBase, "officecli", ".officecli-stamp"),
    officeCliStampValue(`${version}-darwin-arm64`, hash, outputBin)
  );

  const sandbox = loadPackageResourcesSandbox({ rootDir: tmpRoot });
  sandbox.downloadFileWithFallback = async () => {
    throw new Error("network must not be called");
  };
  await sandbox.downloadOfficeCli("darwin", "arm64", targetBase);

  assert.equal(fs.readFileSync(path.join(targetBase, "officecli", "officecli"), "utf-8"), cachedContent);
  assert.equal(
    fs.existsSync(path.join(tmpRoot, ".cache", "officecli", version, "SHA256SUMS")),
    false
  );
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("downloadOfficeCli 不应因新格式 stamp 匹配而保留同尺寸错误输出文件", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-officecli-same-size-"));
  const version = "1.2.3";
  const assetName = "officecli-mac-arm64";
  const cachedContent = "expected officecli\n";
  const wrongContent = "x".repeat(Buffer.byteLength(cachedContent));
  const hash = require("node:crypto").createHash("sha256").update(cachedContent).digest("hex");
  const size = Buffer.byteLength(cachedContent);

  writeFixture(path.join(tmpRoot, "package.json"), JSON.stringify({ cryoclaw: { officecli: version } }));
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, assetName), cachedContent);
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, "SHA256SUMS"), `${hash}  ${assetName}\n`);

  const targetBase = path.join(tmpRoot, "resources", "targets", "darwin-arm64");
  writeFixture(path.join(targetBase, "officecli", "officecli"), wrongContent);
  writeFixture(
    path.join(targetBase, "officecli", ".officecli-stamp"),
    `${version}-darwin-arm64|${hash}|${size}|1|1`
  );

  const sandbox = loadPackageResourcesSandbox({ rootDir: tmpRoot });
  await sandbox.downloadOfficeCli("darwin", "arm64", targetBase);

  assert.equal(fs.readFileSync(path.join(targetBase, "officecli", "officecli"), "utf-8"), cachedContent);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("downloadOfficeCli 命中新格式 stamp 但文件大小变化时应重新写入", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-officecli-resized-"));
  const version = "1.2.3";
  const assetName = "officecli-mac-arm64";
  const cachedContent = "expected officecli\n";
  const hash = require("node:crypto").createHash("sha256").update(cachedContent).digest("hex");
  const correctSize = Buffer.byteLength(cachedContent);

  writeFixture(path.join(tmpRoot, "package.json"), JSON.stringify({ cryoclaw: { officecli: version } }));
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, assetName), cachedContent);
  writeFixture(path.join(tmpRoot, ".cache", "officecli", version, "SHA256SUMS"), `${hash}  ${assetName}\n`);

  const targetBase = path.join(tmpRoot, "resources", "targets", "darwin-arm64");
  // 输出文件被截断（实际大小 != stamp 中声明的大小）。
  writeFixture(path.join(targetBase, "officecli", "officecli"), "trunc\n");
  writeFixture(
    path.join(targetBase, "officecli", ".officecli-stamp"),
    `${version}-darwin-arm64|${hash}|${correctSize}|1|1`
  );

  const sandbox = loadPackageResourcesSandbox({ rootDir: tmpRoot });
  await sandbox.downloadOfficeCli("darwin", "arm64", targetBase);

  assert.equal(fs.readFileSync(path.join(targetBase, "officecli", "officecli"), "utf-8"), cachedContent);
  const newStamp = fs.readFileSync(path.join(targetBase, "officecli", ".officecli-stamp"), "utf-8").trim();
  assert.match(newStamp, new RegExp(`^${version}-darwin-arm64\\|${hash}\\|${correctSize}\\|\\d+\\|\\d+$`));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 白名单裁剪必须深入保留插件内部继续清垃圾，而不是把整个 extensions 目录豁免掉。
test("pruneNodeModules 应按扩展白名单裁剪并清理保留插件内部垃圾", () => {
  const sandbox = loadPackageResourcesSandbox();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-package-prune-"));
  const nmDir = path.join(tmpRoot, "node_modules");
  const feishuDir = path.join(nmDir, "openclaw", "extensions", "feishu");

  writeFixture(path.join(feishuDir, "openclaw.plugin.json"), "{}\n");
  writeFixture(path.join(feishuDir, "runtime.js"), "module.exports = {};\n");
  writeFixture(path.join(feishuDir, "README.md"), "# docs\n");
  writeFixture(path.join(feishuDir, "types.d.ts"), "export {};\n");
  writeFixture(path.join(feishuDir, "bundle.js.map"), "{}\n");
  writeFixture(path.join(feishuDir, "tests", "plugin.test.js"), "test\n");
  writeFixture(path.join(feishuDir, "docs", "guide.md"), "# guide\n");
  writeFixture(path.join(feishuDir, "node_modules", ".ignored", "pkg", "index.js"), "ignored\n");
  writeFixture(path.join(feishuDir, "node_modules", ".ignored_openai", "pkg", "index.js"), "ignored\n");
  writeFixture(path.join(feishuDir, "node_modules", "real-dep", "index.js"), "keep\n");
  writeFixture(path.join(nmDir, "openclaw", "extensions", "slack", "openclaw.plugin.json"), "{}\n");

  sandbox.pruneNodeModules(nmDir);

  assert.equal(fs.existsSync(path.join(feishuDir, "runtime.js")), true);
  assert.equal(fs.existsSync(path.join(feishuDir, "README.md")), false);
  assert.equal(fs.existsSync(path.join(feishuDir, "types.d.ts")), false);
  assert.equal(fs.existsSync(path.join(feishuDir, "bundle.js.map")), false);
  assert.equal(fs.existsSync(path.join(feishuDir, "tests")), false);
  assert.equal(fs.existsSync(path.join(feishuDir, "docs")), false);
  assert.equal(fs.existsSync(path.join(feishuDir, "node_modules", ".ignored")), false);
  assert.equal(fs.existsSync(path.join(feishuDir, "node_modules", ".ignored_openai")), false);
  assert.equal(fs.existsSync(path.join(feishuDir, "node_modules", "real-dep", "index.js")), true);
  assert.equal(fs.existsSync(path.join(nmDir, "openclaw", "extensions", "slack")), false);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// R6：npm 会把所有平台的原生包装进嵌套 node_modules（openclaw/node_modules/@lydell/
// node-pty-<os>-<arch>，win32-arm64 单个 11.4MB），collectTopLevelPackages 只看第一层，
// 必须递归逐层清理且只保留精确匹配目标平台+架构的包。
test("pruneNonTargetNativePlatformPackages 应递归清理嵌套 node_modules 里的非目标平台原生包", () => {
  const sandbox = loadPackageResourcesSandbox();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-native-prune-"));
  const nmDir = path.join(tmpRoot, "node_modules");
  const nestedNm = path.join(nmDir, "openclaw", "node_modules");

  for (const plat of ["win32-x64", "win32-arm64", "darwin-arm64", "linux-x64"]) {
    writeFixture(path.join(nestedNm, "@lydell", `node-pty-${plat}`, "pty.node"), "binary\n");
  }
  writeFixture(path.join(nmDir, "sharp-win32-x64", "sharp.node"), "binary\n");
  writeFixture(path.join(nmDir, "sharp-linux-x64", "sharp.node"), "binary\n");
  writeFixture(path.join(nestedNm, "plain-dep", "index.js"), "keep\n"); // 非平台包不受影响

  sandbox.pruneNonTargetNativePlatformPackages(nmDir, "win32", "x64");

  assert.equal(fs.existsSync(path.join(nestedNm, "@lydell", "node-pty-win32-x64")), true, "目标平台嵌套包必须保留");
  for (const plat of ["win32-arm64", "darwin-arm64", "linux-x64"]) {
    assert.equal(fs.existsSync(path.join(nestedNm, "@lydell", `node-pty-${plat}`)), false, `${plat} 应被删除`);
  }
  assert.equal(fs.existsSync(path.join(nmDir, "sharp-win32-x64")), true);
  assert.equal(fs.existsSync(path.join(nmDir, "sharp-linux-x64")), false);
  assert.equal(fs.existsSync(path.join(nestedNm, "plain-dep", "index.js")), true);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// R6：插件 node_modules 缓存命中复用路径也必须重跑完整裁剪集，
// 否则裁剪规则升级后旧构建树里的冗余文件（feishu node-sdk 15.5MB d.ts 等）永远清不掉。
test("prunePluginNodeModules 应执行完整裁剪集（垃圾文件 + 非目标平台包 + prebuilds）", () => {
  const sandbox = loadPackageResourcesSandbox();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-plugin-prune-"));
  const pluginNm = path.join(tmpRoot, "plugin", "node_modules");

  // 通用垃圾：.d.ts / .map / 文档 / 测试目录（feishu node-sdk 大头）
  writeFixture(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "types", "index.d.ts"), "export {};\n");
  writeFixture(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "dist", "index.js"), "keep\n");
  writeFixture(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "dist", "index.js.map"), "{}\n");
  writeFixture(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "README.md"), "# r\n");
  writeFixture(path.join(pluginNm, "some-dep", "tests", "a.test.js"), "t\n");
  // 非目标平台原生包（嵌套一层也要清）
  writeFixture(path.join(pluginNm, "inner", "node_modules", "node-pty-darwin-arm64", "pty.node"), "b\n");
  writeFixture(path.join(pluginNm, "inner", "node_modules", "node-pty-win32-x64", "pty.node"), "b\n");
  // 非目标平台 prebuilds
  writeFixture(path.join(pluginNm, "native-dep", "prebuilds", "darwin-arm64", "n.node"), "b\n");
  writeFixture(path.join(pluginNm, "native-dep", "prebuilds", "win32-x64", "n.node"), "b\n");

  sandbox.prunePluginNodeModules(pluginNm, { platform: "win32", arch: "x64" });

  assert.equal(fs.existsSync(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "types", "index.d.ts")), false, "d.ts 应被删除");
  assert.equal(fs.existsSync(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "dist", "index.js")), true, "运行时代码必须保留");
  assert.equal(fs.existsSync(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "dist", "index.js.map")), false);
  assert.equal(fs.existsSync(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "README.md")), false);
  assert.equal(fs.existsSync(path.join(pluginNm, "some-dep", "tests")), false);
  assert.equal(fs.existsSync(path.join(pluginNm, "inner", "node_modules", "node-pty-darwin-arm64")), false);
  assert.equal(fs.existsSync(path.join(pluginNm, "inner", "node_modules", "node-pty-win32-x64")), true);
  assert.equal(fs.existsSync(path.join(pluginNm, "native-dep", "prebuilds", "darwin-arm64")), false);
  assert.equal(fs.existsSync(path.join(pluginNm, "native-dep", "prebuilds", "win32-x64")), true);

  // 幂等：再跑一次不抛错
  sandbox.prunePluginNodeModules(pluginNm, { platform: "win32", arch: "x64" });
  assert.equal(fs.existsSync(path.join(pluginNm, "@larksuiteoapi", "node-sdk", "dist", "index.js")), true);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 输出校验必须覆盖白名单里的基础插件，否则构建脚本会悄悄打出残缺包。
test("verifyOutput 应要求基础扩展插件存在", () => {
  const sandbox = loadPackageResourcesSandbox({
    process: Object.assign(Object.create(process), {
      argv: process.argv.slice(),
      env: { ...process.env },
      exit(code) {
        throw new Error(`process.exit:${code}`);
      },
    }),
  });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-package-verify-"));
  const targetBase = path.join(tmpRoot, "win32-x64");

  writeFixture(path.join(targetBase, "runtime", "node.exe"), "node\n");
  fs.mkdirSync(path.join(targetBase, "runtime", "node_modules", "npm"), { recursive: true });
  writeFixture(path.join(targetBase, "gateway", "gateway-entry.mjs"), "export {};\n");
  writeFixture(path.join(targetBase, "gateway", "node_modules", "openclaw", "openclaw.mjs"), "export {};\n");
  writeFixture(path.join(targetBase, "gateway", "node_modules", "openclaw", "dist", "entry.js"), "module.exports = {};\n");
  writeFixture(path.join(targetBase, "gateway", "node_modules", "openclaw", "dist", "control-ui", "index.html"), "<html></html>\n");
  writeFixture(path.join(targetBase, "gateway", "node_modules", "clawhub", "bin", "clawdhub.js"), "module.exports = {};\n");
  writeFixture(path.join(targetBase, "build-config.json"), "{}\n");
  writeFixture(path.join(targetBase, "app-icon.png"), "png\n");

  for (const id of [
    "memory-core",
    "device-pair",
    "kimi-search",
    "dingtalk-connector",
    "wecom-openclaw-plugin",
  ]) {
    const extDir = path.join(targetBase, "gateway", "node_modules", "openclaw", "extensions", id);
    writeFixture(path.join(extDir, "openclaw.plugin.json"), "{}\n");
  }

  assert.throws(
    () => sandbox.verifyOutput({ targetBase }, "win32"),
    /process\.exit:1/
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
