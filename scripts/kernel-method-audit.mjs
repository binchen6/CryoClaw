/**
 * 内核 RPC 面审计：对比「仓库实际调用的 gateway 方法/事件」与「gateway.asar 内核注册面」。
 * 背景：2026.9.7 内核移除 tasks.* 等接口时仅靠运行时报错发现（见 docs/archive/2026-10-04-nine-fixes-research.md T1/T7）。
 * 用法：
 *   node scripts/kernel-method-audit.mjs                 # 打印 gap 表（与基线对比，仅提示）
 *   node scripts/kernel-method-audit.mjs --write-baseline # 用当前 gap 覆盖基线（人工 review 后提交）
 * CI 门：scripts/kernel-method-audit.test.mjs —— 出现基线未登记的 gap 即失败。
 * 基线中 status 取值：gated（调用点已有能力门控）/ fallback（调用点 try-catch 探测回退）/ pending-gate（待门控）。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ASAR_PATH = path.join(REPO_ROOT, "resources", "targets", "win32-x64", "gateway.asar");
export const BASELINE_PATH = path.join(REPO_ROOT, "docs", "kernel-recon", "rpc-baseline.json");

const SCAN_DIRS = [
  path.join(REPO_ROOT, "chat-ui", "ui", "src"),
  path.join(REPO_ROOT, "src"),
];
const SCAN_EXT = new Set([".ts", ".tsx", ".mjs", ".js"]);
// 方法名形态：至少一段点分（gateway RPC 均为 dot 形式），排除 fetch/request 的误报
const METHOD_NAME_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i;
// 调用点：client.request("x.y" / client.request<T>("x.y"
const REQUEST_CALL_RE = /request(?:<[^>]*>)?\(\s*["']([a-zA-Z0-9_.]+)["']/g;
// 事件订阅/分发点：evt.event === "x" / msg.event === "x"
const EVENT_USE_RE = /\.event\s*===\s*["']([a-zA-Z0-9_.]+)["']/g;

const MIN_METHOD_COUNT = 300;

function listFilesRecursive(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".test-dist") continue;
      listFilesRecursive(full, out);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name)) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

function findDistFile(header, prefix) {
  const dist = header?.files?.["node_modules"]?.files?.["openclaw"]?.files?.["dist"]?.files;
  if (!dist) throw new Error("kernel-method-audit: asar 头中未找到 node_modules/openclaw/dist");
  const key = Object.keys(dist).find((k) => k.startsWith(prefix));
  if (!key) throw new Error(`kernel-method-audit: asar 中未找到 ${prefix}* 文件（内核改名？）`);
  return key;
}

/** 解析内核注册面：methods（RPC 方法表首元素）+ events（GATEWAY_EVENTS）。 */
export function collectKernelSurface(asarPath = DEFAULT_ASAR_PATH) {
  const { header } = asar.getRawHeader(asarPath);
  const read = (key) => asar.extractFile(asarPath, path.join("node_modules", "openclaw", "dist", key)).toString("utf8");

  const policy = read(findDistFile(header, "core-method-policy"));
  const methods = new Set();
  for (const m of policy.matchAll(/^\t\[\n\t\t"([a-zA-Z0-9_.]+)",/gm)) methods.add(m[1]);
  if (methods.size < MIN_METHOD_COUNT) {
    throw new Error(`kernel-method-audit: 方法表仅解析到 ${methods.size} 项（<${MIN_METHOD_COUNT}），内核产物格式可能已变，拒绝静默通过`);
  }

  const listSrc = read(findDistFile(header, "server-methods-list"));
  const start = listSrc.indexOf("GATEWAY_EVENTS = [");
  if (start < 0) throw new Error("kernel-method-audit: 未找到 GATEWAY_EVENTS 定义");
  const end = listSrc.indexOf("];", start);
  const events = new Set();
  for (const m of listSrc.slice(start, end).matchAll(/"([a-zA-Z0-9_.]+)"/g)) events.add(m[1]);
  if (events.size < 10) throw new Error(`kernel-method-audit: 事件表仅解析到 ${events.size} 项，拒绝静默通过`);

  const version = (() => {
    try {
      const pkg = JSON.parse(asar.extractFile(asarPath, path.join("node_modules", "openclaw", "package.json")).toString("utf8"));
      return pkg.version;
    } catch {
      return "unknown";
    }
  })();
  return { methods, events, version };
}

/** 扫描仓库调用点，返回 { methods: Map<name, files[]>, events: Map<name, files[]> }。 */
export function scanUsages(dirs = SCAN_DIRS) {
  const methods = new Map();
  const events = new Map();
  for (const dir of dirs) {
    for (const file of listFilesRecursive(dir)) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      for (const m of src.matchAll(REQUEST_CALL_RE)) {
        if (!METHOD_NAME_RE.test(m[1])) continue;
        if (!methods.has(m[1])) methods.set(m[1], []);
        methods.get(m[1]).push(rel);
      }
      for (const m of src.matchAll(EVENT_USE_RE)) {
        if (!events.has(m[1])) events.set(m[1], []);
        events.get(m[1]).push(rel);
      }
    }
  }
  return { methods, events };
}

/** gap = 仓库调用但内核未注册。返回 { methods: {name: files[]}, events: {name: files[]} }。 */
export function computeGaps(surface, usages) {
  const gaps = { methods: {}, events: {} };
  for (const [name, files] of usages.methods) {
    if (!surface.methods.has(name)) gaps.methods[name] = files;
  }
  for (const [name, files] of usages.events) {
    if (!surface.events.has(name)) gaps.events[name] = files;
  }
  return gaps;
}

export function loadBaseline(p = BASELINE_PATH) {
  if (!fs.existsSync(p)) return { kernelVersion: null, methods: {}, events: {} };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeBaseline(gaps, surface, p = BASELINE_PATH) {
  const prev = loadBaseline(p);
  const next = {
    kernelVersion: surface.version,
    generatedBy: "scripts/kernel-method-audit.mjs --write-baseline",
    methods: {},
    events: {},
  };
  for (const name of Object.keys(gaps.methods).sort()) {
    next.methods[name] = prev.methods?.[name] ?? { status: "pending-gate", note: "待人工确认门控/回退方式", files: gaps.methods[name] };
  }
  for (const name of Object.keys(gaps.events).sort()) {
    next.events[name] = prev.events?.[name] ?? { status: "pending-gate", note: "待人工确认门控/回退方式", files: gaps.events[name] };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function runAudit(opts = {}) {
  const surface = collectKernelSurface(opts.asarPath);
  const usages = scanUsages(opts.dirs);
  const gaps = computeGaps(surface, usages);
  return { surface, usages, gaps, baseline: loadBaseline(opts.baselinePath) };
}

function main() {
  const write = process.argv.includes("--write-baseline");
  const { surface, gaps, baseline } = runAudit();
  console.log(`内核版本: ${surface.version} | 注册方法 ${surface.methods.size} | 广播事件 ${surface.events.size}`);
  const unknown = [];
  for (const [name, files] of Object.entries(gaps.methods)) {
    const entry = baseline.methods?.[name];
    if (!entry) unknown.push(`method ${name}`);
    console.log(`[method gap] ${name} :: ${entry ? `${entry.status} (${entry.note ?? ""})` : "未登记!"} :: ${files.join(", ")}`);
  }
  for (const [name, files] of Object.entries(gaps.events)) {
    const entry = baseline.events?.[name];
    if (!entry) unknown.push(`event ${name}`);
    console.log(`[event gap] ${name} :: ${entry ? `${entry.status} (${entry.note ?? ""})` : "未登记!"} :: ${files.join(", ")}`);
  }
  if (write) {
    writeBaseline(gaps, surface);
    console.log(`基线已更新: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
  } else if (unknown.length) {
    console.log(`提示: 存在未登记 gap ${unknown.length} 项（CI 将失败）: ${unknown.join(", ")}`);
  } else {
    console.log("所有 gap 均已在基线登记。");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
