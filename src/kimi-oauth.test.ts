import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { OAuthToken } from "./kimi-oauth";

// 隔离真实用户目录：token 文件读写全部指向临时 OPENCLAW_STATE_DIR，
// 必须在 import "./kimi-oauth" 之前生效——该模块经 logger/constants 间接
// 使用 resolveUserStateDir()，故测试内统一动态 import（CJS 下 import 语句
// 会被提前到文件头，静态 import 拿不到这里设置的 env）
const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-test-"));
process.env.OPENCLAW_STATE_DIR = tmpStateDir;

after(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

function tokenPath(): string {
  return path.join(tmpStateDir, "credentials", "kimi-oauth-token.json");
}

function writeTokenFile(token: OAuthToken): void {
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  fs.writeFileSync(tokenPath(), JSON.stringify(token), "utf-8");
}

function tokenFileExists(): boolean {
  return fs.existsSync(tokenPath());
}

type PostForm = (
  urlPath: string,
  body: Record<string, string>,
) => Promise<{ status: number; data: Record<string, unknown> }>;

function makeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: 1,
    scope: "",
    token_type: "Bearer",
    ...overrides,
  };
}

test("P0-8：并发两次 refreshOAuthToken 只发一次网络请求，共享结果", async () => {
  const { refreshOAuthToken, loadOAuthToken } = await import("./kimi-oauth");
  let calls = 0;
  let release!: (v: { status: number; data: Record<string, unknown> }) => void;
  const gate = new Promise<{ status: number; data: Record<string, unknown> }>((r) => {
    release = r;
  });
  const postForm: PostForm = () => {
    calls += 1;
    return gate;
  };

  const token = makeToken();
  const p1 = refreshOAuthToken(token, { postForm });
  const p2 = refreshOAuthToken(token, { postForm });
  assert.equal(calls, 1, "in-flight 去重：第二个调用复用同一请求");

  release({ status: 200, data: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 } });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2, "两个调用方拿到同一刷新结果");
  assert.equal(loadOAuthToken()?.refresh_token, "refresh-2", "新 token 已落盘");

  // in-flight 已清空：再次刷新会发新请求
  let calls2 = 0;
  const deps2 = {
    postForm: async () => {
      calls2 += 1;
      return { status: 200, data: { access_token: "access-3", expires_in: 7200 } };
    },
  };
  await refreshOAuthToken(makeToken({ refresh_token: "refresh-2" }), deps2);
  assert.equal(calls2, 1, "完成后 in-flight 清除，后续刷新正常发起");
});

test("P0-8：invalid_grant 且磁盘上 refresh_token 已被对手方更新 → 不删 token 文件", async () => {
  const { refreshOAuthToken } = await import("./kimi-oauth");
  writeTokenFile(makeToken({ refresh_token: "refresh-NEW" }));
  const deps = {
    postForm: async () => ({ status: 400, data: { error: "invalid_grant" } }),
  };

  await assert.rejects(
    refreshOAuthToken(makeToken({ refresh_token: "refresh-OLD" }), deps),
    /登录已过期/,
  );
  assert.ok(tokenFileExists(), "文件仍在：失败请求用的是旧 refresh_token，不能误删新 token");
});

test("P0-8：invalid_grant 且磁盘上 refresh_token 未变 → 删除 token 文件", async () => {
  const { refreshOAuthToken, loadOAuthToken } = await import("./kimi-oauth");
  writeTokenFile(makeToken({ refresh_token: "refresh-OLD" }));
  const deps = {
    postForm: async () => ({ status: 400, data: { error: "invalid_grant" } }),
  };

  await assert.rejects(
    refreshOAuthToken(makeToken({ refresh_token: "refresh-OLD" }), deps),
    /登录已过期/,
  );
  assert.equal(loadOAuthToken(), null, "文件已删：refresh_token 未变，确属作废");
});

test("F6：响应缺 expires_in → expires_at 兜底为 now+3600 而非 NaN", async () => {
  const { refreshOAuthToken } = await import("./kimi-oauth");
  const deps = {
    postForm: async () => ({ status: 200, data: { access_token: "access-2" } }),
  };

  const refreshed = await refreshOAuthToken(makeToken(), deps);
  assert.ok(Number.isFinite(refreshed.expires_at), "expires_at 必须是有限数");
  const remaining = refreshed.expires_at - Math.floor(Date.now() / 1000);
  assert.ok(remaining > 3500 && remaining <= 3600, `expires_at 应约为 now+3600，实际余量 ${remaining}s`);
});
