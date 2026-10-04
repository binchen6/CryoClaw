// refresh-webbridge-pins.mjs — WebBridge 钉定清单轮转脚本（T8）
//
// 上游把 `https://kimi-web-img.moonshot.cn/webbridge/latest/releases/<name>`
// 当作可反复重建的发布位（同字节数、新 Go build ID），exact-hash 钉定会在
// 重建窗口期过期。本脚本下载每个被钉定的文件名、计算 sha256，并把新哈希
// **前插**进 resources/webbridge-pins.json（schema v2 多哈希数组，每文件保留
// 最近 5 枚），同时 bump `updatedAt`。
//
// 用法：
//   node scripts/refresh-webbridge-pins.mjs            # 下载并写回清单
//   node scripts/refresh-webbridge-pins.mjs --dry-run  # 只打印将发生的变更
//
// 下载 URL 逻辑与 src/webbridge.ts 保持一致：
//   `${CDN_BASE_URL}/${resolveWebbridgeVersion()}/releases/${filename}`
// 纯 node ESM（>=22，全局 fetch），无新增依赖。CI 见
// .github/workflows/refresh-webbridge-pins.yml。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINS_FILE = join(REPO_ROOT, "resources", "webbridge-pins.json");

// 与 src/webbridge.ts 的 CDN_BASE_URL / resolveWebbridgeVersion 同值
const CDN_BASE_URL = "https://kimi-web-img.moonshot.cn/webbridge";
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function resolveVersion() {
  const candidate = (process.env.KIMI_WEBBRIDGE_VERSION ?? "").trim();
  // 与主进程同口径：非法值静默回退 latest，防止环境变量注入 URL path
  return candidate && VERSION_PATTERN.test(candidate) ? candidate : "latest";
}

const MAX_PINS_PER_FILE = 5; // 与 src/webbridge-pins.ts 的读取上限一致
const HEX64 = /^[0-9a-f]{64}$/i;
const DOWNLOAD_TIMEOUT_MS = 120_000; // 二进制约 10MB，比清单拉取放宽

const dryRun = process.argv.includes("--dry-run");

function normalizeEntry(value) {
  // v1 单串 / v2 数组 → 统一成小写 hex 数组；非法项直接剔除（保守）
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((v) => typeof v === "string" && HEX64.test(v))
    .map((v) => v.toLowerCase())
    .slice(0, MAX_PINS_PER_FILE);
}

async function sha256OfUrl(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const manifest = JSON.parse(readFileSync(PINS_FILE, "utf-8"));
  if (typeof manifest?.pins !== "object" || manifest.pins === null) {
    throw new Error(`${PINS_FILE} 缺少 pins 对象`);
  }
  const filenames = Object.keys(manifest.pins);
  if (filenames.length === 0) throw new Error("pins 为空，无可轮转的文件名");

  const version = resolveVersion();
  let changed = false;
  for (const filename of filenames) {
    const url = `${CDN_BASE_URL}/${version}/releases/${filename}`;
    const current = normalizeEntry(manifest.pins[filename]);
    process.stdout.write(`[refresh-pins] ${filename} ← ${url}\n`);
    let actual;
    try {
      actual = await sha256OfUrl(url);
    } catch (err) {
      // 任一文件失败即整体失败：CI 不提交半更新的清单
      throw new Error(`下载/哈希失败（${filename}）: ${err.message}`);
    }
    if (current[0] === actual) {
      process.stdout.write(`[refresh-pins]   未变化（${actual}）\n`);
      continue;
    }
    // 前插新哈希，去重后保留最近 MAX_PINS_PER_FILE 枚（旧代产物在窗口期内仍可能被下载）
    const next = [actual, ...current.filter((h) => h !== actual)].slice(0, MAX_PINS_PER_FILE);
    process.stdout.write(`[refresh-pins]   ${current[0] ?? "(无)"} → ${actual}（保留 ${next.length} 枚）\n`);
    manifest.pins[filename] = next;
    changed = true;
  }

  if (!changed) {
    process.stdout.write("[refresh-pins] 清单无变化，跳过写入\n");
    return;
  }
  manifest.version = 2; // schema v2：pins[filename] 为多哈希数组
  manifest.updatedAt = new Date().toISOString();
  const out = JSON.stringify(manifest, null, 2) + "\n";
  if (dryRun) {
    process.stdout.write(`[refresh-pins] --dry-run：以下清单将被写入 ${PINS_FILE}\n${out}`);
    return;
  }
  writeFileSync(PINS_FILE, out, "utf-8");
  process.stdout.write(`[refresh-pins] 已写入 ${PINS_FILE}（updatedAt=${manifest.updatedAt}）\n`);
}

main().catch((err) => {
  process.stderr.write(`[refresh-pins] 失败: ${err.message}\n`);
  process.exitCode = 1;
});
