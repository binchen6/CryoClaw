import assert from "node:assert/strict";
import { buildMergePatch } from "../../controllers/config.ts";
import {
  applyAdvancedSave,
  applyDingtalkSave,
  applyFeishuSave,
  applyKimiSearchSave,
  applyMemorySave,
  applyQqbotSave,
  applyWecomSave,
  applyWeixinSave,
  extractAdvancedView,
  extractDingtalkView,
  extractFeishuView,
  extractKimiSearchView,
  extractMemoryView,
  extractQqbotView,
  extractWecomView,
  extractWeixinEnabled,
  normalizeAllowFromEntries,
  syncPluginAllowOnEnable,
} from "./tab-channels.lib.ts";

/* ── 基础工具 ── */

function testNormalizeAllowFromEntries() {
  assert.deepEqual(normalizeAllowFromEntries(undefined), []);
  assert.deepEqual(normalizeAllowFromEntries("x"), []);
  assert.deepEqual(normalizeAllowFromEntries([" a ", "", "a", null, "b"]), ["a", "b"], "去空去重");
}

function testSyncPluginAllowOnEnable() {
  const draft: Record<string, unknown> = { plugins: { allow: ["a"] } };
  syncPluginAllowOnEnable(draft, "qqbot");
  assert.deepEqual((draft.plugins as any).allow, ["a", "qqbot"], "非空白名单补 id");
  syncPluginAllowOnEnable(draft, "qqbot");
  assert.deepEqual((draft.plugins as any).allow, ["a", "qqbot"], "不重复追加");
  const empty: Record<string, unknown> = { plugins: { allow: [] } };
  syncPluginAllowOnEnable(empty, "qqbot");
  assert.deepEqual((empty.plugins as any).allow, [], "空白名单不动");
  const missing: Record<string, unknown> = {};
  syncPluginAllowOnEnable(missing, "qqbot");
  assert.equal(missing.plugins, undefined, "缺失不动");
}

/* ── 飞书 ── */

function testFeishuExtract() {
  const config = {
    plugins: { entries: { feishu: { enabled: true } } },
    channels: { feishu: { enabled: false, appId: "cli_1", appSecret: "__OPENCLAW_REDACTED__", allowFrom: ["*"], groupAllowFrom: ["oc_abc"] } },
    session: { dmScope: "per-peer" },
  };
  const view = extractFeishuView(config as any);
  assert.equal(view.enabled, true, "legacy plugins.entries 开关优先");
  assert.equal(view.appId, "cli_1");
  assert.equal(view.dmPolicy, "open", "allowFrom 含通配符视为 open");
  assert.equal(view.dmScope, "per-peer");
  assert.deepEqual(view.groupAllowFrom, ["oc_abc"]);

  const empty = extractFeishuView(null);
  assert.deepEqual(empty, {
    enabled: false,
    appId: "",
    appSecret: "",
    dmPolicy: "open",
    dmScope: "main",
    groupPolicy: "allowlist",
    groupAllowFrom: [],
  });
}

function testFeishuSaveRejectsInvalidGroupId() {
  const draft: Record<string, unknown> = {};
  const ok = applyFeishuSave(draft, {
    enabled: true,
    appId: "cli_1",
    appSecret: "sec",
    groupPolicy: "allowlist",
    groupAllowFrom: ["not-a-group"],
  });
  assert.equal(ok, false, "非法群 ID 返回 false");
  assert.equal(draft.channels, undefined, "校验失败不落地任何变更");
}

function testFeishuSaveWildcardAndLegacyCleanup() {
  const draft: Record<string, unknown> = {
    plugins: { entries: { feishu: { enabled: true } } },
    channels: { feishu: { enabled: false, allowFrom: ["ou_old"] } },
  };
  const ok = applyFeishuSave(draft, { enabled: true, appId: "cli_1", appSecret: "sec", dmPolicy: "open" });
  assert.equal(ok, true);
  const feishu = (draft.channels as any).feishu;
  assert.equal(feishu.enabled, true);
  assert.deepEqual(feishu.allowFrom, ["ou_old", "*"], "open 追加通配符并保留旧条目");
  assert.equal(feishu.groupPolicy, "allowlist", "默认群策略");
  assert.equal("groupAllowFrom" in feishu, false, "空群白名单删除字段");
  assert.equal((draft.plugins as any).entries.feishu, undefined, "legacy 开关清除");
  assert.equal(draft.session, undefined, "dmScope main 不残留 session");
}

function testFeishuSavePairingAndDmScope() {
  const draft: Record<string, unknown> = {
    channels: { feishu: { allowFrom: ["*", "ou_a"] } },
    session: { dmScope: "main", other: 1 },
  };
  applyFeishuSave(draft, {
    enabled: true,
    appId: "cli_1",
    appSecret: "sec",
    dmPolicy: "pairing",
    dmScope: "per-peer",
    groupPolicy: "allowlist",
    groupAllowFrom: ["oc_grp1"],
  });
  const feishu = (draft.channels as any).feishu;
  assert.equal(feishu.dmPolicy, "pairing");
  assert.deepEqual(feishu.allowFrom, ["ou_a"], "pairing 剥离通配符");
  assert.deepEqual(feishu.groupAllowFrom, ["oc_grp1"]);
  assert.equal((draft.session as any).dmScope, "per-peer");
  assert.equal((draft.session as any).other, 1, "session 其他字段保留");
}

function testFeishuSaveDisableOnly() {
  const draft: Record<string, unknown> = {
    plugins: { entries: { feishu: { enabled: true } } },
    channels: { feishu: { appId: "cli_1", appSecret: "sec", allowFrom: ["*"] } },
  };
  const ok = applyFeishuSave(draft, { enabled: false });
  assert.equal(ok, true);
  const feishu = (draft.channels as any).feishu;
  assert.equal(feishu.enabled, false);
  assert.equal(feishu.appId, "cli_1", "禁用不动凭据");
  assert.deepEqual(feishu.allowFrom, ["*"], "禁用不动 allowFrom");
  assert.equal((draft.plugins as any).entries.feishu, undefined, "禁用也清 legacy");
}

/* ── QQ Bot ── */

function testQqbotExtract() {
  const config = {
    plugins: { entries: { qqbot: { enabled: true } } },
    channels: { qqbot: { appId: "app1", clientSecret: "__OPENCLAW_REDACTED__", markdownSupport: true } },
  };
  const view = extractQqbotView(config as any);
  assert.equal(view.enabled, true);
  assert.equal(view.appId, "app1");
  assert.equal(view.markdownSupport, true);
  assert.equal(extractQqbotView(null).enabled, false);
}

function testQqbotSaveEnable() {
  const draft: Record<string, unknown> = {
    plugins: { allow: ["kimi-search"], entries: {} },
    channels: { qqbot: { clientSecretFile: "/old/path", sandbox: { mode: "all" } } },
  };
  applyQqbotSave(draft, { enabled: true, appId: "app1", clientSecret: "sec", markdownSupport: true });
  const channel = (draft.channels as any).qqbot;
  assert.equal(channel.enabled, true);
  assert.equal(channel.appId, "app1");
  assert.equal(channel.clientSecret, "sec");
  assert.equal(channel.markdownSupport, true);
  assert.deepEqual(channel.allowFrom, ["*"], "未配置默认允许所有发送者");
  assert.equal("clientSecretFile" in channel, false, "明文密钥时清理 file 旧配置");
  assert.deepEqual(channel.sandbox, { mode: "all" }, "高级字段保留");
  assert.equal((draft.plugins as any).entries.qqbot.enabled, true);
  assert.deepEqual((draft.plugins as any).allow, ["kimi-search", "qqbot"], "plugins.allow 补 id");
}

function testQqbotSaveKeepsExistingAllowFrom() {
  const draft: Record<string, unknown> = { channels: { qqbot: { allowFrom: ["u1", "u2"] } } };
  applyQqbotSave(draft, { enabled: true, appId: "app1", clientSecret: "sec" });
  assert.deepEqual((draft.channels as any).qqbot.allowFrom, ["u1", "u2"], "已有 allowFrom 保留");
}

function testQqbotSaveDisableKeepsCredentials() {
  const draft: Record<string, unknown> = { channels: { qqbot: { appId: "app1", clientSecret: "sec" } } };
  applyQqbotSave(draft, { enabled: false });
  const channel = (draft.channels as any).qqbot;
  assert.equal(channel.enabled, false);
  assert.equal(channel.appId, "app1", "禁用保留凭据");
  assert.equal(channel.clientSecret, "sec");
  assert.equal((draft.plugins as any).entries.qqbot.enabled, false);
}

/* ── 钉钉 ── */

function testDingtalkExtract() {
  const config = {
    plugins: { entries: { "dingtalk-connector": { enabled: true } } },
    channels: { "dingtalk-connector": { clientId: "cid", clientSecret: "sec", sessionTimeout: 60000 } },
  };
  const view = extractDingtalkView(config as any);
  assert.equal(view.enabled, true);
  assert.equal(view.clientId, "cid");
  assert.equal(view.sessionTimeout, 60000);
  assert.equal(extractDingtalkView(null).sessionTimeout, 30 * 60 * 1000, "默认 30 分钟");
}

function testDingtalkSaveStripsDeprecatedAndFillsGateway() {
  const draft: Record<string, unknown> = {
    channels: { "dingtalk-connector": { gatewayToken: "old", sessionTimeout: 60000, clientId: "old-id" } },
  };
  applyDingtalkSave(draft, { enabled: true, clientId: "cid", clientSecret: "sec" });
  const channel = (draft.channels as any)["dingtalk-connector"];
  assert.equal(channel.enabled, true);
  assert.equal(channel.clientId, "cid");
  assert.equal("gatewayToken" in channel, false, "剥离 gatewayToken");
  assert.equal("sessionTimeout" in channel, false, "剥离 sessionTimeout");
  const gateway = draft.gateway as any;
  assert.equal(gateway.auth.mode, "token");
  assert.match(gateway.auth.token, /^[0-9a-f]{32}$/, "缺失时生成 32 位 hex token");
  assert.equal(gateway.mode, "local", "空 mode 补 local");
  assert.equal(gateway.http.endpoints.chatCompletions.enabled, true, "补齐 chatCompletions 端点");
}

function testDingtalkSaveKeepsExistingTokenAndEndpointFlags() {
  const draft: Record<string, unknown> = {
    gateway: {
      auth: { token: "__OPENCLAW_REDACTED__" },
      mode: "remote",
      http: { endpoints: { chatCompletions: { enabled: false, customFlag: 1 } } },
    },
  };
  applyDingtalkSave(draft, { enabled: true, clientId: "cid", clientSecret: "sec" });
  const gateway = draft.gateway as any;
  assert.equal(gateway.auth.token, "__OPENCLAW_REDACTED__", "REDACTED 哨兵原样保留");
  assert.equal(gateway.mode, "remote", "已有 mode 不覆盖");
  assert.equal(gateway.http.endpoints.chatCompletions.enabled, true);
  assert.equal(gateway.http.endpoints.chatCompletions.customFlag, 1, "端点自定义字段保留");
}

function testDingtalkSaveDisableStripsToo() {
  const draft: Record<string, unknown> = {
    channels: { "dingtalk-connector": { gatewayToken: "old", sessionTimeout: 1, clientId: "cid" } },
  };
  applyDingtalkSave(draft, { enabled: false });
  const channel = (draft.channels as any)["dingtalk-connector"];
  assert.equal(channel.enabled, false);
  assert.equal(channel.clientId, "cid", "禁用保留凭据");
  assert.equal("gatewayToken" in channel, false, "禁用路径同样剥离旧字段");
  assert.equal("sessionTimeout" in channel, false);
  assert.equal(draft.gateway, undefined, "禁用不触碰 gateway");
}

/* ── 企业微信 ── */

function testWecomExtract() {
  const config = {
    plugins: { entries: { "wecom-openclaw-plugin": { enabled: true } } },
    channels: { wecom: { botId: "bot1", secret: "s", dmPolicy: "pairing", groupPolicy: "allowlist", groupAllowFrom: ["g1"] } },
  };
  const view = extractWecomView(config as any);
  assert.equal(view.enabled, true);
  assert.equal(view.botId, "bot1");
  assert.equal(view.dmPolicy, "pairing");
  assert.equal(view.groupPolicy, "allowlist");
  assert.deepEqual(view.groupAllowFrom, ["g1"]);
  const empty = extractWecomView(null);
  assert.equal(empty.dmPolicy, "open", "默认 open");
  assert.equal(empty.groupPolicy, "open");
}

function testWecomSaveOpenWritesWildcard() {
  const draft: Record<string, unknown> = { channels: { wecom: { allowFrom: ["u1"], advanced: { x: 1 } } } };
  applyWecomSave(draft, { enabled: true, botId: "bot1", secret: "s", dmPolicy: "open", groupPolicy: "open" });
  const channel = (draft.channels as any).wecom;
  assert.equal(channel.enabled, true);
  assert.deepEqual(channel.allowFrom, ["*"], "open 强制通配符");
  assert.deepEqual(channel.advanced, { x: 1 }, "高级字段保留");
  assert.equal((draft.plugins as any).entries["wecom-openclaw-plugin"].enabled, true);
}

function testWecomSavePairingPreservesAllowFrom() {
  const draft: Record<string, unknown> = { channels: { wecom: { allowFrom: ["*", "u1"], groupAllowFrom: ["g1"] } } };
  applyWecomSave(draft, { enabled: true, botId: "bot1", secret: "s", dmPolicy: "pairing" });
  const channel = (draft.channels as any).wecom;
  assert.equal(channel.dmPolicy, "pairing");
  assert.deepEqual(channel.allowFrom, ["*", "u1"], "pairing 保留现有 allowFrom");
  assert.deepEqual(channel.groupAllowFrom, ["g1"], "groupAllowFrom 未传时保留现有");
  assert.equal(channel.groupPolicy, "open", "groupPolicy 未传时按现有/默认");
}

function testWecomSaveDisableKeepsCredentials() {
  const draft: Record<string, unknown> = { channels: { wecom: { botId: "bot1", secret: "s" } } };
  applyWecomSave(draft, { enabled: false });
  const channel = (draft.channels as any).wecom;
  assert.equal(channel.enabled, false);
  assert.equal(channel.botId, "bot1", "禁用保留凭据");
  assert.equal((draft.plugins as any).entries["wecom-openclaw-plugin"].enabled, false);
}

/* ── 微信 ── */

function testWeixinSave() {
  const draft: Record<string, unknown> = { channels: { "openclaw-weixin": { foo: 1 } } };
  applyWeixinSave(draft, true);
  const channel = (draft.channels as any)["openclaw-weixin"];
  assert.equal(channel.enabled, true);
  assert.equal(channel.foo, 1, "已有字段保留");
  assert.equal(typeof channel.channelConfigUpdatedAt, "string", "写入 channelConfigUpdatedAt");
  assert.ok(!Number.isNaN(Date.parse(channel.channelConfigUpdatedAt)), "ISO 时间格式");
  assert.equal((draft.plugins as any).entries["openclaw-weixin"].enabled, true);
  assert.equal(extractWeixinEnabled(draft), true);
  applyWeixinSave(draft, false);
  assert.equal(extractWeixinEnabled(draft), false);
}

/* ── Kimi Search ── */

function testKimiSearchExtract() {
  const config = {
    plugins: { entries: { "kimi-search": { enabled: true, config: { search: { baseUrl: "http://127.0.0.1:8080/search" } } } } },
    models: { providers: { "kimi-coding": { apiKey: "__OPENCLAW_REDACTED__" } } },
  };
  const view = extractKimiSearchView(config as any);
  assert.equal(view.enabled, true);
  assert.equal(view.serviceBaseUrl, "http://127.0.0.1:8080", "去掉末尾 /search");
  assert.equal(view.isKimiCodeConfigured, true);
  const empty = extractKimiSearchView(null);
  assert.equal(empty.serviceBaseUrl, "");
  assert.equal(empty.isKimiCodeConfigured, false);
}

function testKimiSearchSave() {
  const draft: Record<string, unknown> = {
    plugins: { allow: ["qqbot"], entries: { "kimi-search": { enabled: false, config: { other: 1 } } } },
  };
  applyKimiSearchSave(draft, { enabled: true, serviceBaseUrl: "http://127.0.0.1:8080" });
  const entry = (draft.plugins as any).entries["kimi-search"];
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.config, {
    other: 1,
    search: { baseUrl: "http://127.0.0.1:8080/search" },
    fetch: { baseUrl: "http://127.0.0.1:8080/fetch" },
  }, "写入 search/fetch 端点并保留其他 config");
  assert.deepEqual((draft.plugins as any).allow, ["qqbot", "kimi-search"], "启用时同步白名单");

  applyKimiSearchSave(draft, { enabled: true, serviceBaseUrl: "  " });
  const entry2 = (draft.plugins as any).entries["kimi-search"];
  assert.equal("config" in entry2, false, "空 baseUrl 清除 config 回默认");

  applyKimiSearchSave(draft, { enabled: false });
  assert.equal((draft.plugins as any).entries["kimi-search"].enabled, false);
  assert.deepEqual((draft.plugins as any).allow, ["qqbot", "kimi-search"], "禁用不动白名单");
}

/* ── 记忆 ── */

function testMemoryExtract() {
  const config = {
    hooks: { internal: { entries: { "session-memory": { enabled: false } } } },
    agents: { defaults: { memorySearch: { enabled: true, provider: "openai", model: "bge_m3_embed" } } },
    models: { providers: { "kimi-coding": { apiKey: "proxy-managed" } } },
  };
  const view = extractMemoryView(config as any);
  assert.equal(view.sessionMemoryEnabled, false);
  assert.equal(view.embeddingEnabled, true);
  assert.equal(view.isKimiCodeConfigured, true);
  const empty = extractMemoryView(null);
  assert.equal(empty.sessionMemoryEnabled, true, "未配置过视为开启");
  assert.equal(empty.embeddingEnabled, false);
}

function testMemorySaveEmbeddingOn() {
  const draft: Record<string, unknown> = {};
  applyMemorySave(draft, { sessionMemoryEnabled: true, embeddingEnabled: true, proxyPort: 9090 });
  const ms = (draft.agents as any).defaults.memorySearch;
  assert.deepEqual(ms, {
    enabled: true,
    provider: "openai",
    model: "bge_m3_embed",
    remote: { baseUrl: "http://127.0.0.1:9090/coding/v1/", apiKey: "proxy-managed" },
  });
  assert.equal((draft.hooks as any).internal.entries["session-memory"].enabled, true);
}

function testMemorySaveEmbeddingOnWithoutPort() {
  const draft: Record<string, unknown> = {};
  applyMemorySave(draft, { sessionMemoryEnabled: false, embeddingEnabled: true, proxyPort: 0 });
  assert.equal((draft.agents as any).defaults.memorySearch, undefined, "proxyPort<=0 不写 memorySearch");
  assert.equal((draft.hooks as any).internal.entries["session-memory"].enabled, false);
}

function testMemorySaveEmbeddingOff() {
  const draft: Record<string, unknown> = {
    agents: { defaults: { memorySearch: { enabled: true, provider: "openai", model: "bge_m3_embed", remote: { baseUrl: "x", apiKey: "y" } } } },
  };
  applyMemorySave(draft, { embeddingEnabled: false });
  const ms = (draft.agents as any).defaults.memorySearch;
  assert.deepEqual(ms, { enabled: true }, "只删 provider/model/remote，保留 enabled");
}

/* ── 高级 ── */

function testAdvancedExtractDefaults() {
  const view = extractAdvancedView(null);
  assert.deepEqual(view, {
    gatewayReloadMode: "hybrid",
    execMode: "ask",
    execHost: "auto",
    execReviewerModel: "",
    sandboxMode: "off",
    sandboxWorkspaceAccess: "rw",
    imessageEnabled: true,
  });
}

function testAdvancedExtractApproveAll() {
  const view = extractAdvancedView({
    gateway: { reload: { mode: "hot" } },
    tools: { exec: { mode: "approve-all", host: "gateway", reviewer: { model: "m1" } } },
    agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } } },
    channels: { imessage: { enabled: false } },
  } as any);
  assert.equal(view.gatewayReloadMode, "hot");
  assert.equal(view.execMode, "full", "approve-all 归一化为 full");
  assert.equal(view.execHost, "gateway");
  assert.equal(view.execReviewerModel, "m1");
  assert.equal(view.sandboxMode, "all");
  assert.equal(view.sandboxWorkspaceAccess, "ro");
  assert.equal(view.imessageEnabled, false);
}

function testAdvancedSave() {
  const draft: Record<string, unknown> = { tools: { exec: { reviewer: { model: "m1" } } } };
  applyAdvancedSave(draft, {
    gatewayReloadMode: "hot",
    execMode: "approve-all",
    execHost: "node",
    execReviewerModel: "  ",
    sandboxMode: "non-main",
    sandboxWorkspaceAccess: "none",
    imessageEnabled: false,
  });
  assert.equal((draft.gateway as any).reload.mode, "hot");
  assert.equal((draft.tools as any).exec.mode, "full", "approve-all 归一化");
  assert.equal((draft.tools as any).exec.host, "node");
  assert.equal("reviewer" in (draft.tools as any).exec, false, "空 reviewer model 清理整个 reviewer");
  assert.equal((draft.agents as any).defaults.sandbox.mode, "non-main");
  assert.equal((draft.agents as any).defaults.sandbox.workspaceAccess, "none");
  assert.equal((draft.channels as any).imessage.enabled, false);
}

function testAdvancedSaveInvalidValues() {
  const draft: Record<string, unknown> = { gateway: { reload: { mode: "off" } } };
  applyAdvancedSave(draft, { gatewayReloadMode: "bogus", execMode: "bogus", sandboxMode: "bogus" });
  assert.equal((draft.gateway as any).reload.mode, "off", "非法 reload 值回退 draft 现状");
  assert.equal((draft.tools as any)?.exec, undefined, "非法 exec 值不写");
  assert.equal((draft.agents as any)?.defaults, undefined, "非法 sandbox 值不写");

  const empty: Record<string, unknown> = {};
  applyAdvancedSave(empty, { gatewayReloadMode: "bogus" });
  assert.equal((empty.gateway as any).reload.mode, "hybrid", "从未设置时兜底 hybrid");
}

/* ── 集成：快照 → 多个 save → buildMergePatch ── */

function testMergePatchIntegration() {
  const snapshot = {
    plugins: { allow: ["kimi-search"], entries: {} },
    channels: {
      "dingtalk-connector": { gatewayToken: "old", sessionTimeout: 60000 },
      wecom: { botId: "bot1", secret: "__OPENCLAW_REDACTED__", allowFrom: ["*"] },
    },
    gateway: { auth: { token: "__OPENCLAW_REDACTED__" }, mode: "local" },
  };
  const draft = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  applyDingtalkSave(draft, { enabled: true, clientId: "cid", clientSecret: "sec" });
  applyWecomSave(draft, { enabled: true, botId: "bot1", secret: "__OPENCLAW_REDACTED__", dmPolicy: "open" });
  applyQqbotSave(draft, { enabled: true, appId: "app1", clientSecret: "sec" });

  const { patch } = buildMergePatch(snapshot as any, draft);
  const channels = patch.channels as any;
  assert.equal(channels["dingtalk-connector"].enabled, true);
  assert.equal(channels["dingtalk-connector"].gatewayToken, null, "剥离字段以 null 删除进 patch");
  assert.equal(channels["dingtalk-connector"].sessionTimeout, null);
  assert.equal((patch.gateway as any).auth.mode, "token", "gateway 补齐进 patch");
  assert.equal((patch.gateway as any).auth.token, undefined, "token 未变不进 patch");
  assert.equal((patch.plugins as any).entries.qqbot.enabled, true);
  assert.equal((patch.plugins as any).entries["dingtalk-connector"].enabled, true);
  assert.equal((patch.plugins as any).entries["wecom-openclaw-plugin"].enabled, true);
  assert.deepEqual(
    (patch.plugins as any).allow,
    ["kimi-search", "dingtalk-connector", "qqbot"],
    "数组追加以完整数组进 patch（字符串数组追加无需 replacePaths）",
  );
  assert.deepEqual(
    channels.wecom,
    { enabled: true, dmPolicy: "open", groupPolicy: "open", groupAllowFrom: [] },
    "wecom 仅变更/新增字段进 patch（botId/secret/allowFrom 未变不进）",
  );
}

function main() {
  testNormalizeAllowFromEntries();
  testSyncPluginAllowOnEnable();
  testFeishuExtract();
  testFeishuSaveRejectsInvalidGroupId();
  testFeishuSaveWildcardAndLegacyCleanup();
  testFeishuSavePairingAndDmScope();
  testFeishuSaveDisableOnly();
  testQqbotExtract();
  testQqbotSaveEnable();
  testQqbotSaveKeepsExistingAllowFrom();
  testQqbotSaveDisableKeepsCredentials();
  testDingtalkExtract();
  testDingtalkSaveStripsDeprecatedAndFillsGateway();
  testDingtalkSaveKeepsExistingTokenAndEndpointFlags();
  testDingtalkSaveDisableStripsToo();
  testWecomExtract();
  testWecomSaveOpenWritesWildcard();
  testWecomSavePairingPreservesAllowFrom();
  testWecomSaveDisableKeepsCredentials();
  testWeixinSave();
  testKimiSearchExtract();
  testKimiSearchSave();
  testMemoryExtract();
  testMemorySaveEmbeddingOn();
  testMemorySaveEmbeddingOnWithoutPort();
  testMemorySaveEmbeddingOff();
  testAdvancedExtractDefaults();
  testAdvancedExtractApproveAll();
  testAdvancedSave();
  testAdvancedSaveInvalidValues();
  testMergePatchIntegration();
  console.log("tab-channels lib tests passed");
}

main();
