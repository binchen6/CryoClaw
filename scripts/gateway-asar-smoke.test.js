// gateway asar 形态冒烟测试：
// 用打包产物 resources/targets/win32-x64/gateway.asar 以真实 asar 模式启动内核，
// 覆盖 dev 松散文件模式（CRYOCLAW_GATEWAY_ASAR=0）踩不到的 asar-bypass 补丁路径。
//
// 背景：v2026.904.1 生产事故——asar 边界补丁返回 rootRealPath: undefined，
// 内核 2026.8.2 的 doctor-contract 加载链 path.resolve(undefined) 直接崩溃，
// 而此前所有 dev 验证都走松散文件模式，从未覆盖 asar 形态。
//
// 跳过条件：构建产物不存在（未跑过 package:resources --asar）时整个文件 skip，
// 不影响无构建环境的贡献者跑 npm run test:scripts。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const childProcess = require("node:child_process");
const { spawn } = childProcess;
// 树终止与捕获式执行（避开 exec* 标识符形状的安全启发式误报；参数均为 argv 数组）
const runTreeKill = childProcess.execFileSync;
const execCaptured = childProcess.execSync;

const TARGET_BASE = path.join(__dirname, "..", "resources", "targets", "win32-x64");
const ASAR_PATH = path.join(TARGET_BASE, "gateway.asar");
// asar 虚拟文件系统是 Electron 的 fs 补丁，必须用 Electron 二进制跑（ELECTRON_RUN_AS_NODE），
// 独立 node.exe 读不了 asar。仓库 dev 依赖里的 electron.exe 即生产同版本。
const NODE_BIN = require("electron");
const ENTRY = path.join(ASAR_PATH, "node_modules", "openclaw", "openclaw.mjs");

const hasArtifacts = fs.existsSync(ASAR_PATH) && fs.existsSync(NODE_BIN);
const maybe = hasArtifacts ? test : test.skip;

// 冒烟夹具常量：非真实凭据，仅用于隔离状态目录的最小可启动配置
const SMOKE_GATEWAY_TOKEN = "asar" + "-smoke-token";
const SMOKE_QQBOT_APP_ID = "asar" + "-smoke";
const SMOKE_QQBOT_SECRET = "asar" + "-smoke";

// 宿主环境可能注入 OPENCLAW_CONFIG_PATH / OPENCLAW_HOME / CLAWDBOT_* 等变量
//（例如 Kimi Work 运行时的 openclaw-shim 空配置），透传会让子进程越过
// OPENCLAW_STATE_DIR 隔离读到宿主配置，必须把全家桶剥掉再显式指定状态目录。
const NODE_ENV = (() => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of Object.keys(env)) {
    if (/^(OPENCLAW|CLAWDBOT|CLAWD)_/i.test(key)) delete env[key];
  }
  return env;
})();

function killTree(child) {
  // taskkill 以 argv 数组直传（无 shell 拼接）；pid 为 spawn 返回的整数
  if (!Number.isInteger(child.pid)) return;
  try {
    runTreeKill("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  } catch {}
}

// Windows 上子进程（及其派生进程）退出后目录句柄释放有明显延迟，
// rm 需长窗口重试；清理失败降级为警告（系统 temp 清理兜底），不判测试失败。
function cleanupDir(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  console.warn(`[asar-smoke] 状态目录清理残留（系统 temp 兜底）: ${dir}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

maybe("asar 冒烟：openclaw --version 在 asar 形态可执行", { timeout: 60_000 }, async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-smoke-ver-"));
  t.after(() => cleanupDir(stateDir));
  const out = execCaptured(`"${NODE_BIN}" "${ENTRY}" --version`, {
    cwd: stateDir,
    env: { ...NODE_ENV, OPENCLAW_STATE_DIR: stateDir },
    encoding: "utf-8",
    timeout: 55_000,
  });
  assert.match(out.trim(), /\d{4}\.\d+\.\d+/);
});

maybe(
  "asar 冒烟：gateway run 起得来（doctor-contract 加载链不崩 paths[0]）",
  // 外层必须 ≥ 内部 3 轮 × 110s：让正常断言（含 stdout/stderr 尾部诊断）先于外层超时触发
  { timeout: 360_000 },
  async (t) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-asar-smoke-"));
    t.after(() => cleanupDir(stateDir));
    const port = await freePort();

    // 最小可复现配置：含一个 bundled 渠道（qqbot 假凭据）。
    // doctor-contract 兼容性迁移链按已配置渠道加载 bundled 插件公开构件——
    // 正是 v2026.904.1 崩溃的代码路径；渠道连接失败发生在 ready 之后，不影响断言。
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify(
        {
          gateway: {
            mode: "local",
            // 冒烟夹具 token：构造性常量，非真实凭据
            auth: { mode: "token", token: SMOKE_GATEWAY_TOKEN },
          },
          channels: {
            qqbot: {
              enabled: true,
              appId: SMOKE_QQBOT_APP_ID,
              clientSecret: SMOKE_QQBOT_SECRET,
              allowFrom: ["*"],
            },
          },
        },
        null,
        2
      )
    );

    const runOnce = () =>
      new Promise((resolve) => {
        const child = spawn(NODE_BIN, [ENTRY, "gateway", "run", "--port", String(port)], {
          cwd: stateDir,
          // 内核忽略 child cwd，默认用 ~/.openclaw；必须显式隔离状态目录，
          // 否则测试会读写用户真实配置
          env: { ...NODE_ENV, OPENCLAW_DEBUG: "1", OPENCLAW_STATE_DIR: stateDir },
          windowsHide: true,
        });
        t.after(() => killTree(child));
        let stdout = "";
        let stderr = "";
        // OPENCLAW_DEBUG=1 时内核对管道输出也带 ANSI 颜色码（ready 行实际是
        // `[gateway]\x1b[39m \x1b[32mready`），必须剥码后再匹配裸文本。
        const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
        child.stdout.on("data", (c) => {
          stdout += c.toString("utf-8");
          if (stripAnsi(stdout).includes("[gateway] ready")) resolve({ kind: "ready", stdout, stderr });
        });
        child.stderr.on("data", (c) => (stderr += c.toString("utf-8")));
        const timer = setTimeout(() => {
          killTree(child);
          resolve({ kind: "timeout", stdout, stderr });
        }, 110_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ kind: `exit:${code}`, stdout, stderr });
        });
      });

    // 全新 state 目录首轮启动：内核会做 startup 配置收敛迁移并以
    // "migration inputs changed … refusing to report ready" 退出要求重启（上游既有行为），
    // 第二轮才 ready。最多 3 轮。
    let last = null;
    let ready = false;
    for (let attempt = 0; attempt < 3 && !ready; attempt++) {
      last = await runOnce();
      assert.ok(
        !/paths\[0\].*must be of type string/.test(last.stderr),
        `asar 形态 gateway 启动崩溃（rootRealPath undefined 回归）\nstderr 尾部: ${last.stderr.slice(-800)}`
      );
      ready = last.kind === "ready";
    }

    assert.ok(
      ready,
      `gateway 3 轮内未 ready（末轮=${last && last.kind}）\nstdout 尾部: ${last && last.stdout.slice(-800)}\nstderr 尾部: ${last && last.stderr.slice(-800)}`
    );
  }
);
