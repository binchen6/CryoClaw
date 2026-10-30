const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

function nativeSandboxFunction(fn) {
  const nativeError = error => error instanceof Error ? error : new Error(`package-resources sandbox failed: ${error?.stack ?? error}`);
  return function(...args) {
    try {
      const result=Reflect.apply(fn,this,args);
      if(result && typeof result.then==='function')return Promise.resolve(result).catch(error=>{throw nativeError(error);});
      return result;
    }catch(error){throw nativeError(error);}
  };
}

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
    console: options.console || console,
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
  // Async VM rejections need the same realm normalization as startup errors.
  for(const [name,value] of Object.entries(sandbox)){
    if(name!=="require" && typeof value==='function')sandbox[name]=nativeSandboxFunction(value);
  }
  return sandbox;
}

test("async sandbox failures preserve their cause as native errors for node:test IPC",async()=>{
  const fail=vm.runInNewContext('(async()=>{throw new Error("original VM failure")})');
  await assert.rejects(nativeSandboxFunction(fail)(),error=>error instanceof Error && /original VM failure/.test(error.message));
});

// 写入测试文件时自动补目录，避免样板代码污染用例意图。
function writeFixture(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('native updater vendors only semver and mode changes remove all old ASAR dependencies',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cryoclaw-updater-vendor-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'resources/targets/win32-x64'), updater=path.join(target,'updater');
  writeFixture(path.join(root,'package.json'),JSON.stringify({cryoclaw:{openclaw:'2026.10.7',gatewayRuntime:'node'}}));
  for(const rel of ['scripts/updater/kernel-update.mjs','scripts/updater/gateway-ctl.mjs','scripts/lib/kernel-dist-patch.js','scripts/lib/kernel-channel.js','scripts/lib/rm-rec.js','scripts/lib/kernel-prune.js','scripts/lib/kernel-config-snapshot.js','scripts/lib/kernel-directory-swap.js','scripts/lib/gateway-dependency-policy.js','shared/kernel-runtime-policy.cjs']){
    writeFixture(path.join(root,rel),fs.readFileSync(path.join(__dirname,'..',rel),'utf8'));
  }
  writeFixture(path.join(root,'node_modules/@electron/asar/package.json'),JSON.stringify({version:'4.1.0'}));
  writeFixture(path.join(root,'node_modules/semver/package.json'),JSON.stringify({version:'7.7.4'}));
  const sandbox=loadPackageResourcesSandbox({rootDir:root}); let installs=0;
  sandbox.execNpmSync=(args)=>{
    installs++;
    const pkg=JSON.parse(fs.readFileSync(path.join(updater,'package.json'),'utf8'));
    for(const [name,version] of Object.entries(pkg.dependencies||{})){
      writeFixture(path.join(updater,'node_modules',name,'package.json'),JSON.stringify({name,version}));
      writeFixture(path.join(updater,'node_modules',name,'index.js'),name+' runtime');
    }
    if(pkg.dependencies?.['@electron/asar']){
      for(const name of ['glob','minimatch','plist','commander'])writeFixture(path.join(updater,'node_modules',name,'index.js'),name+' runtime');
    }
    writeFixture(path.join(updater,'package-lock.json'),JSON.stringify({dependencies:pkg.dependencies}));
  };
  function measure(dir){let files=0,bytes=0;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){const v=measure(p);files+=v.files;bytes+=v.bytes;}else{files++;bytes+=fs.statSync(p).size;}}return {files,bytes};}
  const nativePolicy=path.join(target,'runtime/cryoclaw-runtime.json');
  writeFixture(nativePolicy,JSON.stringify({kind:'node',gatewayMode:'loose'}));
  sandbox.vendorKernelUpdater(target);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(updater,'package.json'),'utf8')).dependencies,{semver:'7.7.4'});
  assert.equal(fs.existsSync(path.join(updater,'node_modules/@electron/asar')),false);
  const nativeStamp=fs.readFileSync(path.join(updater,'.cryoclaw-updater-stamp'),'utf8');
  const nativeSize=measure(path.join(updater,'node_modules'));
  sandbox.vendorKernelUpdater(target);assert.equal(installs,1,'unchanged dependency content must reuse the cache');
  fs.unlinkSync(nativePolicy); sandbox.vendorKernelUpdater(target);
  assert.equal(installs,2); assert.equal(fs.existsSync(path.join(updater,'node_modules/@electron/asar')),true);
  const legacySize=measure(path.join(updater,'node_modules'));
  assert.ok(legacySize.files>nativeSize.files); assert.ok(legacySize.bytes>nativeSize.bytes);
  t.diagnostic(`fixture dependency tree: ASAR ${legacySize.files} files/${legacySize.bytes} logical bytes; native ${nativeSize.files} files/${nativeSize.bytes} logical bytes (real distribution measured after packaging)`);
  assert.notEqual(fs.readFileSync(path.join(updater,'.cryoclaw-updater-stamp'),'utf8'),nativeStamp);
  writeFixture(nativePolicy,JSON.stringify({kind:'node',gatewayMode:'loose'})); sandbox.vendorKernelUpdater(target);
  assert.equal(installs,3);assert.deepEqual(measure(path.join(updater,'node_modules')),nativeSize);
  for(const name of ['@electron/asar','glob','minimatch','plist','commander'])assert.equal(fs.existsSync(path.join(updater,'node_modules',name)),false,name+' must not survive mode change');
  assert.equal(fs.readFileSync(path.join(updater,'package-lock.json'),'utf8').includes('@electron/asar'),false);
});

test("native gateway policy overrides stale ASAR environment and command flags",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cryoclaw-runtime-policy-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  writeFixture(path.join(root,"package.json"),JSON.stringify({cryoclaw:{gatewayRuntime:"node"}}));
  const proc=Object.assign(Object.create(process),{argv:[process.execPath,"package-resources.js","--asar"],env:{...process.env,CRYOCLAW_GATEWAY_ASAR:"1"}});
  const sandbox=loadPackageResourcesSandbox({rootDir:root,process:proc});assert.equal(sandbox.parseArgs().asar,false);
});
test("native addon compilation follows the selected Gateway runtime ABI",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cryoclaw-addon-abi-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  writeFixture(path.join(root,"package.json"),JSON.stringify({cryoclaw:{gatewayRuntime:"node",node:"24.22.1"}}));
  const sandbox=loadPackageResourcesSandbox({rootDir:root});assert.equal(JSON.stringify(sandbox.nativeAddonBuildTarget()),JSON.stringify({runtime:"node",version:"24.22.1",distUrl:"https://nodejs.org/download/release"}));
  writeFixture(path.join(root,"package.json"),JSON.stringify({cryoclaw:{}}));writeFixture(path.join(root,"node_modules/electron/package.json"),JSON.stringify({version:"43.8.3"}));
  assert.equal(sandbox.nativeAddonBuildTarget().runtime,"electron");assert.equal(sandbox.nativeAddonBuildTarget().version,"43.8.3");
});

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

test("pruneNodeModules 只删除 Mistral src，保留生产 esm 与非纯 esm 回退", () => {
  const sandbox = loadPackageResourcesSandbox();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-mistral-prune-"));
  const nmDir = path.join(tmpRoot, "node_modules");
  const pkgDir = path.join(nmDir, "@mistralai", "mistralai");
  writeFixture(path.join(pkgDir, "package.json"), JSON.stringify({ main: "./esm/index.js", exports: { ".": { default: "./esm/index.js" } } }));
  writeFixture(path.join(pkgDir, "src", "index.ts"), "export {};\n");
  writeFixture(path.join(pkgDir, "esm", "index.js"), "export {};\n");
  sandbox.pruneNodeModules(nmDir);
  assert.equal(fs.existsSync(path.join(pkgDir, "src")), false, "默认 esm 时重复 src 应删除");
  assert.equal(fs.existsSync(path.join(pkgDir, "esm", "index.js")), true, "生产 esm 必须保留");
  assert.equal(fs.existsSync(path.join(pkgDir, "package.json")), true, "包元数据必须保留");

  const fallbackDir = path.join(tmpRoot, "fallback", "node_modules", "@mistralai", "mistralai");
  writeFixture(path.join(fallbackDir, "package.json"), JSON.stringify({ main: "./src/index.ts", exports: { ".": { default: "./esm/index.js" } } }));
  writeFixture(path.join(fallbackDir, "src", "index.ts"), "export {};\n");
  writeFixture(path.join(fallbackDir, "esm", "index.js"), "export {};\n");
  sandbox.pruneNodeModules(path.join(tmpRoot, "fallback", "node_modules"));
  assert.equal(fs.existsSync(path.join(fallbackDir, "src")), true, "非纯 esm 的 src 回退必须保留");
  writeFixture(path.join(fallbackDir, "package.json"), JSON.stringify({ main: "./esm/index.js", exports: { ".": { node: "./src/index.ts", default: "./esm/index.js" } } }));
  sandbox.pruneNodeModules(path.join(tmpRoot, "fallback", "node_modules"));
  assert.equal(fs.existsSync(path.join(fallbackDir, "src")), true, "生产 node 条件仍指向 src 时必须保留");
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

// P0-11：asar 模式下注入插件 manifest 必须有产物校验。win-arm64 交叉编译下
// bundleAllPlugins 的注入失败只 log 跳过，9 个注入插件全缺也会绿灯出包。
const INJECTED_PLUGIN_IDS = [
  "cryoclaw-deliverables",
  "cryoclaw-dashboards",
  "kimi-search",
  "dingtalk-connector",
  "feishu",
  "qqbot",
  "moonshot",
  "kimi",
  "zai",
  "qwen",
  "deepseek",
];

// 用真实 asar 打包一份只含校验所需文件的 fixture gateway 树。
async function packFixtureAsar(tmpRoot, presentExtIds) {
  const asar = require("@electron/asar");
  const gatewayDir = path.join(tmpRoot, "gateway-src");
  writeFixture(path.join(gatewayDir, "node_modules", "openclaw", "openclaw.mjs"), "export {};\n");
  writeFixture(path.join(gatewayDir, "node_modules", "openclaw", "dist", "entry.js"), "module.exports = {};\n");
  writeFixture(path.join(gatewayDir, "node_modules", "clawhub", "bin", "clawdhub.js"), "module.exports = {};\n");
  writeFixture(
    path.join(gatewayDir, "node_modules", "openclaw", "dist", "extensions", "image-generation-core", "openclaw.plugin.json"),
    "{}\n"
  );
  for (const id of presentExtIds) {
    writeFixture(
      path.join(gatewayDir, "node_modules", "openclaw", "dist", "extensions", id, "openclaw.plugin.json"),
      "{}\n"
    );
  }
  const asarPath = path.join(tmpRoot, "gateway.asar");
  await asar.createPackage(gatewayDir, asarPath);
  return asarPath;
}

// 捕获 die() 写到 console.error 的消息（die 只打日志后 process.exit，
// 抛出的 Error 里不含缺失详情，消息文本需从 console.error 断言）。
function loadVerifySandbox() {
  const errors = [];
  const consoleShim = Object.create(console, {
    error: { value: (...args) => errors.push(args.join(" ")) },
  });
  const sandbox = loadPackageResourcesSandbox({
    console: consoleShim,
    process: Object.assign(Object.create(process), {
      argv: process.argv.slice(),
      env: { ...process.env },
      exit(code) {
        throw new Error(`process.exit:${code}`);
      },
    }),
  });
  return { sandbox, errors };
}

test("verifyAsarContents: 9 个注入插件 manifest 齐全 → 通过", async () => {
  const { sandbox } = loadVerifySandbox();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-verify-"));
  try {
    const asarPath = await packFixtureAsar(tmpRoot, INJECTED_PLUGIN_IDS);
    sandbox.verifyAsarContents(asarPath, { winArm64Cross: false });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyAsarContents: 缺任一必需插件 → 抛错且消息含插件 id", async () => {
  for (const id of INJECTED_PLUGIN_IDS.filter((i) => i !== "kimi-search")) {
    const { sandbox, errors } = loadVerifySandbox();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-verify-"));
    try {
      const present = INJECTED_PLUGIN_IDS.filter((i) => i !== id);
      const asarPath = await packFixtureAsar(tmpRoot, present);
      assert.throws(
        () => sandbox.verifyAsarContents(asarPath, { winArm64Cross: false }),
        /process\.exit:1/
      );
      assert.match(
        errors.join("\n"),
        new RegExp(`extensions/${id}/openclaw\\.plugin\\.json`)
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test("verifyAsarContents: win-arm64 交叉编译仅缺 kimi-search → 豁免通过", async () => {
  const { sandbox } = loadVerifySandbox();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-verify-"));
  try {
    const present = INJECTED_PLUGIN_IDS.filter((i) => i !== "kimi-search");
    const asarPath = await packFixtureAsar(tmpRoot, present);
    sandbox.verifyAsarContents(asarPath, { winArm64Cross: true });

    // 交叉编译下缺其他必需插件仍必须 die
    const { sandbox: sandbox2, errors: errors2 } = loadVerifySandbox();
    const present2 = INJECTED_PLUGIN_IDS.filter((i) => i !== "deepseek");
    const tmpRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-verify-"));
    try {
      const asarPath2 = await packFixtureAsar(tmpRoot2, present2);
      assert.throws(
        () => sandbox2.verifyAsarContents(asarPath2, { winArm64Cross: true }),
        /process\.exit:1/
      );
      assert.match(errors2.join("\n"), /extensions\/deepseek\/openclaw\.plugin\.json/);
    } finally {
      fs.rmSync(tmpRoot2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── Step 7.2: 归档工具 sidecar（cryoclaw-archive） ───

function loadArchiveToolSandbox(tmpRoot, { consoleOverride } = {}) {
  writeFixture(path.join(tmpRoot, "package.json"), JSON.stringify({ cryoclaw: { archiveTool: "0.1.0" } }));
  const sandbox = loadPackageResourcesSandbox({
    rootDir: tmpRoot,
    ...(consoleOverride ? { console: consoleOverride } : {}),
  });
  return sandbox;
}

test("readArchiveToolExpectedHash 按文件名精确匹配，不受 .sig 兄弟条目前缀干扰", () => {
  const sums = [
    "aaa111  cryoclaw-archive-win32-x64.exe",
    "bbb222  cryoclaw-archive-win32-x64.exe.sig",
    "ccc333  cryoclaw-archive-darwin-arm64",
  ].join("\n");
  const sandbox = loadPackageResourcesSandbox();
  assert.equal(sandbox.readArchiveToolExpectedHash(sums, "cryoclaw-archive-win32-x64.exe"), "aaa111");
  assert.equal(sandbox.readArchiveToolExpectedHash(sums, "cryoclaw-archive-darwin-arm64"), "ccc333");
  assert.throws(() => sandbox.readArchiveToolExpectedHash(sums, "cryoclaw-archive-win32-arm64.exe"), /SHA256SUMS/);
});

test("prepareArchiveTool stamp 匹配 + 输出存在 → 跳过（不 spawn 不触网）", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-archive-tool-stamp-"));
  try {
    const sandbox = loadArchiveToolSandbox(tmpRoot);
    const targetBase = path.join(tmpRoot, "resources", "targets", "win32-x64");
    const outputDir = path.join(targetBase, "archive-tool");
    writeFixture(path.join(outputDir, "cryoclaw-archive.exe"), "fake-binary");
    writeFixture(path.join(outputDir, ".archive-tool-stamp"), "0.1.0-win32-x64");
    // spawn 兜底保护：任何 --version 握手都会失败（fake-binary 不可执行）
    await sandbox.prepareArchiveTool("win32", "x64", targetBase);
    assert.equal(fs.readFileSync(path.join(outputDir, "cryoclaw-archive.exe"), "utf-8"), "fake-binary");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("prepareArchiveTool 远端下载失败只 warn 不 fail（运行时回退纯 JS）", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-archive-tool-netfail-"));
  const logs = [];
  try {
    const sandbox = loadArchiveToolSandbox(tmpRoot, {
      consoleOverride: { log: () => {}, error: () => {}, warn: (m) => logs.push(String(m)) },
    });
    // 覆盖下载实现模拟网络不可达（prepareArchiveTool 内部经全局绑定解析）
    sandbox.downloadFileWithFallback = async () => {
      throw new Error("network down");
    };
    const targetBase = path.join(tmpRoot, "resources", "targets", "win32-x64");
    await sandbox.prepareArchiveTool("win32", "x64", targetBase);
    // 输出目录必须存在（electron-builder extraResources 源），但二进制缺失
    assert.ok(fs.existsSync(path.join(targetBase, "archive-tool")));
    assert.ok(!fs.existsSync(path.join(targetBase, "archive-tool", "cryoclaw-archive.exe")));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("prepareArchiveTool 未 pin 时跳过且不建目录", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-archive-tool-nopin-"));
  try {
    writeFixture(path.join(tmpRoot, "package.json"), JSON.stringify({ cryoclaw: {} }));
    const sandbox = loadPackageResourcesSandbox({ rootDir: tmpRoot });
    const targetBase = path.join(tmpRoot, "resources", "targets", "win32-x64");
    await sandbox.prepareArchiveTool("win32", "x64", targetBase);
    assert.ok(!fs.existsSync(path.join(targetBase, "archive-tool")));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
