import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zhDict } from "./i18n/zh.ts";
import { enDict } from "./i18n/en.ts";

/**
 * i18n 字典防回归测试。
 *
 * 历史事故（见 docs/OPTIMIZATION-PROGRESS.md 阶段 11/12）：
 * - 插入脚本锚点错误导致 63 个英文值混进 zh 区，JS 对象后定义覆盖前定义，
 *   中文界面静默变英文；
 * - zh/en 键集合漂移（en 区缺 key 时 t() 回退显示原始 key）。
 *
 * 该测试锁定三条不变量：无重复键、zh/en 键集合一致、分区语言正确。
 * 阶段 16 拆分后：键集合/语言审计直接 import 字典对象；
 * 重复键无法通过对象发现（后者静默覆盖前者），仍对字典源码做文本扫描。
 */

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，字典源文件位于 chat-ui/ui/src/ui/i18n/
const ENTRY_RE = /^\s*"([^"]+)":\s*"(.*)",?\s*$/gm;

function extractSourceEntries(file: "zh.ts" | "en.ts"): Array<[string, string]> {
  const source = readFileSync(new URL(`../../../../src/ui/i18n/${file}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const entries: Array<[string, string]> = [];
  for (const match of source.matchAll(ENTRY_RE)) {
    entries.push([match[1], match[2]]);
  }
  return entries;
}

const zhEntries = Object.entries(zhDict);
const enEntries = Object.entries(enDict);
const zhKeys = zhEntries.map(([key]) => key);
const enKeys = enEntries.map(([key]) => key);

test("i18n：zh/en 字典非空", () => {
  assert.ok(zhEntries.length > 100, `zh 条目数异常（${zhEntries.length}）`);
  assert.ok(enEntries.length > 100, `en 条目数异常（${enEntries.length}）`);
});

// 重复键会被 JS 静默覆盖，对象本身无法暴露，必须扫描源码文本。
// 注意：跨行字符串值的首行不匹配 ENTRY_RE（与旧版行为一致），不参与重复键扫描。
function assertNoDuplicateKeys(file: "zh.ts" | "en.ts", label: string): void {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const [key] of extractSourceEntries(file)) {
    if (seen.has(key)) {
      dups.add(key);
    }
    seen.add(key);
  }
  assert.deepEqual([...dups], [], `${label} 区重复键：${[...dups].join(", ")}`);
}

test("i18n：zh 区无重复键（重复键会被静默覆盖）", () => {
  assertNoDuplicateKeys("zh.ts", "zh");
});

test("i18n：en 区无重复键", () => {
  assertNoDuplicateKeys("en.ts", "en");
});

test("i18n：zh/en 键集合完全一致", () => {
  const enSet = new Set(enKeys);
  const zhSet = new Set(zhKeys);
  const missingInEn = zhKeys.filter((key) => !enSet.has(key));
  const missingInZh = enKeys.filter((key) => !zhSet.has(key));
  assert.deepEqual(missingInEn, [], `en 区缺失键：${missingInEn.join(", ")}`);
  assert.deepEqual(missingInZh, [], `zh 区缺失键：${missingInZh.join(", ")}`);
});

const CJK_RE = /[\u4e00-\u9fff]/;

// zh 区允许纯英文的值：品牌名、产品名、技术字段标签（App ID / Client Secret 等业界通用）。
const ZH_ENGLISH_ALLOWLIST = new Set([
  "sidebar.brand",
  "settings.env.gateway",
  "settings.about.cryoclaw",
  "settings.about.openclaw",
  "settings.channels.qqbot",
  "settings.channels.feishu.appId",
  "settings.channels.feishu.appSecret",
  "settings.channels.wecom.botId",
  "settings.channels.wecom.secret",
  "settings.channels.dingtalk.clientId",
  "settings.channels.dingtalk.clientSecret",
  "settings.channels.qqbot.appId",
  "settings.channels.qqbot.clientSecret",
  "setup.provider.apiKey",
  "setup.provider.label.moonshot",
  "setup.provider.label.anthropic",
  "setup.provider.label.openai",
  "setup.provider.label.google",
  // Provider 分组标签同样是品牌名
  "settings.provider.group.moonshot",
  "settings.provider.group.anthropic",
  "settings.provider.group.openai",
  "settings.provider.group.google",
  "setup.provider.apiType.openaiCompletions",
  "setup.provider.apiType.anthropicMessages",
  "setup.provider.apiType.openaiResponses",
  "tasks.runtime.acp",
  "tasks.runtime.cli",
  // git worktree 为业界通用技术名词，zh 区保留英文（R42 第二期 T5：sidebar.worktrees 键已删，仅余 worktrees.title）
  "worktrees.title",
]);

test("i18n：zh 区值必须含中文（品牌/技术字段除外）", () => {
  const offenders = zhEntries
    .filter(([key, value]) => !CJK_RE.test(value) && !ZH_ENGLISH_ALLOWLIST.has(key))
    .map(([key, value]) => `${key} = ${value}`);
  assert.deepEqual(offenders, [], `zh 区混入英文值：\n${offenders.join("\n")}`);
});

test("i18n：en 区值不得含中文", () => {
  const offenders = enEntries
    .filter(([key, value]) => CJK_RE.test(value))
    .map(([key, value]) => `${key} = ${value}`);
  assert.deepEqual(offenders, [], `en 区混入中文值：\n${offenders.join("\n")}`);
});

test("i18n：白名单中的 key 必须真实存在（防白名单腐化）", () => {
  const zhSet = new Set(zhKeys);
  const stale = [...ZH_ENGLISH_ALLOWLIST].filter((key) => !zhSet.has(key));
  assert.deepEqual(stale, [], `白名单存在已删除的 key：${stale.join(", ")}`);
});
