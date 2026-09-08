import test from "node:test";
import assert from "node:assert/strict";
import {
  applyHooksToDraft,
  applyMcpServersToDraft,
  draftFromServer,
  hooksFromConfig,
  listMcpServers,
  parseKeyValueLines,
  serializeKeyValue,
  serverFromDraft,
  type McpServerDraft,
  type McpServerEntry,
} from "./tab-mcp-hooks.lib.ts";

function stdioDraft(over: Partial<McpServerDraft> = {}): McpServerDraft {
  return {
    name: "fs",
    enabled: true,
    transport: "stdio",
    command: "npx",
    argsText: "-y\n@modelcontextprotocol/server-filesystem\n/tmp",
    envText: "API_KEY=abc\n EMPTY= \nbadline",
    cwd: "",
    url: "",
    headersText: "",
    ...over,
  };
}

test("parseKeyValueLines：env 形态取 = 分隔、忽略空键与畸形行", () => {
  assert.deepEqual(parseKeyValueLines("A=1\nB = 2\n=\nx\nC=3=", "env"), { A: "1", B: "2", C: "3=" });
});

test("parseKeyValueLines：headers 形态取首个冒号、可带端口", () => {
  assert.deepEqual(parseKeyValueLines("Authorization: Bearer x\nX-Host: http://a:8080", "headers"), {
    Authorization: "Bearer x",
    "X-Host": "http://a:8080",
  });
});

test("serializeKeyValue 往返稳定（跳过 null/undefined）", () => {
  const obj = { A: "1", B: "2", C: undefined, D: null as unknown };
  const text = serializeKeyValue(obj as Record<string, unknown>, "=");
  assert.equal(text, "A=1\nB=2");
  assert.deepEqual(parseKeyValueLines(text, "env"), { A: "1", B: "2" });
});

test("serverFromDraft：stdio 产出 command/args/env、忽略 url 侧字段、enabled 恒显式", () => {
  const r = serverFromDraft(stdioDraft());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.server, {
    enabled: true,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: { API_KEY: "abc", EMPTY: "" },
    transport: "stdio",
  });
  assert.equal("url" in r.server, false);
  assert.equal("headers" in r.server, false);
});

test("serverFromDraft：enabled=false 显式落盘（RFC7396 布尔语义）", () => {
  const r = serverFromDraft(stdioDraft({ enabled: false }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.server.enabled, false);
});

test("serverFromDraft：http 产出 url/headers、忽略 stdio 侧字段", () => {
  const r = serverFromDraft(stdioDraft({
    name: "remote",
    transport: "streamable-http",
    command: "",
    argsText: "",
    envText: "",
    url: "https://mcp.example.com/mcp",
    headersText: "Authorization: Bearer t",
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.server.url, "https://mcp.example.com/mcp");
  assert.deepEqual(r.server.headers, { Authorization: "Bearer t" });
  assert.equal("command" in r.server, false);
  assert.equal(r.server.transport, "streamable-http");
});

test("serverFromDraft：校验错误逐项覆盖", () => {
  assert.deepEqual(serverFromDraft(stdioDraft({ name: "" })), { ok: false, error: "nameEmpty" });
  assert.deepEqual(serverFromDraft(stdioDraft({ name: " a " })), { ok: false, error: "nameWhitespace" });
  assert.deepEqual(serverFromDraft(stdioDraft({ name: "a.b" })), { ok: false, error: "nameInvalid" });
  assert.deepEqual(serverFromDraft(stdioDraft({ command: "" })), { ok: false, error: "commandMissing" });
  assert.deepEqual(
    serverFromDraft(stdioDraft({ transport: "sse", command: "", url: "ftp://x" })),
    { ok: false, error: "urlInvalid" },
  );
  assert.deepEqual(
    serverFromDraft(stdioDraft({ transport: "sse", command: "", url: "not a url" })),
    { ok: false, error: "urlInvalid" },
  );
});

test("listMcpServers + draftFromServer 往返（高级字段保留在 entry，不进草稿）", () => {
  const config = {
    mcp: {
      servers: {
        fs: { command: "npx", args: ["-y", "x"], enabled: false, connectionTimeoutMs: 2500 },
        remote: { url: "https://r/mcp", transport: "sse", headers: { A: "b" } },
      },
    },
  };
  const list = listMcpServers(config);
  assert.deepEqual(list.map((e) => e.name), ["fs", "remote"]);
  const draft = draftFromServer(list[0]);
  assert.equal(draft.enabled, false);
  assert.equal(draft.command, "npx");
  assert.equal(draft.argsText, "-y\nx");
  // 高级字段仍在 entry.server，供 preserve 回写
  assert.equal(list[0].server.connectionTimeoutMs, 2500);
});

test("applyMcpServersToDraft：删除的名字显式 null、保留者整体覆盖、preserve 合并高级字段", () => {
  const draft = {
    mcp: {
      servers: {
        old: { command: "x", connectionTimeoutMs: 9999 },
        keep: { command: "old-cmd", enabled: true },
      },
    },
  };
  const entry: McpServerEntry = {
    name: "keep",
    server: { enabled: true, command: "new-cmd", transport: "stdio" },
  };
  applyMcpServersToDraft(draft, [entry], { keep: draft.mcp.servers.keep as Record<string, unknown> });
  assert.equal(draft.mcp.servers.old, null);
  assert.deepEqual(draft.mcp.servers.keep, {
    enabled: true,
    command: "new-cmd",
    transport: "stdio",
  });
});

test("applyMcpServersToDraft：preserve 只保留表单未独占字段——transport 切换不残留对侧字段", () => {
  const draft = {
    mcp: {
      servers: {
        s: { url: "https://r/mcp", transport: "sse", headers: { A: "b" }, connectionTimeoutMs: 2500 },
      },
    },
  };
  applyMcpServersToDraft(
    draft,
    [{ name: "s", server: { enabled: true, command: "npx", transport: "stdio" } }],
    { s: draft.mcp.servers.s as Record<string, unknown> },
  );
  const merged = draft.mcp.servers.s as Record<string, unknown>;
  assert.equal("url" in merged, false); // 旧 url 不残留
  assert.equal("headers" in merged, false); // 旧 headers 不残留
  assert.equal(merged.connectionTimeoutMs, 2500); // 高级字段保留
  assert.equal(merged.command, "npx");
  assert.equal(merged.transport, "stdio");
});

test("applyMcpServersToDraft：重命名（删旧名 + 加新名）", () => {
  const draft: Record<string, unknown> = { mcp: { servers: { a: { command: "x" } } } };
  applyMcpServersToDraft(draft, [{ name: "b", server: { command: "x", enabled: true, transport: "stdio" } }]);
  const servers = (draft.mcp as { servers: Record<string, unknown> }).servers;
  assert.equal(servers.a, null);
  assert.equal((servers.b as { command: string }).command, "x");
});

test("applyMcpServersToDraft：清空 → mcp.servers 删除", () => {
  const draft = { mcp: { servers: { a: { command: "x" } } }, other: 1 };
  applyMcpServersToDraft(draft, []);
  assert.equal("mcp" in draft, false);
  assert.equal(draft.other, 1);
});

/* ── hooks ── */

test("hooksFromConfig：字段解析 + extras 剥离", () => {
  const config = {
    hooks: {
      enabled: true,
      path: "/hooks",
      token: "__OPENCLAW_REDACTED__",
      defaultSessionKey: "agent:main:main",
      gmail: { account: "a" },
      mappings: [
        {
          id: "m1",
          match: { path: "/gh", source: "github" },
          action: "agent",
          name: "github",
          sessionKey: "s1",
          sessionMode: "persistent",
          messageTemplate: "tpl",
          channel: "feishu",
          to: "u1",
        },
        { match: { path: "/wake" }, action: "wake" },
      ],
    },
  };
  const h = hooksFromConfig(config);
  assert.equal(h.enabled, true);
  assert.equal(h.token, "__OPENCLAW_REDACTED__");
  assert.equal(h.mappings.length, 2);
  assert.equal(h.mappings[0].matchPath, "/gh");
  assert.deepEqual(h.mappingExtras.m1, { channel: "feishu", to: "u1" });
  assert.equal(h.mappings[1].id, "mapping-1"); // 无 id 的兜底命名
});

test("hooksFromConfig：无 id 兜底名与既有 id 碰撞时自动避让（防内核按 id 合并丢条目）", () => {
  const config = {
    hooks: {
      mappings: [
        { match: { path: "/a" } }, // 兜底 mapping-0
        { id: "mapping-0", match: { path: "/b" } }, // 真实 id 与兜底碰撞
        { match: { path: "/c" } }, // 兜底 mapping-2
      ],
    },
  };
  const h = hooksFromConfig(config);
  const ids = h.mappings.map((m) => m.id);
  assert.equal(new Set(ids).size, 3); // 无重复
  assert.equal(ids[0], "mapping-0");
  assert.equal(ids[1], "mapping-0-x"); // 碰撞方避让
  assert.equal(ids[2], "mapping-2");
});

test("applyHooksToDraft：owned 字段显式、extras 回写、保留未编辑子段", () => {
  const draft = {
    hooks: {
      enabled: false,
      path: "/old",
      token: "__OPENCLAW_REDACTED__",
      gmail: { account: "a" },
      mappings: [{ id: "m1", match: { path: "/gh" }, name: "old", channel: "feishu" }],
    },
  };
  const h = hooksFromConfig(draft);
  h.enabled = true;
  h.path = "/new";
  // token 未动 → 哨兵透传
  applyHooksToDraft(draft, h);
  assert.equal(draft.hooks.enabled, true);
  assert.equal(draft.hooks.path, "/new");
  assert.equal(draft.hooks.token, "__OPENCLAW_REDACTED__");
  assert.deepEqual(draft.hooks.gmail, { account: "a" }); // 未编辑子段保留
  assert.equal(draft.hooks.mappings.length, 1);
  assert.equal(draft.hooks.mappings[0].name, "old"); // 未改字段原值
  assert.equal(draft.hooks.mappings[0].channel, "feishu"); // extras 回写
});

test("applyHooksToDraft：清空 owned 字段 → null 删除；清空 mappings → 删键", () => {
  const draft = { hooks: { enabled: true, path: "/old", token: "t", mappings: [{ id: "m1", match: { path: "/a" } }] } };
  const h = hooksFromConfig(draft);
  h.path = "";
  h.token = "";
  h.mappings = [];
  applyHooksToDraft(draft, h);
  assert.equal(draft.hooks.path, null);
  assert.equal(draft.hooks.token, null);
  assert.equal("mappings" in draft.hooks, false);
  assert.equal(draft.hooks.enabled, true);
});

test("applyHooksToDraft：agent+persistent 无 sessionKey 锚点时不落 sessionMode（内核 superRefine 规避）", () => {
  const draft: Record<string, unknown> = {};
  const h: import("./tab-mcp-hooks.lib.ts").HooksState = {
    enabled: true, path: "", token: "", defaultSessionKey: "",
    mappings: [{ id: "m1", matchPath: "/x", matchSource: "", action: "agent", name: "n", sessionKey: "", sessionMode: "persistent", messageTemplate: "" }],
    mappingExtras: {},
  };
  applyHooksToDraft(draft, h);
  assert.equal("sessionMode" in (draft.hooks as { mappings: Array<Record<string, unknown>> }).mappings[0], false);
  // 有 defaultSessionKey 锚点时正常落
  const draft2: Record<string, unknown> = {};
  applyHooksToDraft(draft2, { ...h, defaultSessionKey: "agent:main:main" });
  assert.equal((draft2.hooks as { mappings: Array<Record<string, unknown>> }).mappings[0].sessionMode, "persistent");
});

test("applyHooksToDraft：全新空状态不产生 hooks 键", () => {
  const draft: Record<string, unknown> = {};
  applyHooksToDraft(draft, {
    enabled: false, path: "", token: "", defaultSessionKey: "", mappings: [], mappingExtras: {},
  });
  assert.equal("hooks" in draft, false);
});

// R60 审查 P0：mappings 走 replacePaths 整体替换，内核字面整体赋值 + strict schema
// 拒绝 null——条目内空字段必须省略键（不能写 null）
test("applyHooksToDraft：mappings 条目空字段省略键（不产 null，内核 strict schema 兼容）", () => {
  const draft: Record<string, unknown> = {};
  applyHooksToDraft(draft, {
    enabled: true, path: "", token: "", defaultSessionKey: "",
    mappings: [
      // 全空规则：只应有 id（match/action/name/sessionKey/sessionMode/messageTemplate 全省略）
      { id: "m1", matchPath: "", matchSource: "", action: "agent", name: "", sessionKey: "", sessionMode: "isolated", messageTemplate: "" },
      // 部分填写：只出现有值键
      { id: "m2", matchPath: "/gh", matchSource: "", action: "wake", name: "gh", sessionKey: "", sessionMode: "isolated", messageTemplate: "" },
    ],
    mappingExtras: {},
  });
  const mappings = (draft.hooks as { mappings: Array<Record<string, unknown>> }).mappings;
  assert.deepEqual(mappings[0], { id: "m1" }, "全空规则只保留 id");
  assert.deepEqual(
    Object.keys(mappings[1]).sort(),
    ["action", "id", "match", "name"],
    "部分规则只出现有值键（无 null）",
  );
  assert.deepEqual(mappings[1].match, { path: "/gh" });
});

test("validateHooks：agent+persistent 无锚点报错；有 sessionKey/defaultSessionKey/transform 时通过", async () => {
  const { validateHooks } = await import("./tab-mcp-hooks.lib.ts");
  const base = { enabled: true, path: "", token: "", defaultSessionKey: "" };
  const bad = {
    ...base,
    mappings: [{ id: "m1", matchPath: "", matchSource: "", action: "agent" as const, name: "", sessionKey: "", sessionMode: "persistent" as const, messageTemplate: "" }],
    mappingExtras: {},
  };
  assert.equal(validateHooks(bad), "persistentNeedsAnchor");
  assert.equal(validateHooks({ ...bad, defaultSessionKey: "agent:main:main" }), null);
  assert.equal(
    validateHooks({ ...bad, mappings: [{ ...bad.mappings[0], sessionKey: "s1" }] }),
    null,
  );
  assert.equal(
    validateHooks({ ...bad, mappingExtras: { m1: { transform: { module: "x.ts" } } } }),
    null,
  );
  // wake 不受锚点约束
  assert.equal(
    validateHooks({ ...bad, mappings: [{ ...bad.mappings[0], action: "wake" as const }] }),
    null,
  );
});

// R60 审查 P2：单条目操作不 touch 集合内其他键
test("upsert/removeMcpServerInDraft：并发新增的其他键不受影响", async () => {
  const { upsertMcpServerInDraft, removeMcpServerInDraft } = await import("./tab-mcp-hooks.lib.ts");
  const draft: Record<string, unknown> = { mcp: { servers: { a: { command: "x" } } } };
  upsertMcpServerInDraft(draft, "b", { command: "y", enabled: true, transport: "stdio" });
  let servers = (draft.mcp as { servers: Record<string, unknown> }).servers;
  assert.equal((servers.a as { command: string }).command, "x", "既有条目不动");
  assert.equal((servers.b as { command: string }).command, "y");
  removeMcpServerInDraft(draft, "a");
  servers = (draft.mcp as { servers: Record<string, unknown> }).servers;
  assert.equal(servers.a, null, "删除显式 null");
  assert.equal("b" in servers, true, "并发条目保留");
});

