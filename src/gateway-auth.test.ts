import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureGatewayAuthTokenInConfig, resolveGatewayAuthToken } from "./gateway-auth";

// 在临时 OPENCLAW_STATE_DIR 下运行 fn，结束后恢复环境变量并清理目录
function withTempStateDir(fn: (configPath: string) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-auth-"));
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  try {
    fn(path.join(tmpDir, "openclaw.json"));
  } finally {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("ensureGatewayAuthTokenInConfig 应为 Electron file:// 场景补全 null origin 白名单", () => {
  // 模拟首次初始化配置：仅有最小 gateway 配置。
  const config: Record<string, any> = {
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
      },
    },
  };

  ensureGatewayAuthTokenInConfig(config);

  assert.ok(Array.isArray(config.gateway.controlUi?.allowedOrigins));
  assert.ok(config.gateway.controlUi.allowedOrigins.includes("null"));
});

test("ensureGatewayAuthTokenInConfig 不应覆盖用户已有 allowedOrigins", () => {
  // 用户已配置自定义来源时，函数只做补全不做破坏性覆盖。
  const config: Record<string, any> = {
    gateway: {
      controlUi: {
        allowedOrigins: ["https://control.example.com"],
      },
      auth: {
        mode: "token",
        token: "fixed-token",
      },
    },
  };

  ensureGatewayAuthTokenInConfig(config);

  assert.ok(config.gateway.controlUi.allowedOrigins.includes("https://control.example.com"));
  assert.ok(config.gateway.controlUi.allowedOrigins.includes("null"));
});

// 缓存相关的断言集中在本用例内按序执行：gateway-auth 的随机 token 缓存是模块级状态，
// 分多个用例会互相污染（node:test 同文件顺序执行，单用例内顺序稳定）。
test("resolveGatewayAuthToken 读不到真实 token 时进程内复用同一随机值，真实 token 出现后覆盖缓存", () => {
  withTempStateDir((configPath) => {
    // 1) 配置不存在（首启 Setup 未完成）：两次调用必须是同一个 token，否则首窗 URL 里的
    //    token 与 gateway 启动所用的 token 不一致 → 首连必 401
    const first = resolveGatewayAuthToken({ persist: false });
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.equal(resolveGatewayAuthToken({ persist: false }), first);
    assert.equal(resolveGatewayAuthToken(), first, "persist 默认路径同样命中「无配置」分支");

    // 2) 配置损坏（JSON 解析失败）：沿用同一 token
    fs.writeFileSync(configPath, "{ 这不是合法 JSON", "utf-8");
    assert.equal(resolveGatewayAuthToken({ persist: false }), first);

    // 3) 配置存在且带真实 token：改走配置 token（只读模式不得覆盖/改写配置）
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { mode: "token", token: "real-token-1234" } } }),
      "utf-8",
    );
    assert.equal(resolveGatewayAuthToken({ persist: false }), "real-token-1234");
    assert.equal(resolveGatewayAuthToken({ persist: false }), "real-token-1234");

    // 4) 真实 token 已覆盖缓存：配置此后消失也不再退回新的随机值，保持与 gateway 一致
    fs.rmSync(configPath);
    assert.equal(resolveGatewayAuthToken({ persist: false }), "real-token-1234");
  });
});

test("resolveGatewayAuthToken 配置可解析但 token 缺失时（persist:false）不每次随机", () => {
  withTempStateDir((configPath) => {
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { mode: "token" } } }), "utf-8");
    const first = resolveGatewayAuthToken({ persist: false });
    assert.ok(first.length > 0);
    assert.equal(resolveGatewayAuthToken({ persist: false }), first);
  });
});
