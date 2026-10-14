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
  } else {
    manifest.version = 3; // schema v3：pins 多哈希数组 + extension 块
    manifest.updatedAt = new Date().toISOString();
  }
  // 无论 pins 是否变化都继续检查扩展（扩展更新独立提交，不依赖二进制变化）
  const extChanged = await refreshExtensionBlock(manifest);

  if (!changed && !extChanged) return;
  if (!manifest.updatedAt || changed || extChanged) {
    manifest.version = 3;
    manifest.updatedAt = new Date().toISOString();
  }
  const out = JSON.stringify(manifest, null, 2) + "\n";
  if (dryRun) {
    process.stdout.write(`[refresh-pins] --dry-run：以下清单将被写入 ${PINS_FILE}\n${out}`);
    return;
  }
  writeFileSync(PINS_FILE, out, "utf-8");
  process.stdout.write(`[refresh-pins] 已写入 ${PINS_FILE}（updatedAt=${manifest.updatedAt}）\n`);
}

// ═══════════════════════════════════════════════════════════════════
// schema v3：浏览器扩展（Chrome Web Store → 仓库镜像）
// ═══════════════════════════════════════════════════════════════════
//
// 扩展在客户端走 external_crx 离线协议安装（clients2.google.com 在中国大陆
// 不可达），自身永不更新。本函数在 CI（GitHub runner 可访问 CWS）查询
// update2 端点拿最新版本与 codebase URL，发现新版时下载 CRX、镜像进
// resources/webbridge/extension/ 并把 {id, version, file, sha256[]} 写进清单
// extension 块。客户端经 jsDelivr/raw 拉清单 + CRX，无需访问 Google。

const CWS_UPDATE2_URL =
  "https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=130.0&acceptformat=crx3&x=id%3D{ID}%26uc";
const EXTENSION_ID = "fldmhceldgbpfpkbgopacenieobmligc"; // 与 resources/webbridge/kimi-webbridge.json 一致
const EXT_MIRROR_DIR = join(REPO_ROOT, "resources", "webbridge", "extension");
const EXT_MIRROR_REL_PREFIX = "resources/webbridge/extension/";
const MAX_EXT_SHA_HISTORY = 5; // 与 pins 多哈希同语义（jsDelivr 缓存窗口期旧 CRX 仍可被拉到）
const CRX_DOWNLOAD_TIMEOUT_MS = 120_000;

function compareVersions(a, b) {
  const pa = String(a).split(".").map((s) => parseInt(s, 10) || 0);
  const pb = String(b).split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function queryChromeWebStoreVersion(extId) {
  const url = CWS_UPDATE2_URL.replace("{ID}", extId);
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`CWS update2 HTTP ${res.status}`);
  const xml = await res.text();
  // <updatecheck status="ok" codebase="https://...crx" version="1.9.0"/>
  const m = xml.match(/<updatecheck\b[^>]*\bcodebase="([^"]+)"[^>]*\bversion="([^"]+)"/)
    ?? xml.match(/<updatecheck\b[^>]*\bversion="([^"]+)"[^>]*\bcodebase="([^"]+)"/);
  if (!m) {
    if (xml.includes('status="noupdate"')) return null;
    throw new Error(`CWS update2 响应无法解析: ${xml.slice(0, 200)}`);
  }
  // 两种属性顺序的捕获组位置不同，按内容区分（codebase 含 ://）
  return m[1].includes("://") ? { codebase: m[1], version: m[2] } : { codebase: m[2], version: m[1] };
}

async function refreshExtensionBlock(manifest) {
  const log = (msg) => process.stdout.write(`[refresh-ext] ${msg}\n`);
  let latest;
  try {
    latest = await queryChromeWebStoreVersion(EXTENSION_ID);
  } catch (err) {
    // CWS 不可达（ runner 网络抖动）不应让 pins 轮转整体失败
    log(`CWS 查询失败（跳过扩展刷新，pins 部分不受影响）: ${err.message}`);
    return false;
  }
  if (!latest) {
    log("CWS 返回 noupdate");
    return false;
  }
  const current = manifest.extension?.version ?? null;
  log(`CWS 最新 ${latest.version}，清单当前 ${current ?? "(无)"}`);
  if (current && compareVersions(latest.version, current) <= 0) {
    return false;
  }

  // 新版：下载 CRX → sha256 → 镜像进仓库
  const res = await fetch(latest.codebase, {
    redirect: "follow",
    signal: AbortSignal.timeout(CRX_DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CRX 下载失败 HTTP ${res.status} — ${latest.codebase}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.toString("latin1", 0, 4) !== "Cr24") {
    throw new Error("下载产物不是 CRX（magic 不匹配）");
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  const fileName = `kimi-webbridge-${latest.version}.crx`;
  const relFile = `${EXT_MIRROR_REL_PREFIX}${fileName}`;
  if (!dryRun) {
    const { mkdirSync, writeFileSync: wf } = await import("node:fs");
    mkdirSync(EXT_MIRROR_DIR, { recursive: true });
    wf(join(EXT_MIRROR_DIR, fileName), buf);
  }
  const prevSha = Array.isArray(manifest.extension?.sha256)
    ? manifest.extension.sha256.filter((h) => typeof h === "string" && HEX64.test(h))
    : [];
  manifest.extension = {
    id: EXTENSION_ID,
    version: latest.version,
    file: relFile,
    sha256: [sha, ...prevSha.filter((h) => h !== sha)].slice(0, MAX_EXT_SHA_HISTORY),
  };
  log(`扩展镜像已更新: ${current ?? "(无)"} → ${latest.version}（sha256=${sha.slice(0, 12)}…, ${(buf.length / 1024).toFixed(0)}KB）`);
  return true;
}

main().catch((err) => {
  process.stderr.write(`[refresh-pins] 失败: ${err.message}\n`);
  process.exitCode = 1;
});
