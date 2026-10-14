#!/usr/bin/env node
/**
 * bump-bundled-plugins.mjs — 内置插件/运行时钉定批量升级（dry-run 默认）
 *
 * 覆盖 package.json cryoclaw.* 的 npm 钉定（openclaw/clawhub/各渠道与 provider 插件），
 * 外加两个非 npm 源：
 *   - officecli：GitHub iOfficeAI/OfficeCLI 最新 release tag；
 *   - node：nodejs.org dist index 中 24.x 最新（锁定主版本线，不跨大版本）。
 * 不覆盖（仅报告，需人工处置）：
 *   - archiveTool：自研 Rust sidecar，发布节奏独立（binchen6/CryoClaw 自有 tag）；
 *   - kimiSearch：CDN 无版本清单，版本号只能人工确认后改 pin。
 *
 * 用法：
 *   node scripts/bump-bundled-plugins.mjs           # 报告（不改文件）
 *   node scripts/bump-bundled-plugins.mjs --write   # 把 latest 写进 package.json
 *
 *  Registry 顺序与 package-resources.js 的 buildNpmEnv 一致：npmmirror 优先，
 *  npmjs 兜底（CI/海外环境）。任一源拿到版本即采纳。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_FILE = join(ROOT, "package.json");
const write = process.argv.includes("--write");

// pkgJsonKey → npm 包名（与 package-resources.js 的 BUNDLED/OFFICIAL_VENDOR 清单一一对应）
const NPM_PINS = [
  ["openclaw", "openclaw"],
  ["clawhub", "clawhub"],
  ["dingtalkConnector", "@dingtalk-real-ai/dingtalk-connector"],
  ["weixin", "@tencent-weixin/openclaw-weixin"],
  ["wecom", "@wecom/wecom-openclaw-plugin"],
  ["feishuPlugin", "@openclaw/feishu"],
  ["qqbotPlugin", "@openclaw/qqbot"],
  ["moonshotProviderPlugin", "@openclaw/moonshot-provider"],
  ["kimiProviderPlugin", "@openclaw/kimi-provider"],
  ["zaiProviderPlugin", "@openclaw/zai-provider"],
  ["qwenProviderPlugin", "@openclaw/qwen-provider"],
  ["deepseekProviderPlugin", "@openclaw/deepseek-provider"],
];

const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
const FETCH_TIMEOUT_MS = 20_000;
const NODE_MAJOR_LINE = 24; // 与 cryoclaw.node 当前主版本线对齐（跨大版本需人工评估）

async function fetchJson(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json", "User-Agent": "cryoclaw-bump-pins" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function npmLatestVersion(packageName) {
  let lastErr = null;
  for (const reg of REGISTRIES) {
    try {
      const data = await fetchJson(`${reg}/${packageName.replace("/", "%2f")}/latest`);
      if (typeof data?.version === "string" && data.version) return data.version;
      throw new Error("响应缺 version 字段");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("所有 registry 均失败");
}

async function officecliLatestTag() {
  const data = await fetchJson(
    "https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest",
  );
  const tag = typeof data?.tag_name === "string" ? data.tag_name : "";
  return tag.replace(/^v/, "") || null;
}

async function nodeLatestInLine() {
  const index = await fetchJson("https://nodejs.org/dist/index.json");
  const hit = Array.isArray(index)
    ? index.find((e) => typeof e?.version === "string" && e.version.startsWith(`v${NODE_MAJOR_LINE}.`))
    : null; // index.json 按发布时间倒序，首个命中即该线最新
  return hit ? hit.version.replace(/^v/, "") : null;
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((s) => parseInt(s, 10) || 0);
  const pb = String(b).split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function main() {
  const pkg = JSON.parse(readFileSync(PKG_FILE, "utf8"));
  const pins = pkg.cryoclaw ?? {};
  const rows = [];
  const updates = [];

  for (const [key, packageName] of NPM_PINS) {
    const current = pins[key] ?? null;
    try {
      const latest = await npmLatestVersion(packageName);
      const stale = current && compareVersions(latest, current) > 0;
      rows.push([key, packageName, current, latest, stale ? "⬆ 可升级" : "✓ 最新"]);
      if (stale) updates.push([key, latest]);
    } catch (err) {
      rows.push([key, packageName, current, "(查询失败)", err.message]);
    }
  }

  // 非 npm 源
  try {
    const latest = await officecliLatestTag();
    const current = pins.officecli ?? null;
    const stale = latest && current && compareVersions(latest, current) > 0;
    rows.push(["officecli", "github:iOfficeAI/OfficeCLI", current, latest, stale ? "⬆ 可升级" : "✓ 最新"]);
    if (stale) updates.push(["officecli", latest]);
  } catch (err) {
    rows.push(["officecli", "github:iOfficeAI/OfficeCLI", pins.officecli, "(查询失败)", err.message]);
  }
  try {
    const latest = await nodeLatestInLine();
    const current = pins.node ?? null;
    const stale = latest && current && compareVersions(latest, current) > 0;
    rows.push(["node", `nodejs.org dist (v${NODE_MAJOR_LINE}.x 线)`, current, latest, stale ? "⬆ 可升级" : "✓ 最新"]);
    if (stale) updates.push(["node", latest]);
  } catch (err) {
    rows.push(["node", "nodejs.org dist", pins.node, "(查询失败)", err.message]);
  }

  // 仅报告项
  rows.push(["archiveTool", "自研 sidecar（自有 release）", pins.archiveTool, "—", "人工处置"]);
  rows.push(["kimiSearch", "cdn.kimi.com（无版本清单）", pins.kimiSearch ?? "(硬编码于 package-resources.js)", "—", "人工处置"]);

  // 报告
  console.log(`\n内置钉定巡检（${write ? "WRITE 模式" : "dry-run，加 --write 写回 package.json"}）\n`);
  for (const [key, src, cur, lat, status] of rows) {
    console.log(`  ${String(cur ?? "—").padEnd(12)} → ${String(lat).padEnd(12)} ${status.padEnd(8)} ${key}  (${src})`);
  }

  if (updates.length === 0) {
    console.log("\n全部最新，无需变更。");
    return;
  }
  console.log(`\n待升级 ${updates.length} 项: ${updates.map(([k, v]) => `${k}→${v}`).join(", ")}`);
  if (!write) return;

  for (const [key, latest] of updates) {
    pkg.cryoclaw[key] = latest;
  }
  writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`已写回 ${PKG_FILE}`);
}

main().catch((err) => {
  console.error(`[bump] 失败: ${err.message}`);
  process.exitCode = 1;
});
