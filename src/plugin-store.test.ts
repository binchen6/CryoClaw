// plugin-store.test.ts — R91 新增纯函数的单元测试（node:test，无 IO）：
//   - stripAnsiCodes / parseUpdateOutcomes：内核 `plugins update` 人类可读输出解析
//     （R93 增补 `Failed to check` 行与 comparePluginVersions）
//   - extractJsonPayload：`plugins inspect --json` 混警告行时的 JSON 提取
//   - mergeMarketResults：market-browse 多路搜索结果的去重合并与分类标注
//   - isValidPluginName / validateSkillSlug：handler 咽喉点的参数校验
// handler 的 IPC 接线（assertTrustedIpcSender）由 ipc-sender-guard.test.ts 覆盖，
// 这里只钉纯逻辑，保证 node --test 下可无 Electron 运行时运行。
import test from "node:test";
import { parseSlugMatches } from "./skill-store";
import assert from "node:assert/strict";
import {
  stripAnsiCodes,
  parseUpdateOutcomes,
  extractJsonPayload,
  mergeMarketResults,
  isValidPluginName,
  comparePluginVersions,
  classifyUpdateFailure,
  PLUGIN_MARKET_CATEGORY_KEYWORDS,
  INSTALL_POLICY_ACK_FLAG,
  LEGACY_INSTALL_POLICY_ACK_FLAG,
  pluginInstallArgs,
  stripAcknowledgeFlags,
  shouldRetryWithoutAck,
  nextAckFallbackArgs,
  isExecTimeoutFailure,
  runUpdateCheckTimeoutHttpFallback,
} from "./plugin-store.ts";
import { validateSkillSlug } from "./skill-store.ts";

// ── stripAnsiCodes ──────────────────────────────────────────────────

test("stripAnsiCodes：剥掉 CSI 颜色/样式序列，保留正文", () => {
  assert.equal(stripAnsiCodes("\x1b[32mWould update\x1b[39m foo: 1.0.0 -> 1.1.0."), "Would update foo: 1.0.0 -> 1.1.0.");
  // 带参数的形态（粗体 1;31）与行清除序列（2K）也要剥掉，序列后正文保留
  assert.equal(stripAnsiCodes("\x1b[1;31mA\x1b[0m\x1b[2KB"), "AB");
  assert.equal(stripAnsiCodes("plain text"), "plain text");
});

// ── parseUpdateOutcomes ─────────────────────────────────────────────

test("parseUpdateOutcomes：dry-run 有更新（含 ANSI 色码 + 混入 up-to-date 行）", () => {
  const out = [
    "Checking updates for 3 tracked plugins...",
    "\x1b[32mWould update kimi-weixin-channel: 0.9.0 -> 0.10.0.\x1b[39m",
    "\x1b[33mWould downgrade risky-plugin: 2.0.0 -> 1.9.0.\x1b[39m",
    "stable-plugin is up to date (3.1.4).",
  ].join("\n");
  const res = parseUpdateOutcomes(out);
  assert.deepEqual(res.updatable, [
    { id: "kimi-weixin-channel", currentVersion: "0.9.0", nextVersion: "0.10.0", action: "update" },
    { id: "risky-plugin", currentVersion: "2.0.0", nextVersion: "1.9.0", action: "downgrade" },
  ]);
  assert.deepEqual(res.upToDateIds, ["stable-plugin"]);
  assert.equal(res.sawNoTracked, false);
  assert.equal(res.sawRestartHint, false);
  assert.deepEqual(res.applied, []);
});

test("parseUpdateOutcomes：hook pack 引号行可解析", () => {
  const res = parseUpdateOutcomes('Would update hook pack "my-hook-pack": 0.1.0 -> 0.2.0.');
  assert.deepEqual(res.updatable, [
    { id: "my-hook-pack", currentVersion: "0.1.0", nextVersion: "0.2.0", action: "update" },
  ]);
});

test("parseUpdateOutcomes：无更新（全部 up to date）→ updatable 为空但有可识别行", () => {
  const res = parseUpdateOutcomes("a is up to date (1.0.0).\nb is up to date (2.0.0).");
  assert.deepEqual(res.updatable, []);
  assert.deepEqual(res.upToDateIds, ["a", "b"]);
  assert.equal(res.sawNoTracked, false);
});

test("parseUpdateOutcomes：No tracked → 空结果非错误", () => {
  const res = parseUpdateOutcomes("No tracked plugins or hook packs to update.");
  assert.deepEqual(res.updatable, []);
  assert.deepEqual(res.upToDateIds, []);
  assert.equal(res.sawNoTracked, true);
});

test("parseUpdateOutcomes：无可识别行（如内核报错文本）→ 全空且非 No tracked", () => {
  const res = parseUpdateOutcomes("Error: registry unreachable, please check network.");
  assert.deepEqual(res.updatable, []);
  assert.deepEqual(res.upToDateIds, []);
  assert.equal(res.sawNoTracked, false);
});

test("parseUpdateOutcomes：实际更新行 + Restart 提示（update handler 的 needsRestart 探测）", () => {
  const out = [
    "\x1b[32mUpdated kimi-weixin-channel: 0.9.0 -> 0.10.0.\x1b[39m",
    "Downgraded risky-plugin: 2.0.0 -> 1.9.0.",
    "Restart the gateway to load plugins and hooks.",
  ].join("\n");
  const res = parseUpdateOutcomes(out);
  assert.deepEqual(res.applied, [
    { id: "kimi-weixin-channel", currentVersion: "0.9.0", nextVersion: "0.10.0", action: "update" },
    { id: "risky-plugin", currentVersion: "2.0.0", nextVersion: "1.9.0", action: "downgrade" },
  ]);
  // appliedLines 是去 ANSI 后的原始行文本，update handler 用它拼 message
  assert.deepEqual(res.appliedLines, [
    "Updated kimi-weixin-channel: 0.9.0 -> 0.10.0.",
    "Downgraded risky-plugin: 2.0.0 -> 1.9.0.",
  ]);
  assert.equal(res.sawRestartHint, true);
  // 实际执行行不应混进 dry-run 的 updatable 结果
  assert.deepEqual(res.updatable, []);
});

test("parseUpdateOutcomes：CRLF 换行与行首尾空白容忍", () => {
  const res = parseUpdateOutcomes("  Would update foo: 1.0.0 -> 1.1.0.\r\n");
  assert.deepEqual(res.updatable, [
    { id: "foo", currentVersion: "1.0.0", nextVersion: "1.1.0", action: "update" },
  ]);
});

// ── parseUpdateOutcomes：Failed to check 行（R93，ClawHub 不可达时内核逐插件报告）──

test("parseUpdateOutcomes：Failed to check 行解析出 failed 清单（真实 undici 超时串）", () => {
  const out = [
    "Checking updates for 3 tracked plugins...",
    "Failed to check holo-wechat-mp: fetch failed | Connect Timeout Error (attempted address: clawhub.ai:443, timeout: 10000ms) | UND_ERR_CONNECT_TIMEOUT (ClawHub clawhub:holo-wechat-mp).",
    'Failed to check hook pack "my-hook-pack": request timeout.',
  ].join("\n");
  const res = parseUpdateOutcomes(out);
  assert.deepEqual(res.failed, [
    {
      id: "holo-wechat-mp",
      reason: "fetch failed | Connect Timeout Error (attempted address: clawhub.ai:443, timeout: 10000ms) | UND_ERR_CONNECT_TIMEOUT (ClawHub clawhub:holo-wechat-mp)",
    },
    { id: "my-hook-pack", reason: "request timeout" },
  ]);
  // failed 行不混进 updatable / upToDateIds
  assert.deepEqual(res.updatable, []);
  assert.deepEqual(res.upToDateIds, []);
  assert.equal(res.sawNoTracked, false);
});

test("parseUpdateOutcomes：Failed 行与 Would update 行混合（部分插件检查成功）", () => {
  const res = parseUpdateOutcomes(
    "Would update tavily: 1.0.0 -> 1.1.0.\nFailed to check holo-wechat-mp: fetch failed.",
  );
  assert.deepEqual(res.updatable, [
    { id: "tavily", currentVersion: "1.0.0", nextVersion: "1.1.0", action: "update" },
  ]);
  assert.deepEqual(res.failed, [{ id: "holo-wechat-mp", reason: "fetch failed" }]);
});

// ── comparePluginVersions（R93：HTTP 回退的版本比对）──

test("comparePluginVersions：数字段数值比较 + 段数不等 + 预发布段", () => {
  assert.ok(comparePluginVersions("1.10.0", "1.9.0") > 0, "1.10.0 > 1.9.0（数值而非字典序）");
  assert.ok(comparePluginVersions("1.0.0", "1.0.0") === 0);
  assert.ok(comparePluginVersions("0.9", "0.9.1") < 0, "纯数字额外段：段多者更高");
  assert.ok(comparePluginVersions("2.0.0-beta.1", "2.0.0-beta.2") < 0);
  assert.ok(comparePluginVersions("2026.9.3", "2026.10.0") < 0);
  // R93 审查修复：预发布 < 正式版（semver 语义，此前 localeCompare 会反转）
  assert.ok(comparePluginVersions("1.0.0-rc1", "1.0.0") < 0, "预发布低于正式版");
  assert.ok(comparePluginVersions("1.0.0", "1.0.0-rc1") > 0);
  assert.ok(comparePluginVersions("1.0.0-beta", "1.0.0-alpha.2") > 0, "预发布标识按码点序");
});

// ── extractJsonPayload ──────────────────────────────────────────────

test("extractJsonPayload：JSON 前混有警告行时取 {..} 子串解析", () => {
  const out = 'warn: experimental plugin registry in use\n{"id":"foo","capabilities":["x"]}';
  assert.deepEqual(extractJsonPayload(out), { id: "foo", capabilities: ["x"] });
});

test("extractJsonPayload：ANSI 色码混在 JSON 边界外/内都能剥掉", () => {
  const out = '\x1b[90mwarn: something\x1b[39m\n{"ok":\x1b[32mtrue\x1b[39m}';
  assert.deepEqual(extractJsonPayload(out), { ok: true });
});

test("extractJsonPayload：无 JSON 边界或截断（缺 `}`）→ 抛未找到错误", () => {
  assert.throws(() => extractJsonPayload("no json here"), /未找到 JSON/);
  // 缺右边界：第一个 { 存在但最后一个 } 不存在，同样归入未找到
  assert.throws(() => extractJsonPayload('warn\n{"id": "foo"'), /未找到 JSON/);
});

test("extractJsonPayload：边界齐全但内容非法 → 抛解析失败并带原因", () => {
  assert.throws(() => extractJsonPayload('warn\n{"id": "foo",}'), /JSON 载荷解析失败/);
});

// ── mergeMarketResults ──────────────────────────────────────────────

test("mergeMarketResults：按 name 去重，保留 score 更高者，categories 取并集去重", () => {
  const merged = mergeMarketResults([
    // 同一分类的两个关键词（channel/connector）+ 两个 family 都命中同一包
    { category: "channel", items: [{ name: "wechat-channel", score: 3, summary: "low score copy" }] },
    { category: "channel", items: [{ name: "wechat-channel", score: 9, summary: "high score copy", latestVersion: "1.2.0" }] },
    { category: "tool", items: [{ name: "wechat-channel", score: 5 }] },
    { category: "tool", items: [{ name: "cron-runner", score: 7 }] },
  ]);
  assert.equal(merged.length, 2);
  // score 更高者的字段胜出；categories 是命中分类的并集（channel 在前，去重）
  const wechat = merged.find((i) => i.name === "wechat-channel");
  assert.ok(wechat);
  assert.equal(wechat.summary, "high score copy");
  assert.equal(wechat.latestVersion, "1.2.0");
  assert.deepEqual(wechat.categories, ["channel", "tool"]);
  // 按 score 降序
  assert.equal(merged[0].name, "wechat-channel");
  assert.equal(merged[1].name, "cron-runner");
});

test("mergeMarketResults：无 score 条目不炸（CLI 回退路径），同名后到无分数不覆盖", () => {
  const merged = mergeMarketResults([
    { category: "provider", items: [{ name: "llm-provider" }] },
    { category: "memory", items: [{ name: "llm-provider" }] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].categories, ["provider", "memory"]);
});

test("mergeMarketResults：score 并列时按 name 升序，输出稳定", () => {
  const merged = mergeMarketResults([
    { category: "tool", items: [{ name: "b-tool", score: 5 }, { name: "a-tool", score: 5 }] },
  ]);
  assert.deepEqual(merged.map((i) => i.name), ["a-tool", "b-tool"]);
});

// ── 分类关键词契约 ──────────────────────────────────────────────────

test("PLUGIN_MARKET_CATEGORY_KEYWORDS：7 个分类，每类恰好 2 个代表关键词", () => {
  const keys = Object.keys(PLUGIN_MARKET_CATEGORY_KEYWORDS);
  assert.deepEqual(keys.sort(), ["channel", "memory", "provider", "search", "security", "tool", "voice"]);
  for (const [category, keywords] of Object.entries(PLUGIN_MARKET_CATEGORY_KEYWORDS)) {
    assert.equal(keywords.length, 2, `${category} 应有 2 个关键词`);
    for (const kw of keywords) assert.match(kw, /^[a-z]+$/, `${category} 的关键词应是简单小写词`);
  }
});

// ── 参数校验（handler 咽喉点）──────────────────────────────────────

test("isValidPluginName：拒绝 flag 注入 / 路径穿越 / 空值，接受常规 id 与 @scope 包名", () => {
  assert.equal(isValidPluginName("--all"), false);
  assert.equal(isValidPluginName("-x"), false);
  assert.equal(isValidPluginName("../evil"), false);
  assert.equal(isValidPluginName(""), false);
  assert.equal(isValidPluginName("kimi-weixin-channel"), true);
  assert.equal(isValidPluginName("@kimi/channel-plugin"), true);
});

test("validateSkillSlug：拒绝空 / flag 开头 / 非法字符，接受常规 slug", () => {
  assert.equal(validateSkillSlug("").ok, false);
  assert.equal(validateSkillSlug("--registry=evil").ok, false);
  assert.equal(validateSkillSlug("../etc/passwd").ok, false);
  assert.equal(validateSkillSlug("has space").ok, false);
  assert.equal(validateSkillSlug("web-search.v2").ok, true);
  assert.equal(validateSkillSlug("memory-dreams").ok, true);
});


test("parseSlugMatches：解析 AMBIGUOUS_SKILL_SLUG 的候选作者", () => {
  const body = JSON.stringify({ code: "AMBIGUOUS_SKILL_SLUG", matches: [
    { ownerHandle: "steipete", slug: "sonoscli" },
    { ownerHandle: "other", slug: "sonoscli" },
  ]});
  assert.deepEqual(parseSlugMatches(body), ["steipete", "other"]);
});

test("parseSlugMatches：非歧义 body / 坏 JSON / 空输入返回空", () => {
  assert.deepEqual(parseSlugMatches(JSON.stringify({ code: "OTHER" })), []);
  assert.deepEqual(parseSlugMatches("not json"), []);
  assert.deepEqual(parseSlugMatches(undefined), []);
});

// ── T2 classifyUpdateFailure ─────────────────────────────────────────

test("classifyUpdateFailure：分档翻译且永不裸漏 Command failed", () => {
  const cases: Array<[string, { combined: string; exitCode: number | string | null; timedOut?: boolean }, string]> = [
    ["超时", { combined: "", exitCode: "ETIMEDOUT", timedOut: true }, "超时"],
    ["安装策略", { combined: "install policy warning requires acknowledgement", exitCode: 1 }, "安装策略"],
    ["配置校验", { combined: "Error: invalid config at plugins.entries", exitCode: 1 }, "配置校验"],
    ["blocked", { combined: "blocked by mutation preflight", exitCode: 1 }, "拦截"],
    ["网络(Failed 行)", { combined: "Failed to check foo: fetch failed | Connect Timeout Error", exitCode: 1 }, "ClawHub"],
    ["网络(undici)", { combined: "TypeError: fetch failed\ncause: UND_ERR_CONNECT_TIMEOUT", exitCode: 1 }, "ClawHub"],
  ];
  for (const [label, input, expectIncludes] of cases) {
    const msg = classifyUpdateFailure(input);
    assert.ok(msg.includes(expectIncludes), `${label} 档位文案应含「${expectIncludes}」: ${msg}`);
    assert.ok(!msg.includes("Command failed"), `${label} 不得裸漏 Node 原文`);
  }
});

test("classifyUpdateFailure：通用兜底带退出码与首行有意义 stderr", () => {
  const msg = classifyUpdateFailure({
    combined: "(node:12) DeprecationWarning: xx\nSome unknown kernel error line\n",
    exitCode: 3,
  });
  assert.ok(msg.includes("退出码 3"), msg);
  assert.ok(msg.includes("Some unknown kernel error line"), msg);
  assert.ok(!msg.includes("Command failed"), msg);
  const empty = classifyUpdateFailure({ combined: "", exitCode: 1 });
  assert.ok(empty.includes("无错误输出"), empty);
});

// ── ack 旗标契约与旧内核回退（install/update 共用）──────────────────

test("pluginInstallArgs：用 --acknowledge-install-policy-warning，不含已废弃的 --acknowledge-clawhub-risk", () => {
  const args = pluginInstallArgs("@kimi/foo");
  assert.deepEqual(args, ["plugins", "install", "clawhub:@kimi/foo", "--acknowledge-install-policy-warning", "--force"]);
  assert.ok(args.includes(INSTALL_POLICY_ACK_FLAG));
  assert.ok(!args.includes("--acknowledge-clawhub-risk"));
});

test("ack 回退：「不识别选项」失败且参数带 ack 旗标时才重试，重试参数剥掉旗标", () => {
  const unrecognized = {
    message: 'OpenClaw does not recognize option "--acknowledge-install-policy-warning"',
    stderr: 'OpenClaw does not recognize option "--acknowledge-install-policy-warning"',
  };
  const args = ["plugins", "update", "--all", INSTALL_POLICY_ACK_FLAG];
  assert.equal(shouldRetryWithoutAck(args, unrecognized), true);
  assert.deepEqual(stripAcknowledgeFlags(args), ["plugins", "update", "--all"]);
  // commander 风格文案也认
  assert.equal(shouldRetryWithoutAck(args, { message: "", stderr: "error: unknown option '--acknowledge-install-policy-warning'" }), true);
  // 无 ack 旗标 → 不重试（剥无可剥）
  assert.equal(shouldRetryWithoutAck(["plugins", "list", "--json"], unrecognized), false);
  // 非「不识别选项」失败（如网络错误）→ 不重试，原样抛出
  assert.equal(shouldRetryWithoutAck(args, { message: "fetch failed", stderr: "UND_ERR_CONNECT_TIMEOUT" }), false);
});

test("ack 降级链：新旗标 → 旧旗标 → 无旗标，逐级降级而非一次剥光", () => {
  const args = ["plugins", "install", "clawhub:@kimi/foo", INSTALL_POLICY_ACK_FLAG, "--force"];
  // 第一档：新旗标不认识 → 换旧旗标（2026.7.x 内核需要旧旗标做免交互确认，
  // 直接剥光会撞上 install policy warning 失败）
  const legacy = nextAckFallbackArgs(args);
  assert.deepEqual(legacy, ["plugins", "install", "clawhub:@kimi/foo", LEGACY_INSTALL_POLICY_ACK_FLAG, "--force"]);
  // 第二档：旧旗标也不认识 → 剥光 ack 旗标
  const stripped = nextAckFallbackArgs(legacy!);
  assert.deepEqual(stripped, ["plugins", "install", "clawhub:@kimi/foo", "--force"]);
  // 末档：无 ack 旗标 → 无可降级（null），原错误抛出
  assert.equal(nextAckFallbackArgs(stripped!), null);
  assert.equal(nextAckFallbackArgs(["plugins", "list", "--json"]), null);
});

// ── 超时预算与超时回退 ─────────────────────────────────────────────

test("classifyUpdateFailure：超时文案用实际秒数（不再硬编码 90s），含网络/代理建议", () => {
  const msg = classifyUpdateFailure({ combined: "", exitCode: "ETIMEDOUT", timedOut: true });
  assert.ok(!msg.includes("90s"), msg);
  assert.ok(msg.includes("180s"), msg);
  assert.ok(msg.includes("代理"), msg);
  assert.ok(msg.includes("重试"), msg);
  // 显式传入的预算优先
  const custom = classifyUpdateFailure({ combined: "", exitCode: "ETIMEDOUT", timedOut: true, timeoutSeconds: 45 });
  assert.ok(custom.includes("45s"), custom);
  assert.ok(!custom.includes("180s"), custom);
});

test("isExecTimeoutFailure：killed 或 code=ETIMEDOUT 判为超时", () => {
  assert.equal(isExecTimeoutFailure({ killed: true }), true);
  assert.equal(isExecTimeoutFailure({ code: "ETIMEDOUT" }), true);
  assert.equal(isExecTimeoutFailure({ code: 1 }), false);
  assert.equal(isExecTimeoutFailure({ killed: false, code: 1 }), false);
  assert.equal(isExecTimeoutFailure(null), false);
  assert.equal(isExecTimeoutFailure(undefined), false);
});

test("runUpdateCheckTimeoutHttpFallback：缓存热时走 HTTP 回退，回退全灭/无缓存返回 null", async () => {
  const cached = [
    { id: "foo", name: "foo", enabled: true },
    { id: "bar", name: "bar", enabled: true },
  ];
  const res = await runUpdateCheckTimeoutHttpFallback(cached, async (ids) => {
    assert.deepEqual(ids, ["foo", "bar"]);
    return {
      updatable: [{ id: "foo", currentVersion: "1.0.0", nextVersion: "1.1.0", action: "update" as const }],
      stillFailed: [{ id: "bar", reason: "HTTP 404" }],
      upToDateIds: [],
    };
  });
  assert.ok(res);
  assert.deepEqual(res.updatable, [{ id: "foo", currentVersion: "1.0.0", nextVersion: "1.1.0", action: "update" }]);
  assert.deepEqual(res.failed, ["bar"]);

  // 回退逐 id 全失败（无任何成功信号）→ null，让 handler 回落到超时错误文案
  const allFailed = await runUpdateCheckTimeoutHttpFallback(cached, async () => ({
    updatable: [],
    stillFailed: [{ id: "foo", reason: "fetch failed" }],
    upToDateIds: [],
  }));
  assert.equal(allFailed, null);

  // 回退函数本身抛错 → null（不向上炸，由 handler 报超时）
  const threw = await runUpdateCheckTimeoutHttpFallback(cached, async () => {
    throw new Error("boom");
  });
  assert.equal(threw, null);

  // 缓存冷/为空 → null，且不应发起 HTTP 检查
  const mustNotCall = async (): Promise<never> => {
    throw new Error("should not be called");
  };
  assert.equal(await runUpdateCheckTimeoutHttpFallback(null, mustNotCall), null);
  assert.equal(await runUpdateCheckTimeoutHttpFallback([], mustNotCall), null);
});
