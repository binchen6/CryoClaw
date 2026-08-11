const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// gateway-ctl.mjs 是 ESM，CJS 测试里走动态 import
let ctl;
test.before(async () => {
  ctl = await import("./updater/gateway-ctl.mjs");
});

// 收集输出的 io 注入
function makeIo(env) {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env },
    out,
    err,
  };
}

// 构造临时状态目录，写入 gatewayControl 连接信息
function makeStateDir(ctlConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-gwctl-test-"));
  if (ctlConfig) {
    fs.writeFileSync(
      path.join(dir, "cryoclaw.config.json"),
      JSON.stringify({ gatewayControl: ctlConfig }),
    );
  }
  return dir;
}

// 占一个随机端口后立即关闭，返回该端口（大概率空闲，用于模拟服务不可达）
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test("parseGatewayCommand 子命令路由", () => {
  const restart = ctl.parseGatewayCommand(["gateway", "restart"]);
  assert.equal(restart.kind, "call");
  assert.equal(restart.method, "POST");
  assert.equal(restart.path, "/gateway/restart");

  const status = ctl.parseGatewayCommand(["gateway", "status"]);
  assert.equal(status.kind, "call");
  assert.equal(status.method, "GET");
  assert.equal(status.path, "/gateway/status");

  // 无 "gateway" 前缀（直接调用）也能路由
  assert.equal(ctl.parseGatewayCommand(["restart"]).kind, "call");

  // 托管不支持的子命令
  for (const sub of ["stop", "start", "install", "uninstall", "reload"]) {
    const parsed = ctl.parseGatewayCommand(["gateway", sub]);
    assert.equal(parsed.kind, "unsupported", `${sub} 应路由到 unsupported`);
    assert.equal(parsed.sub, sub);
  }

  // 空参数 / help
  assert.equal(ctl.parseGatewayCommand(["gateway"]).kind, "help");
  assert.equal(ctl.parseGatewayCommand(["gateway", "--help"]).kind, "help");
});

test("不支持的子命令打印托管说明并返回退出码 2", async () => {
  const { io, err } = makeIo({});
  const code = await ctl.runGatewayCtl(["gateway", "stop"], io);
  assert.equal(code, 2);
  assert.match(err.join("\n"), /由 CryoClaw 托管/);
  assert.match(err.join("\n"), /openclaw gateway restart \/ status/);
});

test("配置缺失（无 token）提示版本过旧或未初始化，退出码 1", async () => {
  const dir = makeStateDir(null);
  try {
    const { io, err } = makeIo({ OPENCLAW_STATE_DIR: dir });
    const code = await ctl.runGatewayCtl(["gateway", "restart"], io);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /版本过旧或尚未初始化/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("控制服务不可达（应用未运行）返回中文报错，退出码 1", async () => {
  const port = await getFreePort();
  const dir = makeStateDir({ port, token: "tok" });
  try {
    const { io, err } = makeIo({ OPENCLAW_STATE_DIR: dir });
    const code = await ctl.runGatewayCtl(["gateway", "restart"], io);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /CryoClaw 未运行/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restart/status 经由控制服务成功执行", async () => {
  const token = "test-token-32chars";
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "POST" && req.url === "/gateway/restart") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && req.url === "/gateway/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, running: true, pid: 42, port: 18789, uptimeMs: 100 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const dir = makeStateDir({ port, token });

  try {
    const env = { OPENCLAW_STATE_DIR: dir };

    const restart = makeIo(env);
    assert.equal(await ctl.runGatewayCtl(["gateway", "restart"], restart.io), 0);
    assert.match(restart.out.join("\n"), /已重启/);

    const status = makeIo(env);
    assert.equal(await ctl.runGatewayCtl(["gateway", "status"], status.io), 0);
    const payload = JSON.parse(status.out.join(""));
    assert.equal(payload.ok, true);
    assert.equal(payload.running, true);
    assert.equal(payload.pid, 42);

    assert.deepEqual(seen, ["POST /gateway/restart", "GET /gateway/status"]);

    // token 不匹配 → 服务端 401 → 退出码 1
    const badDir = makeStateDir({ port, token: "wrong-token" });
    try {
      const denied = makeIo({ OPENCLAW_STATE_DIR: badDir });
      assert.equal(await ctl.runGatewayCtl(["gateway", "status"], denied.io), 1);
      assert.match(denied.err.join("\n"), /鉴权失败/);
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("控制服务返回失败（restart 未过健康检查）时透传错误，退出码 1", async () => {
  const token = "tok";
  const server = http.createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Gateway 重启后未通过健康检查" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const dir = makeStateDir({ port: server.address().port, token });
  try {
    const { io, err } = makeIo({ OPENCLAW_STATE_DIR: dir });
    const code = await ctl.runGatewayCtl(["gateway", "restart"], io);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /健康检查/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
